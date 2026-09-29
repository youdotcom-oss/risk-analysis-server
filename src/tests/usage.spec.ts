import { describe, expect, test } from 'bun:test'
import { jsonSchema } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from '../db.ts'
import { deepDive } from '../pipeline/deep-dive.ts'
import type { SystemOneCaller } from '../services/jev.ts'
import { createJev } from '../services/jev.ts'
import { createJevJudge } from '../services/judge.ts'
import { buildSweepUsage, createSweepUsage, trackJevUsage } from '../services/usage.ts'
import { createProposalTools } from '../services/you.ts'

// scoreResults must tally nothing itself (it's Jev-side, tracked via
// trackJevUsage), but the wrapper used in production is the composed one.
describe('buildSweepUsage', () => {
  test('wraps jev tracking and starts all counters at zero', () => {
    const usage = createSweepUsage()
    const tracked = buildSweepUsage(createJev(callerWithUsage([])), usage)
    expect(typeof tracked.systemOne).toBe('function')
    expect(usage).toEqual({
      jevInputTokens: 0,
      jevOutputTokens: 0,
      searchCalls: 0,
      contentsCalls: 0,
      judgeInputTokens: 0,
      judgeOutputTokens: 0,
      judgeMalformed: 0,
    })
  })
})

describe('deepDive usage counters', () => {
  test('counts search and contents calls across proposal, retrieval, and fetch', async () => {
    const usage = createSweepUsage()
    const { deps } = makeDeepDiveDeps(usage)

    await deepDive(deps, {
      id: 'p1',
      userId: 'local-user',
      title: 'EU port operations',
      locations: ['Hamburg Port'],
      triggers: ['strike action'],
    })

    // The mock model emits a tool-call without executing it, so stage 3
    // runs the harvested proposal query + the raw trigger = 2 searches;
    // the proposal-loop wrapper itself is covered directly below.
    expect(usage.searchCalls).toBe(2)
    expect(usage.contentsCalls).toBe(1)
    // scoring + severity rode through the tracked jev client
    expect(usage.jevInputTokens).toBeGreaterThan(0)
    expect(usage.jevOutputTokens).toBeGreaterThan(0)
  })

  test('proposal recorder never executes searches — execution moves to the budgeted stage', async () => {
    const usage = createSweepUsage()
    const { deps, rawSearchCalls } = makeDeepDiveDeps(usage)
    void deps

    const tools = createProposalTools() as Record<
      string,
      { execute: (input: Record<string, unknown>) => Promise<unknown> }
    >
    const result = await (tools.propose_query as { execute: (i: Record<string, unknown>) => Promise<unknown> }).execute(
      { query: 'Hamburg Port strike' },
    )
    expect((result as { content: { text: string }[] }).content[0]?.text).toContain('Recorded')
    expect(usage.searchCalls).toBe(0)
    expect(rawSearchCalls).toBe(0)
  })
})

function makeDeepDiveDeps(usage: ReturnType<typeof createSweepUsage>) {
  let rawSearchCalls = 0
  const tools = {
    'you-search': {
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      async execute(input: Record<string, unknown>) {
        void input
        rawSearchCalls += 1
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [{ url: `https://hamburg.example/${rawSearchCalls}`, snippet: 'Hamburg port strike' }],
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
  const rawJev = {
    systemOne(request: unknown) {
      const questions = Object.keys((request as { questions: Record<string, unknown> }).questions)
      const answers = Object.fromEntries(
        questions.map((key) =>
          key === 'severity'
            ? [key, { type: 'choice', choice: 'medium', confidence: 0.9 }]
            : key.startsWith('q')
              ? [key, { type: 'noul', noul: 0.9 }]
              : [key, { type: 'score', score: 2, confidence: 0.8 }],
        ),
      )
      return Promise.resolve({ answers, usage: { input_tokens: 10, output_tokens: 2 } }) as never
    },
  } as unknown as SystemOneCaller
  const judge = createJevJudge(createJev(rawJev))
  const usage_meta = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
  const response = { id: 'mock-1', timestamp: new Date(), modelId: 'mock' }
  const mockResult = (content: unknown, finishReason: string) =>
    ({ content, finishReason, usage: usage_meta, response, warnings: [] }) as never
  const model = new MockLanguageModelV4({
    doGenerate: [
      mockResult(
        [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'you-search',
            input: JSON.stringify({ query: 'Hamburg Port strike' }) as never,
          },
        ],
        'tool-calls' as never,
      ),
      mockResult([{ type: 'text', text: 'Searches complete.' }], 'stop' as never),
      mockResult([{ type: 'text', text: 'Briefing' }], 'stop' as never),
    ],
  })
  const deps = {
    client: { tools: () => Promise.resolve(tools) } as never,
    judge,
    db: openDb(':memory:'),
    userId: 'local-user',
    model: model as never,
    profile: {
      id: 'p1',
      userId: 'local-user',
      title: 'EU port operations',
      locations: ['Hamburg Port'],
      triggers: ['strike action'],
    },
    usage,
  } as never
  return {
    deps,
    judge,
    get rawSearchCalls() {
      return rawSearchCalls
    },
  }
}

function callerWithUsage(calls: { input_tokens: number; output_tokens: number }[]) {
  let index = 0
  return {
    systemOne(request: unknown) {
      void request
      const usage = calls[Math.min(index, calls.length - 1)]
      index += 1
      return Promise.resolve({
        answers: { threat: { type: 'noul', noul: 0.5 } },
        usage,
      })
    },
  } as unknown as SystemOneCaller
}

describe('trackJevUsage', () => {
  test('accumulates token usage across systemOne calls and forwards answers', async () => {
    const usage = createSweepUsage()
    const jev = trackJevUsage(
      callerWithUsage([
        { input_tokens: 100, output_tokens: 10 },
        { input_tokens: 30, output_tokens: 5 },
      ]),
      usage,
    )

    const first = await jev.systemOne({ questions: { threat: {} } } as never)
    const second = await jev.systemOne({ questions: { threat: {} } } as never)

    expect((first.answers.threat as { noul: number }).noul).toBe(0.5)
    expect((second.answers.threat as { noul: number }).noul).toBe(0.5)
    expect(usage.jevInputTokens).toBe(130)
    expect(usage.jevOutputTokens).toBe(15)
  })

  test('treats a missing usage block as zero instead of crashing the sweep', async () => {
    const usage = createSweepUsage()
    const jev = trackJevUsage(callerWithUsage([undefined as never]), usage)

    await jev.systemOne({ questions: { threat: {} } } as never)

    expect(usage.jevInputTokens).toBe(0)
    expect(usage.jevOutputTokens).toBe(0)
  })
})

describe('createSweepUsage', () => {
  test('starts every ledger at zero', () => {
    expect(createSweepUsage()).toEqual({
      jevInputTokens: 0,
      jevOutputTokens: 0,
      searchCalls: 0,
      contentsCalls: 0,
      judgeInputTokens: 0,
      judgeOutputTokens: 0,
      judgeMalformed: 0,
    })
  })
})
