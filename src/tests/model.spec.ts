import { afterAll, describe, expect, test } from 'bun:test'
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
  test('returns the default ollama muse-glimmer model', () => {
    delete process.env.RISK_MODEL
    const model = getModel()
    expect(model.provider).toBe('ollama')
    expect(model.modelId).toBe('muse-glimmer')
  })

  test('honors RISK_MODEL override', () => {
    process.env.RISK_MODEL = 'llama3'
    const model = getModel()
    expect(model.modelId).toBe('llama3')
  })
})
