import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { getActiveProfiles, openDb } from '../db.ts'
import { buildMcpServer, type McpFactoryDeps } from '../mcp.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

function connect(deps: Partial<McpFactoryDeps> = {}) {
  const db = openDb(tempDbPath())
  const server = buildMcpServer({
    db,
    userId: 'local-user',
    sweepRunner: async () => ({ escalated: false }),
    ...deps,
  })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  return { db, server, client, serverTransport, clientTransport }
}

describe('buildMcpServer', () => {
  test('exposes set_risk_profile and trigger_manual_sweep', async () => {
    const { client, serverTransport, clientTransport, server } = connect()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['set_risk_profile', 'trigger_manual_sweep'])
    await client.close()
    await server.close()
  })

  test('set_risk_profile persists the profile for the tenant', async () => {
    const { db, client, serverTransport, clientTransport, server } = connect()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({
      name: 'set_risk_profile',
      arguments: {
        title: 'EU ports',
        locations: ['Hamburg Port'],
        triggers: ['strikes'],
      },
    })
    expect(result.isError ?? false).toBe(false)
    const text = (result.content as [{ type: string; text?: string }])[0]?.text
    const echoed = JSON.parse(text ?? '') as { id: string; title: string }
    expect(echoed.id).toMatch(/[0-9a-f-]{36}/)
    expect(echoed.title).toBe('EU ports')
    const profiles = getActiveProfiles(db, 'local-user')
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.title).toBe('EU ports')
    expect(profiles[0]?.id).toBe(echoed.id)
    await client.close()
    await server.close()
    db.close()
  })

  test('ui://risk-report/latest serves the latest stored HTML', async () => {
    const { db, client, serverTransport, clientTransport, server } = connect()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    db.query(
      `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
       VALUES ('p1', 'local-user', 't', '[]', '[]', $now)`,
    ).run({ now: Date.now() })
    db.query(
      `INSERT INTO risk_reports (id, user_id, profile_id, severity, content_html, created_at)
       VALUES ('r1', 'local-user', 'p1', 'critical', '<p>bad</p>', $now)`,
    ).run({ now: Date.now() })
    const resource = await client.readResource({ uri: 'ui://risk-report/latest' })
    const contents = resource.contents[0]
    expect(contents?.mimeType).toBe('text/html')
    expect((contents as { text?: string }).text).toBe('<p>bad</p>')
    await client.close()
    await server.close()
    db.close()
  })
})
