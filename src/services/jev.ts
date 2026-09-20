import { noul, score, TypeSafeClient } from '@typesafe-ai/sdk'

export type SystemOneCaller = Pick<TypeSafeClient, 'systemOne'>

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
  score: number
}

const RELEVANCY_RUBRIC = [
  'Not relevant to the profile or its policy triggers',
  'Marginally relevant: touches the locations or triggers, but not both',
  'Highly relevant: concrete disruption at a profile location matching a policy trigger',
] as const

/** Jev Gate 3: score search results against the profile's policy triggers. */
export async function scoreResults(
  jev: Jev,
  profile: RiskProfile,
  results: { url: string; snippet: string }[],
): Promise<ScoredResult[]> {
  const questions = Object.fromEntries(
    results.map((result, index) => [
      `r${index}`,
      score(`How relevant is the result "${result.snippet}" (from ${result.url}) to the profile?`, RELEVANCY_RUBRIC),
    ]),
  )
  const result = await jev.systemOne({
    state: { profile, results },
    questions,
  })
  return results.map((item, index) => ({
    url: item.url,
    score: answerAt(result.answers as Record<string, { score: number }>, `r${index}`).score,
  }))
}
