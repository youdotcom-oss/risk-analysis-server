import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonSchema } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from '../db.ts'
import { collectQueries, deepDive, fallbackQuery, retrieveAndScore } from '../pipeline/deep-dive.ts'
import type { ProfileRecord } from '../pipeline/sweep.ts'
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

describe('collectQueries', () => {
  test('extracts distinct you-search queries from tool-call steps', () => {
    const steps = [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'you-search',
            input: { query: 'Hamburg Port strike' },
          },
        ],
      },
      {
        content: [
          { type: 'text', text: 'searching more' },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'you-search',
            input: { query: 'Hamburg Port strike' },
          },
          {
            type: 'tool-call',
            toolCallId: 'c3',
            toolName: 'you-search',
            input: { query: 'Duisburg rail blockade' },
          },
        ],
      },
    ]
    expect(collectQueries(steps as never)).toEqual(['Hamburg Port strike', 'Duisburg rail blockade'])
  })

  test('ignores tool calls to other tools and missing queries', () => {
    const steps = [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'you-contents',
            input: { urls: ['x'] },
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'you-search',
            input: {},
          },
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
    const profile: ProfileRecord = {
      id: 'p1',
      userId: 'u',
      title: 't',
      locations: [],
      triggers: [],
    }
    expect(fallbackQuery(profile)).toBe('("supply chain" OR "disruption" OR "hazard" OR "strike")')
  })
})

describe('retrieveAndScore', () => {
  function stubTools() {
    const searchCalls: { query: string }[] = []
    const tools = {
      'you-search': {
        inputSchema: jsonSchema({ type: 'object' }),
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
                      ? [
                          shared,
                          {
                            url: 'https://hamburg.example/news',
                            snippet: 'Hamburg port strike',
                          },
                        ]
                      : [
                          shared,
                          {
                            url: 'https://rotterdam.example/news',
                            snippet: 'Rotterdam delays',
                          },
                        ],
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
          keys.map((key) => [
            key,
            {
              type: 'score',
              score: scores[index++ % scores.length] ?? 1,
              confidence: 0.9,
            },
          ]),
        )
        return Promise.resolve({ answers }) as never
      },
    } as unknown as SystemOneCaller
  }

  // Regression: the real You.com MCP you-search returns
  // { results: { web: [...] } } with `description` (not a flat array with
  // `snippet`). retrieveAndScore once iterated the raw object and crashed
  // with "TypeError: {} is not iterable".
  test('Gate 3 scores against the real profile, not an empty literal', async () => {
    const profilesSeen: unknown[] = []
    const tools = {
      'you-search': {
        inputSchema: jsonSchema({ type: 'object' }),
        async execute() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: { web: [{ url: 'https://x.example/a', description: 'finding' }] },
                }),
              },
            ],
          }
        },
      },
    }
    const db = openDb(tempDbPath())
    const deps = {
      client: { tools: () => Promise.resolve(tools) } as never,
      jev: {
        systemOne(request: unknown) {
          profilesSeen.push((request as { state?: { profile?: unknown } }).state?.profile)
          return Promise.resolve({
            answers: Object.fromEntries(
              Object.keys((request as { questions: Record<string, unknown> }).questions).map((k) => [
                k,
                { type: 'score', score: 2, confidence: 0.9 },
              ]),
            ),
          }) as never
        },
      } as unknown as SystemOneCaller,
      db,
      userId: 'local-user',
      profile: { id: 'p-real', userId: 'local-user', title: 'Real profile', locations: [], triggers: [] },
    }
    await retrieveAndScore(deps, ['query one'], {
      id: 'p-real',
      userId: 'local-user',
      title: 'Real profile',
      locations: ['Hamburg Port'],
      triggers: ['strikes'],
    })
    expect(profilesSeen.length).toBeGreaterThan(0)
    for (const profile of profilesSeen) {
      expect(profile).toMatchObject({ title: 'Real profile', id: 'p-real' })
    }
    db.close()
  })

  test('normalizes the real you-search shape (nested results.web, description)', async () => {
    const searchInputs: Record<string, unknown>[] = []
    const tools = {
      'you-search': {
        inputSchema: jsonSchema({ type: 'object' }),
        async execute(input: Record<string, unknown>) {
          searchInputs.push(input)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: {
                    web: [
                      {
                        url: 'https://maritime-executive.com/strike',
                        title: 'Port strike',
                        description: 'Dutch union sets national strike',
                      },
                    ],
                    news: [
                      {
                        url: 'https://news.example/port',
                        description: 'Rotterdam delays',
                      },
                    ],
                    knowledge: [
                      {
                        type: 'answer',
                        title: 'Rotterdam port throughput (Monthly)',
                        description: 'Latest throughput was 14.6M TEU in Aug 2026.',
                        attribution: [{ name: 'Fiscal.ai' }],
                      },
                    ],
                  },
                }),
              },
            ],
          }
        },
      },
    }
    const db = openDb(tempDbPath())
    const deps = {
      client: { tools: () => Promise.resolve(tools) } as never,
      jev: createJev(jevStub([2.5])),
      db,
      userId: 'local-user',
      profile: { id: 'p1', userId: 'local-user', title: 'EU port operations', locations: [], triggers: [] },
    }
    const scored = await retrieveAndScore(deps, ['Rotterdam port strike'])
    // Stage 3 must request knowledge — these are the results that reach synthesis
    expect(searchInputs.every((input) => input.knowledge === 'core')).toBe(true)
    // knowledge fact (no url) is retained as a scoring candidate
    expect(scored.map((r) => r.url)).toEqual(['https://maritime-executive.com/strike', 'https://news.example/port', ''])
    expect(scored[2]?.snippet).toContain('14.6M TEU')
    // description promoted to snippet
    expect(scored[0]?.snippet).toBe('Dutch union sets national strike')
    db.close()
  })

  test('runs queries concurrently, dedupes by URL, scores, and persists utility', async () => {
    const { tools, searchCalls } = stubTools()
    const client = { tools: () => Promise.resolve(tools) } as never
    const db = openDb(tempDbPath())
    const deps = {
      client,
      jev: createJev(jevStub([2.5, 0.5])),
      db,
      userId: 'local-user',
      profile: { id: 'p1', userId: 'local-user', title: 'EU port operations', locations: [], triggers: [] },
    }
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

function stubContentTools() {
  const contentsCalls: { urls: string[] }[] = []
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
                    snippet: 'Hamburg port strike halts ferries',
                  },
                  {
                    type: 'answer',
                    title: 'Hamburg port throughput (Monthly)',
                    description: 'Latest throughput 1.2M TEU.',
                    attribution: [{ name: 'Fiscal.ai' }],
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
      async execute(input: { urls: string[] }) {
        contentsCalls.push({ urls: input.urls })
        return {
          content: [
            {
              type: 'text',
              text: `# Article\n\nFull markdown for ${input.urls.join(', ')}`,
            },
          ],
        }
      },
    },
  }
  return { tools, contentsCalls }
}

function jevForDeepDive(relevancyScore: number) {
  return {
    systemOne(request: unknown) {
      const questions = (request as { questions: Record<string, unknown> }).questions
      const answers: Record<string, unknown> = {}
      for (const key of Object.keys(questions)) {
        answers[key] =
          key === 'severity'
            ? { type: 'choice', choice: 'critical', confidence: 0.9 }
            : { type: 'score', score: relevancyScore, confidence: 0.8 }
      }
      return Promise.resolve({ answers }) as never
    },
  } as unknown as SystemOneCaller
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const response = { id: 'mock-1', timestamp: new Date(), modelId: 'mock' }

describe('deepDive', () => {
  test('runs the full pipeline: proposal loop, retrieval, scoring, contents, synthesis', async () => {
    const { tools, contentsCalls } = stubContentTools()
    const db = openDb(tempDbPath())
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'you-search',
              input: { query: 'Hamburg Port strike' } as never,
            },
          ],
          finishReason: 'tool-calls' as never,
          usage,
          response,
          warnings: [],
        },
        {
          // wrap-up step of the proposal loop (loop ends here: 'stop')
          content: [{ type: 'text', text: 'Searches complete.' }],
          finishReason: 'stop' as never,
          usage,
          response,
          warnings: [],
        },
        {
          // separate synthesis generateText call
          content: [{ type: 'text', text: '## Summary\n\nExecutive briefing.' }],
          finishReason: 'stop' as never,
          usage,
          response,
          warnings: [],
        },
      ],
    })

    const result = await deepDive(
      {
        model: model as never,
        client: { tools: () => Promise.resolve(tools) } as never,
        jev: createJev(jevForDeepDive(2.5)),
        db,
        userId: 'local-user',
        profile: {
          id: 'p1',
          userId: 'local-user',
          title: 'EU port operations',
          locations: ['Hamburg Port'],
          triggers: ['strike action'],
        },
      },
      {
        id: 'p1',
        userId: 'local-user',
        title: 'EU port operations',
        locations: ['Hamburg Port'],
        triggers: ['strike action'],
      },
    )

    expect(result.severity).toBe('critical')
    // the url-less knowledge fact reached synthesis — count it in the outcome
    expect(result.knowledgeHits).toBe(1)
    expect(result.reportMarkdown).toContain('Executive briefing.')
    // contents fetched for the scored result's URL
    expect(contentsCalls).toEqual([{ urls: ['https://hamburg.example/news'] }])
    // utility persisted
    const row = db
      .query<{ score: number }, [string]>('SELECT score FROM source_utility WHERE domain = ?')
      .get('hamburg.example')
    expect(row?.score).toBeCloseTo(2.5, 5)
    db.close()
  })

  test('caps the synthesis prompt budget when article contents are huge', async () => {
    // Regression: fetchContents once joined full page text unbounded; 10 real
    // pages produced a ~212k-token synthesis prompt (the era's 131k-context
    // model capped at 131k). Markers deep inside a giant page prove truncation happened.
    // Marker sits at ~11k chars: past the 12k per-page cap's cut is at 12k,
    // so it must be beyond 12k. Place at 13k.
    const hugePage = `${'A'.repeat(13_000)}PAGE-MARKER-13K${'B'.repeat(100_000)}`
    const tools = {
      'you-search': {
        inputSchema: jsonSchema({ type: 'object' }),
        async execute() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: [{ url: 'https://hamburg.example/news', snippet: 'strike' }],
                }),
              },
            ],
          }
        },
      },
      'you-contents': {
        inputSchema: jsonSchema({ type: 'object' }),
        async execute() {
          return { content: [{ type: 'text', text: hugePage }] }
        },
      },
    }
    const db = openDb(tempDbPath())
    let generateCall = 0
    let synthesisPrompt = ''
    const model = new MockLanguageModelV4({
      doGenerate: (async (options: { prompt?: unknown }) => {
        generateCall++
        if (generateCall === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'you-search',
                input: { query: 'Hamburg Port strike' } as never,
              },
            ],
            finishReason: 'tool-calls' as never,
            usage,
            response,
            warnings: [],
          }
        }
        synthesisPrompt = JSON.stringify(options?.prompt ?? '')
        return {
          content: [{ type: 'text', text: '## Summary\n\nok.' }],
          finishReason: 'stop' as never,
          usage,
          response,
          warnings: [],
        }
      }) as never,
    })

    await deepDive(
      {
        model: model as never,
        client: { tools: () => Promise.resolve(tools) } as never,
        jev: createJev(jevForDeepDive(2.5)),
        db,
        userId: 'local-user',
        profile: {
          id: 'p1',
          userId: 'local-user',
          title: 'EU port operations',
          locations: ['Hamburg Port'],
          triggers: ['strike action'],
        },
      },
      {
        id: 'p1',
        userId: 'local-user',
        title: 'EU port operations',
        locations: ['Hamburg Port'],
        triggers: ['strike action'],
      },
    )

    // The page is ~113k chars; the per-page cap (12k) must have truncated it:
    // the 13k-char marker never reaches the prompt.
    expect(synthesisPrompt).not.toContain('PAGE-MARKER-13K')
    // ...but the page head does, proving content still flows through.
    expect(synthesisPrompt).toContain('AAAA')
    db.close()
  })

  test('injects the fallback template when the loop yields no queries', async () => {
    const { tools } = stubContentTools()
    const searchInputs: { query?: unknown }[] = []
    const wrappedTools = {
      ...tools,
      'you-search': {
        ...tools['you-search'],
        async execute(input: { query?: unknown }) {
          searchInputs.push(input)
          return { content: [{ type: 'text', text: '{"results": []}' }] }
        },
      },
    }
    const db = openDb(tempDbPath())
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: 'text', text: 'no searches needed' }],
          finishReason: 'stop' as never,
          usage,
          response,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: '## Summary\n\nNothing found.' }],
          finishReason: 'stop' as never,
          usage,
          response,
          warnings: [],
        },
      ],
    })

    const result = await deepDive(
      {
        model: model as never,
        client: { tools: () => Promise.resolve(wrappedTools) } as never,
        jev: createJev(jevForDeepDive(1)),
        db,
        userId: 'local-user',
        profile: {
          id: 'p1',
          userId: 'local-user',
          title: 'EU port operations',
          locations: ['Hamburg Port'],
          triggers: ['strike action'],
        },
      },
      {
        id: 'p1',
        userId: 'local-user',
        title: 'EU ports',
        locations: ['Hamburg Port'],
        triggers: ['strikes'],
      },
    )

    expect(searchInputs[0]?.query).toBe('"Hamburg Port" AND ("supply chain" OR "disruption" OR "hazard" OR "strike")')
    expect(result.reportMarkdown).toContain('Nothing found.')
    db.close()
  })
})

describe('parseSearchResults knowledge handling', () => {
  test('url-less knowledge results (licensed facts) survive normalization with an empty url', async () => {
    const { parseSearchResults } = await import('../services/you.ts')
    const text = JSON.stringify({
      results: {
        web: [{ url: 'https://x.example/a', title: 'page', description: 'a page' }],
        knowledge: [
          {
            type: 'answer',
            title: 'NVIDIA Total Revenues (Quarterly)',
            description: 'Latest value was $96,221,000,000 for fiscal Q2 2027.',
            attribution: [{ name: 'Fiscal.ai' }],
          },
        ],
      },
    })
    const results = parseSearchResults(text)
    const knowledge = results.find((r) => r.title.startsWith('NVIDIA'))
    expect(knowledge).toBeDefined()
    expect(knowledge?.url).toBe('') // non-fetchable fact: no page to crawl
    expect(knowledge?.description).toContain('$96,221,000,000')
    // web results untouched
    expect(results.find((r) => r.url === 'https://x.example/a')).toBeDefined()
  })
})
