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
  test('exposes the profile and sweep tools', async () => {
    const { client, serverTransport, clientTransport, server } = connect()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'list_risk_profiles',
      'set_risk_profile',
      'trigger_manual_sweep',
    ])
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

  test('trigger_manual_sweep: start returns a task handle; poll serves status and result', async () => {
    let releaseSweep: (outcome: { escalated: boolean; severity: string }) => void = () => {}
    const gate = new Promise<{ escalated: boolean; severity: string }>((resolve) => {
      releaseSweep = resolve
    })
    const { db, client, serverTransport, clientTransport, server } = connect({
      sweepRunner: async () => await gate,
    })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const saved = await client.callTool({
      name: 'set_risk_profile',
      arguments: { title: 'EU ports', locations: ['Hamburg Port'], triggers: ['strikes'] },
    })
    const profileId = (JSON.parse((saved.content as [{ text: string }])[0].text) as { id: string }).id

    // Start: returns immediately with a task handle; the sweep is still working.
    const started = await client.callTool({
      name: 'trigger_manual_sweep',
      arguments: { profileId },
    })
    const handle = JSON.parse((started.content as [{ type: string; text: string }])[0].text) as {
      task_id: string
      status: string
    }
    expect(handle.task_id).toMatch(/[0-9a-f-]{36}/)
    expect(handle.status).toBe('working')

    // Poll while working.
    const working = await client.callTool({
      name: 'trigger_manual_sweep',
      arguments: { task_id: handle.task_id },
    })
    expect(JSON.parse((working.content as [{ text: string }])[0].text).status).toBe('working')

    // Release the sweep; poll serves the completed result.
    releaseSweep({ escalated: true, severity: 'critical' })
    let finalText = ''
    for (let i = 0; i < 50; i++) {
      const polled = await client.callTool({
        name: 'trigger_manual_sweep',
        arguments: { task_id: handle.task_id },
      })
      finalText = (polled.content as [{ text: string }])[0].text
      if (!JSON.parse(finalText).status || JSON.parse(finalText).status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const outcome = JSON.parse(finalText) as { escalated: boolean; severity: string }
    expect(outcome.escalated).toBe(true)
    expect(outcome.severity).toBe('critical')
    await client.close()
    await server.close()
    db.close()
  })

  test('trigger_manual_sweep binds the report UI resource (MCP Apps _meta)', async () => {
    const { client, server, serverTransport, clientTransport } = connect()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = await client.listTools()
    const sweep = tools.tools.find((tool) => tool.name === 'trigger_manual_sweep')
    // SEP-1865: the host only renders the iframe when the tool declares
    // _meta.ui.resourceUri pointing at a ui:// resource.
    expect((sweep?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(
      'ui://risk-report/latest',
    )
    await client.close()
    await server.close()
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
    expect(contents?.mimeType).toBe('text/html;profile=mcp-app')
    expect((contents as { text?: string }).text).toBe('<p>bad</p>')
    await client.close()
    await server.close()
    db.close()
  })
})
