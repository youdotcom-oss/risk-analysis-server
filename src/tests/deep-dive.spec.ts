import { describe, expect, test } from 'bun:test'
import { openDb } from '../db.ts'
import { collectQueries, fallbackQuery, retrieveAndScore } from '../pipeline/deep-dive.ts'
import type { ProfileRecord } from '../pipeline/sweep.ts'
import type { SystemOneCaller } from '../services/jev.ts'
import { createJev } from '../services/jev.ts'

const dirs: string[] = []

import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

describe('collectQueries', () => {
  test('extracts distinct you-search queries from tool-call steps', () => {
    const steps = [
      {
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'you-search', input: { query: 'Hamburg Port strike' } },
        ],
      },
      {
        content: [
          { type: 'text', text: 'searching more' },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'you-search', input: { query: 'Hamburg Port strike' } },
          { type: 'tool-call', toolCallId: 'c3', toolName: 'you-search', input: { query: 'Duisburg rail blockade' } },
        ],
      },
    ]
    expect(collectQueries(steps as never)).toEqual(['Hamburg Port strike', 'Duisburg rail blockade'])
  })

  test('ignores tool calls to other tools and missing queries', () => {
    const steps = [
      {
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'you-contents', input: { urls: ['x'] } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'you-search', input: {} },
        ],
      },
    ]
    expect(collectQueries(steps as never)).toEqual([])
  })
})

describe('fallbackQuery', () => {
  test('builds the deterministic template from profile locations', () => {
    const profile: ProfileRecord = {
      id: 'p1',
      userId: 'u',
      title: 't',
      locations: ['Hamburg Port', 'Rotterdam'],
      triggers: ['strikes'],
    }
    expect(fallbackQuery(profile)).toBe(
      '"Hamburg Port" OR "Rotterdam" AND ("supply chain" OR "disruption" OR "hazard" OR "strike")',
    )
  })

  test('falls back to generic template without locations', () => {
    const profile: ProfileRecord = { id: 'p1', userId: 'u', title: 't', locations: [], triggers: [] }
    expect(fallbackQuery(profile)).toBe('("supply chain" OR "disruption" OR "hazard" OR "strike")')
  })
})

describe('retrieveAndScore', () => {
  function stubTools() {
    const searchCalls: { query: string }[] = []
    const tools = {
      'you-search': {
        inputSchema: { jsonSchema: { type: 'object' } },
        async execute(input: { query: string }) {
          searchCalls.push({ query: input.query })
          const shared = {
            url: 'https://shared.example/article',
            snippet: 'shared coverage',
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results:
                    input.query === 'Hamburg Port strike'
                      ? [shared, { url: 'https://hamburg.example/news', snippet: 'Hamburg port strike' }]
                      : [shared, { url: 'https://rotterdam.example/news', snippet: 'Rotterdam delays' }],
                }),
              },
            ],
          }
        },
      },
    }
    return { tools, searchCalls }
  }

  function jevStub(scores: number[]) {
    let index = 0
    return {
      systemOne(request: unknown) {
        const keys = Object.keys((request as { questions: Record<string, unknown> }).questions)
        const answers = Object.fromEntries(
          keys.map((key) => [key, { type: 'score', score: scores[index++ % scores.length] ?? 1, confidence: 0.9 }]),
        )
        return Promise.resolve({ answers }) as never
      },
    } as unknown as SystemOneCaller
  }

  test('runs queries concurrently, dedupes by URL, scores, and persists utility', async () => {
    const { tools, searchCalls } = stubTools()
    const client = { tools: () => Promise.resolve(tools) } as never
    const db = openDb(tempDbPath())
    const deps = { client, jev: createJev(jevStub([2.5, 0.5])), db, userId: 'local-user' }
    const scored = await retrieveAndScore(deps, ['Hamburg Port strike', 'Duisburg rail blockade'])

    // both queries executed (concurrently)
    expect(searchCalls.map((c) => c.query).sort()).toEqual(['Duisburg rail blockade', 'Hamburg Port strike'])
    // deduped by URL across queries
    expect(scored.map((r) => r.url)).toEqual([
      'https://shared.example/article',
      'https://hamburg.example/news',
      'https://rotterdam.example/news',
    ])
    // utility deltas persisted (first-seen result scored 2.5 → insert score 1.0 + 1.5)
    const row = db
      .query<{ score: number }, [string]>('SELECT score FROM source_utility WHERE domain = ?')
      .get('shared.example')
    expect(row?.score).toBeCloseTo(2.5, 5)
    db.close()
  })
})
