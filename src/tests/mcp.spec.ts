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
      'get_risk_report',
      'list_risk_profiles',
      'set_risk_profile',
      'set_sweep_schedule',
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
      arguments: {
        title: 'EU ports',
        locations: ['Hamburg Port'],
        triggers: ['strikes'],
      },
    })
    const profileId = (
      JSON.parse((saved.content as unknown as [{ text: string }])[0].text) as {
        id: string
      }
    ).id

    // Start: returns immediately with a task handle; the sweep is still working.
    const started = await client.callTool({
      name: 'trigger_manual_sweep',
      arguments: { profileId },
    })
    const handle = JSON.parse((started.content as unknown as [{ type: string; text: string }])[0].text) as {
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
    expect(JSON.parse((working.content as unknown as [{ text: string }])[0].text).status).toBe('working')

    // Release the sweep; poll serves the completed result.
    releaseSweep({ escalated: true, severity: 'critical' })
    let finalText = ''
    for (let i = 0; i < 50; i++) {
      const polled = await client.callTool({
        name: 'trigger_manual_sweep',
        arguments: { task_id: handle.task_id },
      })
      finalText = (polled.content as unknown as [{ text: string }])[0].text
      if (!JSON.parse(finalText).status || JSON.parse(finalText).status === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const outcome = JSON.parse(finalText) as {
      escalated: boolean
      severity: string
      status?: string
    }
    expect(outcome.status).toBe('completed')
    expect(outcome.escalated).toBe(true)
    expect(outcome.severity).toBe('critical')
    await client.close()
    await server.close()
    db.close()
  })

  test('trigger_manual_sweep collapses concurrent starts on one profile', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let runs = 0
    const { client, serverTransport, clientTransport, server } = connect({
      sweepRunner: async () => {
        runs++
        await gate
        return { escalated: false }
      },
    })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const saved = await client.callTool({
      name: 'set_risk_profile',
      arguments: { title: 'EU ports', locations: ['Hamburg Port'], triggers: [] },
    })
    const profileId = (JSON.parse((saved.content as unknown as [{ text: string }])[0].text) as { id: string }).id

    const [first, second] = await Promise.all([
      client.callTool({ name: 'trigger_manual_sweep', arguments: { profileId } }),
      client.callTool({ name: 'trigger_manual_sweep', arguments: { profileId } }),
    ])
    const firstPayload = JSON.parse((first.content as unknown as [{ text: string }])[0].text) as { task_id: string }
    const secondPayload = JSON.parse((second.content as unknown as [{ text: string }])[0].text) as {
      task_id?: string
      already_running?: boolean
    }
    // second caller is pointed at the in-flight task, not a duplicate sweep
    if (secondPayload.already_running) {
      expect(secondPayload.task_id).toBe(firstPayload.task_id)
    }
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runs).toBe(1)
    await client.close()
    await server.close()
  })

  test('set_sweep_schedule stores, validates, and clears cron for a profile', async () => {
    const registered: string[] = []
    const db = openDb(tempDbPath())
    const server = buildMcpServer({
      db,
      userId: 'local-user',
      sweepRunner: async () => ({ escalated: false }),
      scheduler: {
        apply: (profileId: string, schedule: string | null) => registered.push(`${profileId}:${schedule}`),
        clear: (profileId: string) => registered.push(`${profileId}:cleared`),
      } as never,
    })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const saved = await client.callTool({
      name: 'set_risk_profile',
      arguments: { title: 'EU ports', locations: ['Hamburg Port'], triggers: [] },
    })
    const profileId = (JSON.parse((saved.content as unknown as [{ text: string }])[0].text) as { id: string }).id

    // set: persists + notifies the scheduler
    await client.callTool({
      name: 'set_sweep_schedule',
      arguments: { profileId, schedule: '0 9 * * 1' },
    })
    expect(registered).toContain(`${profileId}:0 9 * * 1`)

    // profile listing carries the schedule
    const listed = await client.callTool({ name: 'list_risk_profiles', arguments: {} })
    expect((listed.content as unknown as [{ text: string }])[0].text).toContain('0 9 * * 1')

    // invalid cron: clean error, nothing registered
    const bad = await client.callTool({
      name: 'set_sweep_schedule',
      arguments: { profileId, schedule: 'whenever' },
    })
    expect(bad.isError ?? false).toBe(true)

    // clear: null schedule unregisters
    await client.callTool({ name: 'set_sweep_schedule', arguments: { profileId } })
    expect(registered).toContain(`${profileId}:cleared`)

    await client.close()
    await server.close()
    db.close()
  })

  test('get_risk_report serves latest and by-id; tenant-scoped', async () => {
    const { db, client, serverTransport, clientTransport, server } = connect()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    db.query(
      `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
       VALUES ('p1', 'local-user', 'EU ports', '[]', '[]', $now)`,
    ).run({ now: Date.now() })
    db.query(
      `INSERT INTO risk_reports (id, user_id, profile_id, severity, content_html, created_at)
       VALUES ('r1', 'local-user', 'p1', 'critical', '# EU ports — risk report\n\n## Summary\n\nPort strike.', $now)`,
    ).run({ now: Date.now() })
    db.query(`INSERT INTO users (id, email, created_at) VALUES ('other-user', 'other@localhost', $now)`).run({
      now: Date.now(),
    })
    db.query(
      `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
       VALUES ('p2', 'other-user', 'Other tenant ports', '[]', '[]', $now)`,
    ).run({ now: Date.now() })
    db.query(
      `INSERT INTO risk_reports (id, user_id, profile_id, severity, content_html, created_at)
       VALUES ('r0', 'other-user', 'p2', 'low', '<p>someone else</p>', $now)`,
    ).run({ now: Date.now() })

    const latest = await client.callTool({
      name: 'get_risk_report',
      arguments: {},
    })
    const latestPayload = JSON.parse((latest.content as unknown as [{ text: string }])[0].text) as {
      severity: string
      report_markdown: string
    }
    expect(latestPayload.severity).toBe('critical')
    expect(latestPayload.report_markdown).toContain('Port strike.')

    const byId = await client.callTool({
      name: 'get_risk_report',
      arguments: { report_id: 'r0' },
    })
    expect(byId.isError ?? false).toBe(true) // other tenant's report is invisible

    const missing = await client.callTool({
      name: 'get_risk_report',
      arguments: { report_id: 'nope' },
    })
    expect(missing.isError ?? false).toBe(true)

    await client.close()
    await server.close()
    db.close()
  })
})
