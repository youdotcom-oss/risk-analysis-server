import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db.ts'
import { type ProfileRecord, runSweep, type SweepOutcome, sweepAllProfiles } from '../pipeline/sweep.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

const profile = {
  id: 'p1',
  userId: 'local-user',
  title: 'EU port operations',
  locations: ['Hamburg Port'],
  triggers: ['strike action', 'customs delay'],
}

function makeDeps(overrides: {
  threatProbability: number
  deepDiveCalls?: unknown[]
  deepDiveResult?: { severity: string; contentHtml: string }
}) {
  const triageCalls: unknown[] = []
  const deepDiveCalls: unknown[] = []
  const db = openDb(tempDbPath())
  db.query(
    `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
     VALUES ('p1', 'local-user', 'EU port operations', '["Hamburg Port"]', '["strikes"]', $now)`,
  ).run({ now: Date.now() })
  return {
    db,
    triageCalls,
    deepDiveCalls,
    deps: {
      db,
      fetchHighlights: async () => ['highlight-1'],
      triage: async (profile: unknown, highlights: unknown) => {
        triageCalls.push({ profile, highlights })
        return overrides.threatProbability
      },
      deepDive: async (profile: ProfileRecord) => {
        deepDiveCalls.push(profile)
        return overrides.deepDiveResult ?? { severity: 'medium', contentHtml: '<p>brief</p>' }
      },
    },
  }
}

describe('runSweep', () => {
  test('below threshold: exits after triage without escalating', async () => {
    const { deps, triageCalls, deepDiveCalls } = makeDeps({ threatProbability: 0.3 })
    const outcome: SweepOutcome = await runSweep(deps, profile)
    expect(outcome.escalated).toBe(false)
    expect(triageCalls).toHaveLength(1)
    expect(deepDiveCalls).toHaveLength(0)
  })

  test('above threshold: escalates, persists report, and returns severity', async () => {
    const { deps, db, deepDiveCalls } = makeDeps({
      threatProbability: 0.8,
      deepDiveResult: { severity: 'critical', contentHtml: '<p>bad</p>' },
    })
    const outcome = await runSweep(deps, profile)
    expect(outcome.escalated).toBe(true)
    expect(outcome.severity).toBe('critical')
    expect(deepDiveCalls).toHaveLength(1)
    const row = db
      .query<{ severity: string; content_html: string }, []>('SELECT severity, content_html FROM risk_reports')
      .get()
    expect(row?.severity).toBe('critical')
    expect(row?.content_html).toBe('<p>bad</p>')
    db.close()
  })
})

describe('sweepAllProfiles', () => {
  test('isolates per-profile failures so one crash never stops the batch', async () => {
    const { deps, db } = makeDeps({ threatProbability: 0.8 })
    const failing = { ...profile, id: 'p-bad', title: 'Broken profile' }
    db.query(
      `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
       VALUES ('p-bad', 'local-user', 'Broken profile', '["X"]', '["y"]', $now)`,
    ).run({ now: Date.now() })
    const originalDeepDive = deps.deepDive
    deps.deepDive = async (p: ProfileRecord) => {
      if (p.id === 'p-bad') throw new Error('synthesizer down')
      return originalDeepDive(p)
    }

    const results = await sweepAllProfiles(deps, [profile, failing])
    expect(results).toEqual([
      { profileId: 'p1', outcome: { escalated: true, severity: 'medium', reportId: expect.any(String) } },
      { profileId: 'p-bad', error: 'synthesizer down' },
    ])
    // surviving profile still persisted its report
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM risk_reports').get()
    expect(count?.n).toBe(1)
    db.close()
  })
})
