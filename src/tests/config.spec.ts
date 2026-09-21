import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDbPath, missingKeyWarnings } from '../config.ts'

const savedEnv = { ...process.env }
afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key in savedEnv) continue
    delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

describe('defaultDbPath', () => {
  test('uses XDG_DATA_HOME and creates the directory', () => {
    const root = join(import.meta.dir, 'tmp-defaultdbpath')
    const path = defaultDbPath({ XDG_DATA_HOME: root })
    expect(path).toBe(join(root, 'risk-analysis-server', 'risk.sqlite'))
    expect(existsSync(join(root, 'risk-analysis-server'))).toBe(true)
  })
})

describe('missingKeyWarnings', () => {
  test('warns for each missing key with its consequence', () => {
    delete process.env.YDC_API_KEY
    delete process.env.TYPESAFE_API_KEY
    const warnings = missingKeyWarnings()
    expect(warnings).toHaveLength(2)
    expect(warnings.some((w) => w.includes('YDC_API_KEY') && w.includes('free tier'))).toBe(true)
    expect(warnings.some((w) => w.includes('TYPESAFE_API_KEY') && w.includes('Jev'))).toBe(true)
  })

  test('returns no warnings when all keys are set', () => {
    process.env.YDC_API_KEY = 'sentinel-ydc-value'
    process.env.TYPESAFE_API_KEY = 'sentinel-typesafe-value'
    expect(missingKeyWarnings()).toEqual([])
  })

  test('warnings name keys but never echo their values', () => {
    delete process.env.YDC_API_KEY
    process.env.TYPESAFE_API_KEY = 'sentinel-typesafe-value'
    const warnings = missingKeyWarnings()
    for (const warning of warnings) {
      expect(warning).not.toContain('sentinel-ydc-value')
      expect(warning).not.toContain('sentinel-typesafe-value')
    }
  })
})
