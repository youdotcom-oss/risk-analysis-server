import { describe, expect, test } from 'bun:test'
import type { SystemOneCaller } from '../services/jev.ts'
import { createJev, scoreResults, triageThreat, validateQueries } from '../services/jev.ts'

const profile = {
  title: 'EU port operations',
  locations: ['Hamburg Port'],
  triggers: ['strike action', 'customs delay'],
}

function stubCaller(answer: number, captured: unknown[] = []) {
  const caller = {
    systemOne(request: unknown) {
      captured.push(request)
      return Promise.resolve({
        answers: { threat: { type: 'noul', noul: answer } },
      })
    },
  }
  return caller as unknown as SystemOneCaller
}

describe('triageThreat', () => {
  test('returns the Jev threat probability for profile + highlights', async () => {
    const captured: unknown[] = []
    const jev = createJev(stubCaller(0.83, captured))
    const threat = await triageThreat(jev, profile, ['Dockers strike announced'])
    expect(threat).toBe(0.83)
    const request = captured[0] as { state: Record<string, unknown> }
    expect(request.state.profile).toEqual(profile)
    expect(request.state.highlights).toEqual(['Dockers strike announced'])
  })
})

describe('validateQueries', () => {
  test('batches candidates into one call and filters by threshold', async () => {
    const captured: unknown[] = []
    const caller = {
      systemOne(request: unknown) {
        captured.push(request)
        return Promise.resolve({
          answers: {
            q0: { type: 'noul', noul: 0.9 },
            q1: { type: 'noul', noul: 0.2 },
            q2: { type: 'noul', noul: 0.55 },
          },
        })
      },
    } as unknown as SystemOneCaller
    const jev = createJev(caller)
    const verdicts = await validateQueries(jev, profile, ['q0', 'q1', 'q2'])
    expect(captured).toHaveLength(1)
    const request = captured[0] as { questions: Record<string, unknown> }
    expect(Object.keys(request.questions)).toEqual(['q0', 'q1', 'q2'])
    expect(verdicts).toEqual([
      { query: 'q0', accepted: true },
      { query: 'q1', accepted: false },
      { query: 'q2', accepted: true },
    ])
  })
})

describe('scoreResults', () => {
  test('scores each result against policy triggers in one call', async () => {
    const captured: unknown[] = []
    const caller = {
      systemOne(request: unknown) {
        captured.push(request)
        return Promise.resolve({
          answers: {
            r0: { type: 'score', score: 2.1, confidence: 0.8 },
            r1: { type: 'score', score: 0.3, confidence: 0.9 },
          },
        })
      },
    } as unknown as SystemOneCaller
    const scores = await scoreResults(caller, profile, [
      {
        url: 'https://a.example',
        snippet: 'Hamburg port strike halts operations',
      },
      { url: 'https://b.example', snippet: 'Local bakery opens downtown' },
    ])
    expect(captured).toHaveLength(1)
    const request = captured[0] as { state: Record<string, unknown> }
    expect(request.state.results).toHaveLength(2)
    expect(scores).toEqual([
      { url: 'https://a.example', snippet: 'Hamburg port strike halts operations', score: 2.1 },
      { url: 'https://b.example', snippet: 'Local bakery opens downtown', score: 0.3 },
    ])
  })
})
