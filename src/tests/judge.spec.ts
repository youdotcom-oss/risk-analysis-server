import { describe, expect, test } from 'bun:test'
import type { RiskProfile, SystemOneCaller } from '../services/jev.ts'
import { createJevJudge } from '../services/judge.ts'
import { createSweepUsage } from '../services/usage.ts'

const profile: RiskProfile = {
  title: 'EU port operations',
  locations: ['Hamburg Port'],
  triggers: ['strike action'],
}

function callerWithUsage(answers: Record<string, unknown>) {
  return {
    systemOne(request: unknown) {
      void request
      return Promise.resolve({ answers, usage: { input_tokens: 100, output_tokens: 10 } })
    },
  } as unknown as SystemOneCaller
}

describe('createJevJudge', () => {
  test('triage forwards profile and highlights, returns the noul, tallies usage', async () => {
    const usage = createSweepUsage()
    const judge = createJevJudge(callerWithUsage({ threat: { type: 'noul', noul: 0.83 } }))

    const threat = await judge.triage(profile, ['Dockers strike announced'], usage)

    expect(threat).toBe(0.83)
    expect(usage.jevInputTokens).toBe(100)
    expect(usage.jevOutputTokens).toBe(10)
  })

  test('rank returns candidates best-first and tallies usage', async () => {
    const usage = createSweepUsage()
    const judge = createJevJudge(
      callerWithUsage({
        q0: { type: 'noul', noul: 0.9 },
        q1: { type: 'noul', noul: 0.2 },
      }),
    )

    const ranked = await judge.rankQueries(profile, ['q0', 'q1'], usage)

    expect(ranked).toEqual([
      { query: 'q0', noul: 0.9 },
      { query: 'q1', noul: 0.2 },
    ])
    expect(usage.jevInputTokens).toBe(100)
  })

  test('score tallies usage and applies the provenance boost to licensed facts', async () => {
    const usage = createSweepUsage()
    const judge = createJevJudge(
      callerWithUsage({
        r0: { type: 'score', score: 1, confidence: 0.8 },
        r1: { type: 'score', score: 1, confidence: 0.8 },
      }),
    )

    const scored = await judge.scoreResults(
      profile,
      [
        { url: 'https://a.example', snippet: 'strike' },
        { url: '', snippet: 'licensed fact', attribution: ['S&P Global'] },
      ],
      usage,
    )

    expect(scored[0]!.score).toBe(1)
    expect(scored[1]!.score).toBe(2) // knowledge boost
    expect(usage.jevInputTokens).toBe(100)
  })

  test('severity picks from the fixed levels and tallies usage', async () => {
    const usage = createSweepUsage()
    const judge = createJevJudge(callerWithUsage({ severity: { type: 'choice', choice: 'critical', confidence: 0.9 } }))

    const severity = await judge.assessSeverity(profile, [], usage)

    expect(severity).toBe('critical')
    expect(usage.jevInputTokens).toBe(100)
  })
})

import { MockLanguageModelV4 } from 'ai/test'
import { createQwenJudge } from '../services/qwen-judge.ts'

const usageMeta = {
  inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
}
const response = { id: 'mock', timestamp: new Date(), modelId: 'mock' }
const mockResult = (text: string) =>
  ({
    content: [{ type: 'text', text }],
    finishReason: 'stop' as never,
    usage: usageMeta,
    response,
    warnings: [],
  }) as never

function qwenModel(responses: string[]) {
  return new MockLanguageModelV4({ doGenerate: responses.map((text) => mockResult(text)) })
}

describe('createQwenJudge', () => {
  test('triage parses strict JSON and tallies judge tokens', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(qwenModel(['{"threat": 0.72}']) as never)

    const threat = await judge.triage(profile, ['Dockers strike announced'], usage)

    expect(threat).toBe(0.72)
    expect(usage.judgeInputTokens).toBe(500)
    expect(usage.judgeOutputTokens).toBe(40)
    expect(usage.judgeMalformed).toBe(0)
  })

  test('triage tolerates markdown-fenced JSON', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(qwenModel(['```json\n{"threat": 0.4}\n```']) as never)

    expect(await judge.triage(profile, ['quiet day'], usage)).toBe(0.4)
  })

  test('malformed JSON is counted and fails loudly, not silently guessed', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(qwenModel(['I think the threat is high.']) as never)

    await expect(judge.triage(profile, ['x'], usage)).rejects.toThrow(/JSON/)
    expect(usage.judgeMalformed).toBe(1)
  })

  test('rank parses scored candidates and returns best-first', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(
      qwenModel(['{"scores": [{"query": "q0", "noul": 0.3}, {"query": "q1", "noul": 0.95}]}']) as never,
    )

    expect(await judge.rankQueries(profile, ['q0', 'q1'], usage)).toEqual([
      { query: 'q1', noul: 0.95 },
      { query: 'q0', noul: 0.3 },
    ])
  })

  test('rank rejects an answer that does not cover every candidate', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(qwenModel(['{"scores": [{"query": "q0", "noul": 0.3}]}']) as never)

    await expect(judge.rankQueries(profile, ['q0', 'q1'], usage)).rejects.toThrow(/q1/)
  })

  test('score applies the same rubric + provenance boost as the Jev judge', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(
      qwenModel(['{"scores": [{"index": 0, "score": 1}, {"index": 1, "score": 1}]}']) as never,
    )

    const scored = await judge.scoreResults(
      profile,
      [
        { url: 'https://a.example', snippet: 'strike' },
        { url: '', snippet: 'licensed fact', attribution: ['S&P Global'] },
      ],
      usage,
    )

    expect(scored[0]!.score).toBe(1)
    expect(scored[1]!.score).toBe(2)
  })

  test('severity parses a valid choice and rejects an invalid one', async () => {
    const usage = createSweepUsage()
    const judge = createQwenJudge(qwenModel(['{"severity": "medium"}']) as never)
    expect(await judge.assessSeverity(profile, [], usage)).toBe('medium')

    const bad = createQwenJudge(qwenModel(['{"severity": "apocalyptic"}']) as never)
    await expect(bad.assessSeverity(profile, [], usage)).rejects.toThrow(/severity/)
  })
})
