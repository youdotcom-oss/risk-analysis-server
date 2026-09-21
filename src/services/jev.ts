import { noul, score, TypeSafeClient } from '@typesafe-ai/sdk'

export type SystemOneCaller = Pick<TypeSafeClient, 'systemOne'>
export { TypeSafeClient }

export type RiskProfile = {
  title: string
  locations: string[]
  triggers: string[]
}

export function createJev(caller: SystemOneCaller = new TypeSafeClient()) {
  return caller
}

export type Jev = ReturnType<typeof createJev>

/** Jev Gate 1: P(material supply-chain threat) for a profile's surface sweep. */
export async function triageThreat(jev: Jev, profile: RiskProfile, highlights: string[]): Promise<number> {
  const result = await jev.systemOne({
    state: { profile, highlights },
    questions: {
      threat: noul(
        'Does this evidence indicate a material supply-chain threat for the profile given its policy triggers?',
      ),
    },
  })
  return result.answers.threat.noul
}

export type QueryVerdict = {
  query: string
  accepted: boolean
}
const QUERY_THRESHOLD = 0.5

// Keys are constructed by us one line above each lookup; a missing answer is a
// contract violation, so fail loudly instead of tolerating undefined.
function answerAt<A extends { noul?: number; score?: number }>(answers: Record<string, A | undefined>, key: string): A {
  const answer = answers[key]
  if (!answer) throw new Error(`TypeSafe returned no answer for ${key}`)
  return answer
}

/** Jev Gate 2: batch-validate candidate deep-dive queries in one systemOne call. */
export async function validateQueries(jev: Jev, profile: RiskProfile, queries: string[]): Promise<QueryVerdict[]> {
  const questions = Object.fromEntries(
    queries.map((query, index) => [
      `q${index}`,
      noul(
        `Would the search query "${query}" precisely surface supply-chain disruptions for ${profile.title}? ` +
          'It must contain a strict geospatial identifier and avoid broad generic keywords.',
      ),
    ]),
  )
  const result = await jev.systemOne({
    state: { profile, queries },
    questions,
  })
  return queries.map((query, index) => ({
    query,
    accepted: answerAt(result.answers as Record<string, { noul: number }>, `q${index}`).noul >= QUERY_THRESHOLD,
  }))
}

export type ScoredResult = {
  url: string
  title?: string
  snippet: string
  score: number
  /** Licensed-data provider names (knowledge facts only). */
  attribution?: string[]
  /** Data-as-of date (knowledge facts only). */
  asOf?: string
}

const RELEVANCY_RUBRIC = [
  'Not relevant to the profile or its policy triggers',
  'Marginally relevant: touches the locations or triggers, but not both',
  'Highly relevant: concrete disruption at a profile location matching a policy trigger',
] as const

/** Jev Gate 3: score search results against the profile's policy triggers. */
const PROVENANCE_BOOST = 1

export async function scoreResults(
  jev: Jev,
  profile: RiskProfile,
  results: { url: string; title?: string; snippet: string; attribution?: string[]; asOf?: string }[],
): Promise<ScoredResult[]> {
  // MINIMAL: blunt caps keep the systemOne payload within the TypeSafe
  // input limit (live runs hit 400 max_tokens_exceeded with ~100 results).
  // Upgrade path: batched scoring rounds with utility-ranked prioritization.
  const MAX_SCORED_RESULTS = 30
  const capped = results.slice(0, MAX_SCORED_RESULTS).map((result) => ({
    ...result,
    snippet: result.snippet.slice(0, 200),
  }))
  const questions = Object.fromEntries(
    capped.map((result, index) => [
      `r${index}`,
      score(
        // Knowledge facts carry licensed provenance: naming the provider and
        // data date lets Jev weigh them with their sourcing in view.
        `How relevant is the result "${result.snippet}" (from ${result.url}) to the profile?` +
          (result.attribution?.length
            ? ` This is a licensed ${result.attribution.join(', ')} data result` +
              (result.asOf ? ` as of ${result.asOf}` : '') +
              '.'
            : ''),
        RELEVANCY_RUBRIC,
      ),
    ]),
  )
  const result = await jev.systemOne({
    state: { profile, results: capped },
    questions,
  })
  return results.map((item, index) => {
    const base =
      index < capped.length ? answerAt(result.answers as Record<string, { score: number }>, `r${index}`).score : 1
    const isKnowledge = Boolean(item.attribution?.length)
    return {
      url: item.url,
      title: item.title,
      snippet: item.snippet,
      attribution: item.attribution,
      asOf: item.asOf,
      // Licensed facts get a provenance boost (capped at the rubric max):
      // authoritative data outranks equivalent web findings.
      score: isKnowledge ? Math.min(base + PROVENANCE_BOOST, RELEVANCY_RUBRIC.length - 1) : base,
    }
  })
}
