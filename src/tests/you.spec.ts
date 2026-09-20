import { afterAll, describe, expect, test } from 'bun:test'
import { buildYdcTransport } from '../services/you.ts'

const savedEnv = { ...process.env }
afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key in savedEnv) continue
    delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

describe('buildYdcTransport', () => {
  test('scopes the URL to search and contents with bearer auth', () => {
    process.env.YDC_API_KEY = 'test-key'
    delete process.env.YDC_MCP_URL
    const transport = buildYdcTransport()
    expect(transport.type).toBe('http')
    const url = new URL(transport.url)
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe('https://api.you.com/mcp')
    expect(url.searchParams.get('tools')).toBe('you-search,you-contents')
    expect(url.searchParams.has('profile')).toBe(false)
    expect(transport.headers?.Authorization).toBe('Bearer test-key')
  })

  test('omits auth header when no API key is set', () => {
    delete process.env.YDC_API_KEY
    const transport = buildYdcTransport()
    expect(transport.headers).toBeUndefined()
  })

  test('honors YDC_MCP_URL override for local package testing', () => {
    process.env.YDC_MCP_URL = 'http://127.0.0.1:9988/mcp'
    const transport = buildYdcTransport()
    expect(transport.url.startsWith('http://127.0.0.1:9988/mcp')).toBe(true)
  })
})
