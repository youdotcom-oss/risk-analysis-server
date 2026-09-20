import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'

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
