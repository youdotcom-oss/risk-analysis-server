import type { Database } from 'bun:sqlite'
import type { MCPClient } from '@ai-sdk/mcp'
import { choice } from '@typesafe-ai/sdk'
import { generateText, stepCountIs, type ToolSet } from 'ai'
import { updateSourceUtility } from '../db.ts'
import { type Jev, type RiskProfile, scoreResults } from '../services/jev.ts'
import { createDeepDiveTools } from '../services/you.ts'

export type QueryToolCallStep = {
  content: { type: string; toolName?: string; input?: unknown }[]
}

/**
 * Stage 2 harvest: the executed you-search calls' query inputs — each one
 * already passed Jev Gate 2 (the gate lives in the tool execute). Deduped,
 * first-seen order.
 */
export function collectQueries(steps: QueryToolCallStep[]): string[] {
  const queries: string[] = []
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type === 'tool-call' && part.toolName === 'you-search') {
        const query = (part.input as { query?: unknown } | undefined)?.query
        if (typeof query === 'string' && query !== '' && !queries.includes(query)) {
          queries.push(query)
        }
      }
    }
  }
  return queries
}

const DISRUPTION_TERMS = '("supply chain" OR "disruption" OR "hazard" OR "strike")'

/** Deterministic fallback when the agentic loop yields no accepted query. */
export function fallbackQuery(profile: RiskProfile): string {
  const locations = profile.locations.map((location) => `"${location}"`)
  if (locations.length === 0) return DISRUPTION_TERMS
  return `${locations.join(' OR ')} AND ${DISRUPTION_TERMS}`
}

export type RetrieveDeps = {
  client: Pick<MCPClient, 'tools'>
  jev: Jev
  db: Database
  userId: string
}

export type DeepDiveDeps = RetrieveDeps & {
  model: Parameters<typeof generateText>[0]['model']
}

export type ProfileRecordLike = RiskProfile & {
  id: string
  userId: string
}

export type ScoredResult = {
  url: string
  domain: string
  snippet: string
  score: number
}

function domainOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Stage 3: concurrent code-invoked searches for the accepted queries,
 * dedup by URL across queries, Jev relevancy scoring (Gate 3), then
 * domain-utility deltas persisted in one transaction.
 */
export async function retrieveAndScore(deps: RetrieveDeps, queries: string[]): Promise<ScoredResult[]> {
  const tools = await deps.client.tools()
  const search = tools['you-search']
  if (!search) throw new Error('you-search tool not exposed by the You.com MCP server')

  const rawResults = await Promise.all(
    queries.map(async (query) => {
      const output = await search.execute({ query }, undefined as unknown as Parameters<typeof search.execute>[1])
      const text =
        (output as { content?: { type: string; text?: string }[] }).content?.find((block) => block.type === 'text')
          ?.text ?? '[]'
      let parsed: { results?: { url: string; snippet?: string }[] } = {}
      try {
        parsed = JSON.parse(text) as { results?: { url: string; snippet?: string }[] }
      } catch {
        parsed = {}
      }
      return parsed.results ?? []
    }),
  )

  // dedupe by URL, first-seen order
  const seen = new Set<string>()
  const results: { url: string; snippet: string }[] = []
  for (const batch of rawResults) {
    for (const item of batch) {
      if (!seen.has(item.url)) {
        seen.add(item.url)
        results.push({ url: item.url, snippet: item.snippet ?? '' })
      }
    }
  }

  const scored = await scoreResults(deps.jev, { title: '', locations: [], triggers: [] }, results)

  updateSourceUtility(
    deps.db,
    deps.userId,
    scored.map((item) => ({ domain: domainOf(item.url), delta: item.score - 1 })),
  )

  return scored.map((item) => ({
    url: item.url,
    domain: domainOf(item.url),
    snippet: results.find((r) => r.url === item.url)?.snippet ?? '',
    score: item.score,
  }))
}

const PROPOSAL_PROMPT = (profile: RiskProfile) =>
  `You are investigating supply-chain risk for "${profile.title}". ` +
  `Locations: ${profile.locations.join(', ')}. Policy triggers: ${profile.triggers.join(', ')}. ` +
  'Search for concrete disruptions at these locations. Prefer precise geospatial queries.'

const MAX_PROPOSAL_STEPS = 5
const MAX_CONTENT_URLS = 10

/** Stage 2: run the agentic proposal loop with Jev-gated search tools. */
async function proposeQueries(deps: DeepDiveDeps, profile: RiskProfile): Promise<string[]> {
  const tools = (await createDeepDiveTools({ client: deps.client, jev: deps.jev, profile })) as ToolSet
  const result = await generateText({
    model: deps.model,
    tools,
    stopWhen: stepCountIs(MAX_PROPOSAL_STEPS),
    prompt: PROPOSAL_PROMPT(profile),
  })
  const queries = collectQueries(result.steps)
  return queries.length > 0 ? queries : [fallbackQuery(profile)]
}

/** Stage 3b: code-invoked you-contents for the top-ranked URLs. */
async function fetchContents(deps: RetrieveDeps, urls: string[]): Promise<string> {
  if (urls.length === 0) return ''
  const tools = await deps.client.tools()
  const contents = tools['you-contents']
  if (!contents) throw new Error('you-contents tool not exposed by the You.com MCP server')
  const output = await contents.execute(
    { urls: urls.slice(0, MAX_CONTENT_URLS) },
    undefined as unknown as Parameters<typeof contents.execute>[1],
  )
  const blocks = (output as { content?: { type: string; text?: string }[] }).content ?? []
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
}

const SEVERITY_LEVELS = {
  low: 'No material disruption expected; routine monitoring suffices',
  medium: 'Notable disruption risk; mitigation planning recommended',
  critical: 'Active disruption at a profile location; immediate action needed',
}

/** Gate 3b: severity of the situation as a Jev choice over the scored results. */
async function assessSeverity(jev: Jev, profile: RiskProfile, scored: ScoredResult[]): Promise<string> {
  const result = await jev.systemOne({
    state: { profile, results: scored },
    questions: {
      severity: choice(
        'Given the scored evidence, how severe is the current supply-chain situation for the profile?',
        SEVERITY_LEVELS,
      ),
    },
  })
  const answer = result.answers.severity as { choice: string }
  if (!(answer.choice in SEVERITY_LEVELS)) throw new Error(`Invalid severity: ${answer.choice}`)
  return answer.choice
}

/**
 * Stages 2–4 for one profile: agentic proposal loop (Jev-gated searches),
 * retrieval + scoring, contents fetch, synthesis to self-contained HTML,
 * and severity via Jev choice.
 */
export async function deepDive(
  deps: DeepDiveDeps,
  profile: ProfileRecordLike,
): Promise<{ severity: string; contentHtml: string }> {
  const queries = await proposeQueries(deps, profile)
  const scored = await retrieveAndScore(deps, queries)
  const contents = await fetchContents(
    deps,
    scored.map((item) => item.url),
  )
  const [severity, synthesis] = await Promise.all([
    assessSeverity(deps.jev, profile, scored),
    generateText({
      model: deps.model,
      system:
        'You write concise executive supply-chain briefings. ' +
        'Return ONLY a self-contained HTML fragment (inline CSS) for the briefing.',
      prompt:
        `Profile: ${profile.title}. Locations: ${profile.locations.join(', ')}.\n` +
        `Scored findings: ${JSON.stringify(scored)}\nFull article contents:\n${contents}`,
    }),
  ])
  return { severity, contentHtml: synthesis.text }
}
