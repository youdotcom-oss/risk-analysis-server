import type { Database } from 'bun:sqlite'
import type { MCPClient } from '@ai-sdk/mcp'
import { updateSourceUtility } from '../db.ts'
import { type Jev, type RiskProfile, scoreResults } from '../services/jev.ts'

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
