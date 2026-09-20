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

  return {
    ...mcpTools,
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
        return search.execute({ ...input, knowledge: 'core' }, options as Parameters<typeof search.execute>[1])
      },
    },
  }
}
