import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonSchema } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from '../db.ts'
import { buildSweepDeps, type ProfileRecord, runSweep, type SweepOutcome, sweepAllProfiles } from '../pipeline/sweep.ts'
import type { SystemOneCaller } from '../services/jev.ts'
import { createJev } from '../services/jev.ts'

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
        return (
          overrides.deepDiveResult ?? {
            severity: 'medium',
            contentHtml: '<p>brief</p>',
          }
        )
      },
    },
  }
}

describe('runSweep', () => {
  test('below threshold: exits after triage without escalating', async () => {
    const { deps, triageCalls, deepDiveCalls } = makeDeps({
      threatProbability: 0.3,
    })
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
    expect(row?.content_html).toContain('bad')
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
      {
        profileId: 'p1',
        outcome: {
          escalated: true,
          severity: 'medium',
          reportId: expect.any(String),
        },
      },
      { profileId: 'p-bad', error: 'synthesizer down' },
    ])
    // surviving profile still persisted its report
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM risk_reports').get()
    expect(count?.n).toBe(1)
    db.close()
  })
})

describe('buildSweepDeps', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
  const response = { id: 'mock-1', timestamp: new Date(), modelId: 'mock' }
  const mockResult = (content: unknown, finishReason: string) =>
    ({
      content,
      finishReason,
      usage,
      response,
      warnings: [],
    }) as never

  test('end-to-end: highlights triage escalates into the deep dive and persists a report', async () => {
    const db = openDb(tempDbPath())
    db.query(
      `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
       VALUES ('p1', 'local-user', 'EU port operations', '["Hamburg Port"]', '["strikes"]', $now)`,
    ).run({ now: Date.now() })

    const tools = {
      'you-search': {
        inputSchema: jsonSchema({ type: 'object' }),
        async execute() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: [
                    {
                      url: 'https://hamburg.example/news',
                      snippet: 'Hamburg port strike',
                    },
                  ],
                }),
              },
            ],
          }
        },
      },
      'you-contents': {
        inputSchema: jsonSchema({ type: 'object' }),
        async execute() {
          return { content: [{ type: 'text', text: '# Full article' }] }
        },
      },
    }
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockResult(
          [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'you-search',
              input: { query: 'Hamburg Port strike' } as never,
            },
          ],
          'tool-calls' as never,
        ),
        mockResult([{ type: 'text', text: 'Searches complete.' }], 'stop' as never),
        mockResult([{ type: 'text', text: '<p>Briefing</p>' }], 'stop' as never),
      ],
    })
    // Jev: triage noul 0.8 (escalate), relevancy score 2.5, severity choice 'critical'
    const jev = {
      systemOne(request: unknown) {
        const questions = Object.keys((request as { questions: Record<string, unknown> }).questions)
        const answers = Object.fromEntries(
          questions.map((key) =>
            key === 'threat'
              ? [key, { type: 'noul', noul: 0.8 }]
              : key === 'severity'
                ? [key, { type: 'choice', choice: 'critical', confidence: 0.9 }]
                : [key, { type: 'score', score: 2.5, confidence: 0.8 }],
          ),
        )
        return Promise.resolve({ answers }) as never
      },
    } as unknown as SystemOneCaller

    const deps = buildSweepDeps({
      db,
      userId: 'local-user',
      ydcClient: { tools: () => Promise.resolve(tools) } as never,
      jev: createJev(jev),
      model: model as never,
    } as never)

    const outcome = await runSweep(deps, {
      id: 'p1',
      userId: 'local-user',
      title: 'EU port operations',
      locations: ['Hamburg Port'],
      triggers: ['strikes'],
    })

    expect(outcome.escalated).toBe(true)
    expect(outcome.severity).toBe('critical')
    const report = db
      .query<{ severity: string; content_html: string }, []>('SELECT severity, content_html FROM risk_reports')
      .get()
    expect(report?.severity).toBe('critical')
    expect(report?.content_html).toContain('Briefing')
    db.close()
  })
})
