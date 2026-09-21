import { afterAll, describe, expect, mock, test } from 'bun:test'
import { getModel } from '../model.ts'

const savedEnv = { ...process.env }
afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key in savedEnv) continue
    delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

describe('getModel', () => {
  test('throws a clear error without OPENROUTER_API_KEY', () => {
    delete process.env.OPENROUTER_API_KEY
    expect(() => getModel()).toThrow('OPENROUTER_API_KEY is required')
  })

  test('defaults to qwen/qwen3.8-27b on OpenRouter', () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    delete process.env.RISK_MODEL
    const model = getModel()
    expect(model.provider).toBe('openrouter')
    expect(model.modelId).toBe('qwen/qwen3.8-27b')
  })

  test('honors RISK_MODEL override', () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    process.env.RISK_MODEL = 'meta/muse-spark-1.3'
    const model = getModel()
    expect(model.provider).toBe('openrouter')
    expect(model.modelId).toBe('meta/muse-spark-1.3')
  })

  // Regression: the former ollama branch defaulted its base URL to
  // 'http://localhost:11434/api' while the SDK appended /api/chat itself,
  // yielding /api/api/chat -> 404. Wiring is behavior: assert the exact
  // request path the OpenRouter branch hits (never a doubled segment).
  test('openrouter branch posts to /api/v1/chat/completions', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key'
    delete process.env.RISK_MODEL
    const paths: string[] = []
    const savedFetch = globalThis.fetch
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname)
      return new Response(
        JSON.stringify({
          id: 'gen-1',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const { generateText } = await import('ai')
      await generateText({ model: getModel(), prompt: 'hi' })
    } finally {
      globalThis.fetch = savedFetch
    }
    expect(paths).toEqual(['/api/v1/chat/completions'])
  })
})
