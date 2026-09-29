import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { jsonSchema } from 'ai'

type TransportConfig = Extract<Parameters<typeof createMCPClient>[0]['transport'], { url: string }>

export function buildYdcTransport(): TransportConfig {
  const url = new URL(process.env.YDC_MCP_URL ?? 'https://api.you.com/mcp')
  url.searchParams.set('tools', 'you-search,you-contents')
  const apiKey = process.env.YDC_API_KEY
  return {
    type: 'http',
    url: url.href,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  }
}

export function createYdcClient(): Promise<MCPClient> {
  return createMCPClient({ transport: buildYdcTransport() })
}

export type NormalizedSearchResult = {
  url: string
  title: string
  description: string
  /** Licensed-data provider names (knowledge results only). */
  attribution?: string[]
  /** The date the underlying data covers (knowledge results only). */
  asOf?: string
}

/**
 * Parse a you-search text payload into the fields downstream consumers need.
 * The real upstream shape is { results: { web: [...], news?: [...] } } with
 * `description`; the legacy/unit-stub shape was a flat array with `snippet`.
 * MINIMAL: bespoke parser over two known shapes; structuredContent is the
 * upgrade path if the upstream schema settles.
 */
export function parseSearchResults(text: string): NormalizedSearchResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const collect = (items: unknown): NormalizedSearchResult[] =>
    (Array.isArray(items) ? items : []).flatMap((item) => {
      const record = item as {
        url?: unknown
        title?: unknown
        snippet?: unknown
        description?: unknown
        attribution?: unknown
        as_of?: unknown
      }
      // Knowledge results (licensed facts, e.g. Fiscal.ai financials) carry
      // no url — they are kept with url: '' and flow into synthesis, but are
      // excluded from contents fetching (nothing to crawl).
      const url = typeof record.url === 'string' ? record.url : ''
      const description =
        typeof record.description === 'string'
          ? record.description
          : typeof record.snippet === 'string'
            ? record.snippet
            : ''
      if (url === '' && description === '') return []
      return [
        {
          url,
          title: typeof record.title === 'string' ? record.title : '',
          description,
          attribution: Array.isArray(record.attribution)
            ? record.attribution
                .map((a) => (a as { name?: unknown }).name)
                .filter((name): name is string => typeof name === 'string')
            : undefined,
          asOf: typeof record.as_of === 'string' ? record.as_of : undefined,
        },
      ]
    })
  const resultsBlock = (parsed as { results?: unknown }).results
  if (resultsBlock && typeof resultsBlock === 'object' && !Array.isArray(resultsBlock)) {
    return Object.values(resultsBlock as Record<string, unknown>).flatMap(collect)
  }
  return collect(Array.isArray(resultsBlock) ? resultsBlock : parsed)
}

/**
 * Proposal-loop toolset: a pure query recorder. The model never executes
 * searches — every proposal is collected, batch-ranked by Jev (Gate 2), and
 * only the top-ranked slice is executed with the code-owned budget. Executing
 * searches inside the loop once cost 19–26 searches per sweep; ranking first
 * cuts retrieval to the budget while keeping the model's diversity of angles.
 */
export function createProposalTools(): Record<string, unknown> {
  return {
    propose_query: {
      description:
        'Record one search query to execute later. Queries must contain a strict ' +
        'geospatial identifier and avoid broad generic keywords. Candidates are ' +
        'ranked afterwards and only the best are executed — propose several angles.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      }),
      async execute(input: Record<string, unknown>) {
        const query = String(input.query ?? '').trim()
        return {
          content: [
            {
              type: 'text' as const,
              text: query
                ? `Recorded: "${query}". Propose another angle or finish.`
                : 'Empty query ignored — propose a concrete geospatial search.',
            },
          ],
        }
      },
    },
  }
}
