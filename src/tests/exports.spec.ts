import { describe, expect, test } from 'bun:test'
import { buildMcpServer } from '@youdotcom-oss/risk-analysis-server/mcp'
import { buildSweepDeps, runSweep } from '@youdotcom-oss/risk-analysis-server/pipeline'
import { createApp } from '@youdotcom-oss/risk-analysis-server/server'

describe('package exports (import flow)', () => {
  test('consumers can import the building blocks via the package surface', () => {
    expect(typeof createApp).toBe('function')
    expect(typeof buildMcpServer).toBe('function')
    expect(typeof buildSweepDeps).toBe('function')
    expect(typeof runSweep).toBe('function')
  })
})
