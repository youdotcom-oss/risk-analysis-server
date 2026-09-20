import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'

type TransportConfig = Extract<Parameters<typeof createMCPClient>[0]['transport'], { url: string }>

export type YdcClientOptions = {
  /** Keyless dev/test profile exposing you-search only. */
  profile?: 'free'
}

export function buildYdcTransport(options: YdcClientOptions = {}): TransportConfig {
  const url = new URL(process.env.YDC_MCP_URL ?? 'https://api.you.com/mcp')
  if (options.profile === 'free') {
    url.searchParams.set('profile', 'free')
  } else {
    url.searchParams.set('tools', 'you-search,you-contents')
  }
  const apiKey = process.env.YDC_API_KEY
  return {
    type: 'http',
    url: url.href,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  }
}

export async function createYdcClient(options: YdcClientOptions = {}): Promise<MCPClient> {
  return createMCPClient({ transport: buildYdcTransport(options) })
}
