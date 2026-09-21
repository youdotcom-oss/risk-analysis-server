import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { SignJWT } from 'jose'
import { openDb } from '../db.ts'
import { createApp } from '../server.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-e2e-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

async function tokenFor(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('e2e-secret'))
}

describe('e2e: real client through the http entry (in-process)', () => {
  test('initialize, tools/list, tools/call and resource read through the hono app', async () => {
    const db = openDb(tempDbPath())
    const app = createApp({
      db,
      jwtSecret: 'e2e-secret',
      sweepRunnerFactory: () => async () => ({ escalated: false }),
    })

    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      requestInit: {
        headers: {
          authorization: `Bearer ${await tokenFor('e2e-sub')}`,
          host: 'localhost',
        },
      },
      fetch: async (input: string | URL, init?: RequestInit) => app.fetch(new Request(input.toString(), init)),
    })
    const client = new Client({ name: 'e2e-harness', version: '0.0.0' })
    await client.connect(transport)

    // tools/list works through the full auth -> factory -> server chain
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_risk_report',
      'list_risk_profiles',
      'set_risk_profile',
      'trigger_manual_sweep',
    ])

    // tools/call persists a tenant-scoped profile
    const call = await client.callTool({
      name: 'set_risk_profile',
      arguments: {
        title: 'E2E profile',
        locations: ['Hamburg Port'],
        triggers: ['strikes'],
      },
    })
    expect(call.isError ?? false).toBe(false)

    // report read with no reports yet -> clean error result
    const report = await client.callTool({ name: 'get_risk_report', arguments: {} })
    expect(report.isError ?? false).toBe(true)

    // the profile landed under the bearer sub, not local-user
    const profiles = db.query<{ user_id: string; title: string }, []>('SELECT user_id, title FROM risk_profiles').all()
    expect(profiles).toEqual([{ user_id: 'e2e-sub', title: 'E2E profile' }])

    await client.close()
    db.close()
  })

  test('unauthenticated requests are rejected before the handler', async () => {
    const db = openDb(tempDbPath())
    const app = createApp({
      db,
      jwtSecret: 'e2e-secret',
      sweepRunnerFactory: () => async () => ({ escalated: false }),
    })
    const res = await app.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(res.status).toBe(401)
    db.close()
  })
})

describe('e2e: stdio spawned process', () => {
  test('client spawns bun src/stdio.ts and round-trips a tool call', async () => {
    const dir = mkdtempSync(`${tmpdir()}/risk-stdio-`)
    dirs.push(dir)
    const client = new Client({ name: 'e2e-stdio', version: '0.0.0' })
    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['src/stdio.ts'],
      cwd: process.cwd(),
      env: {
        RISK_DB_PATH: join(dir, 'risk.sqlite'),
        // no API keys: warnings print to stderr, tools still list
      },
      stderr: 'pipe',
    })
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'get_risk_report',
      'list_risk_profiles',
      'set_risk_profile',
      'trigger_manual_sweep',
    ])

    const call = await client.callTool({
      name: 'set_risk_profile',
      arguments: { title: 'Stdio e2e', locations: ['Rotterdam'], triggers: [] },
    })
    expect(call.isError ?? false).toBe(false)

    // report read with no reports yet -> clean error result
    const report = await client.callTool({ name: 'get_risk_report', arguments: {} })
    expect(report.isError ?? false).toBe(true)

    await client.close()
  }, 30_000)
})
