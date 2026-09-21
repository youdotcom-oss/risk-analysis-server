import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { jsonSchema } from 'ai'
import { type Jev, type RiskProfile, validateQueries } from './jev.ts'

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
      }
      if (typeof record.url !== 'string' || record.url === '') return []
      return [
        {
          url: record.url,
          title: typeof record.title === 'string' ? record.title : '',
          description:
            typeof record.description === 'string'
              ? record.description
              : typeof record.snippet === 'string'
                ? record.snippet
                : '',
        },
      ]
    })
  const resultsBlock = (parsed as { results?: unknown }).results
  if (resultsBlock && typeof resultsBlock === 'object' && !Array.isArray(resultsBlock)) {
    return Object.values(resultsBlock as Record<string, unknown>).flatMap(collect)
  }
  return collect(Array.isArray(resultsBlock) ? resultsBlock : parsed)
}

export type DeepDiveDeps = {
  client: Pick<MCPClient, 'tools'>
  jev: Jev
  profile: RiskProfile
}

/**
 * Agentic-path toolset: `you-search` re-wrapped with `knowledge` hidden from
 * the model and `knowledge: "core"` injected server-bound behind Jev Gate 2.
 */
export async function createDeepDiveTools(deps: DeepDiveDeps): Promise<Record<string, unknown>> {
  const mcpTools = await deps.client.tools()
  const search = mcpTools['you-search']
  if (!search) throw new Error('you-search tool not exposed by the You.com MCP server')
  const raw =
    'jsonSchema' in search.inputSchema
      ? search.inputSchema.jsonSchema
      : (() => {
          throw new Error('you-search inputSchema is not JSON-Schema-backed')
        })()
  const { knowledge: _omitted, ...properties } = raw.properties ?? {}
  type RawSchema = typeof raw

  // Proposal loop gets you-search only. you-contents returns full web
  // pages; when the model fetched one mid-loop it stayed in conversation
  // history and blew the context cap (Germany: fixed ~115k tokens
  // regardless of profile scope). Contents are fetched code-invoked in
  // Stage 3b — the loop never needs them.
  const { 'you-contents': _contents, ...proposalTools } = mcpTools
  return {
    ...proposalTools,
    'you-search': {
      ...search,
      inputSchema: jsonSchema({
        ...raw,
        properties,
        required: (raw.required ?? []).filter((name: string) => name !== 'knowledge'),
        additionalProperties: false,
      } as RawSchema),
      async execute(input: Record<string, unknown>, options?: unknown) {
        const query = String(input.query ?? '')
        const [verdict] = await validateQueries(deps.jev, deps.profile, [query])
        if (verdict && !verdict.accepted) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Query rejected by relevance gate: "${query}". ` +
                  'Re-propose with a strict geospatial identifier and no broad generic keywords.',
              },
            ],
          }
        }
        // Project to the fields the proposal model actually needs (url,
        // title, description) instead of forwarding full highlight payloads —
        // full text across 5 steps once exceeded a 131k context (150k tokens).
        const output = (await search.execute(
          { ...input, knowledge: 'core' },
          options as Parameters<typeof search.execute>[1],
        )) as { content?: { type: string; text?: string }[] }
        const compact = output.content
          ?.filter((block) => block.type === 'text')
          .flatMap((block) => parseSearchResults(block.text ?? ''))
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ results: compact }),
            },
          ],
        }
      },
    },
  }
}
