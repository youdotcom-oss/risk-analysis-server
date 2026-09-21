import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { getActiveProfiles, openDb } from '../db.ts'
import { createApp } from '../server.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

const SECRET = new TextEncoder().encode('test-secret')

async function tokenFor(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET)
}

function makeApp() {
  const db = openDb(tempDbPath())
  const app = createApp({
    db,
    jwtSecret: 'test-secret',
    sweepRunnerFactory: () => async () => ({ escalated: false }),
  })
  return { db, app }
}

function mcpRequest(app: Awaited<ReturnType<typeof makeApp>>['app'], body: unknown, auth?: string) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: 'localhost',
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe('createApp', () => {
  test('rejects unauthenticated /mcp requests before reaching the handler', async () => {
    const { app } = makeApp()
    const res = await mcpRequest(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    expect(res.status).toBe(401)
  })

  test('rejects invalid tokens', async () => {
    const { app } = makeApp()
    const res = await mcpRequest(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer not-a-token')
    expect(res.status).toBe(401)
  })

  test('authenticated tools/list works and tools are tenant-scoped by sub', async () => {
    const { db, app } = makeApp()
    const token = await tokenFor('user-a')
    const res = await mcpRequest(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${token}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('set_risk_profile')
    expect(text).toContain('trigger_manual_sweep')

    // tenant provisioning happened for sub
    const call = await mcpRequest(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'set_risk_profile',
          arguments: { title: 'A profile', locations: ['X'], triggers: [] },
        },
      },
      `Bearer ${token}`,
    )
    expect(call.status).toBe(200)
    expect(getActiveProfiles(db, 'user-a')).toHaveLength(1)
    db.close()
  })

  test('accepts an injected verifyBearer instead of the HMAC default', async () => {
    const db = openDb(tempDbPath())
    const verifyCalls: string[] = []
    const app = createApp({
      db,
      jwtSecret: 'test-secret', // ignored when a verifier is injected
      verifyBearer: async (req) => {
        verifyCalls.push(req.headers.get('authorization') ?? '')
        return req.headers.get('authorization') === 'Bearer custom' ? { sub: 'custom-user' } : null
      },
      sweepRunnerFactory: () => async () => ({ escalated: false }),
    })
    const res = await mcpRequest(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer custom')
    expect(res.status).toBe(200)
    expect(verifyCalls).toHaveLength(1)
    // invalid per the injected verifier
    const rejected = await mcpRequest(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'Bearer wrong')
    expect(rejected.status).toBe(401)
    db.close()
  })

  test('serves RFC 9728 protected-resource metadata', async () => {
    const { app } = makeApp()
    const res = await app.request('/.well-known/oauth-protected-resource', {
      headers: { host: 'localhost' },
    })
    expect(res.status).toBe(200)
    const metadata = (await res.json()) as Record<string, unknown>
    expect(metadata.resource).toBe('urn:risk-analysis-server')
    expect(Array.isArray(metadata.scopes_supported)).toBe(true)
  })
})
