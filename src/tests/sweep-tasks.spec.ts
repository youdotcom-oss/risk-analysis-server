import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelSweepTask, completeSweepTask, createSweepTask, failSweepTask, getSweepTask, openDb } from '../db.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

function seededDb() {
  const db = openDb(tempDbPath())
  db.query(
    `INSERT INTO risk_profiles (id, user_id, title, locations, policy_triggers, updated_at)
     VALUES ('p1', 'local-user', 'Ports', '["Hamburg Port"]', '["strikes"]', $now)`,
  ).run({ now: Date.now() })
  return db
}

describe('sweep task lifecycle', () => {
  test('create persists a working task before any result exists', () => {
    const db = seededDb()
    createSweepTask(db, { taskId: 't1', userId: 'local-user', profileId: 'p1', ttlMs: 60_000 })
    const task = getSweepTask(db, 't1')
    expect(task?.status).toBe('working')
    expect(task?.profile_id).toBe('p1')
    expect(task?.result_json).toBeNull()
    expect(task?.ttl_at).toBeGreaterThan(Date.now())
    db.close()
  })

  test('complete stores the result payload', () => {
    const db = seededDb()
    createSweepTask(db, { taskId: 't2', userId: 'local-user', profileId: 'p1', ttlMs: 60_000 })
    completeSweepTask(db, 't2', { severity: 'low', reportId: 'r1' })
    const task = getSweepTask(db, 't2')
    expect(task?.status).toBe('completed')
    expect(JSON.parse(task?.result_json ?? 'null')).toEqual({ severity: 'low', reportId: 'r1' })
    db.close()
  })

  test('fail stores the error; unknown ids are no-ops; cancel is terminal', () => {
    const db = seededDb()
    failSweepTask(db, 'no-such-task', { code: -32000, message: 'boom' }) // unknown id: no-op, no throw

    createSweepTask(db, { taskId: 't3', userId: 'local-user', profileId: 'p1', ttlMs: 60_000 })
    failSweepTask(db, 't3', { code: -32000, message: 'jev unavailable' })
    expect(getSweepTask(db, 't3')?.status).toBe('failed')
    expect(getSweepTask(db, 't3')?.error_json).toContain('jev unavailable')

    cancelSweepTask(db, 't3')
    const terminal = getSweepTask(db, 't3')
    expect(terminal?.status).toBe('failed') // failed is terminal: cancel is a cooperative no-op
    db.close()
  })

  test('expired tasks read as null', () => {
    const db = seededDb()
    createSweepTask(db, { taskId: 't4', userId: 'local-user', profileId: 'p1', ttlMs: -1 })
    expect(getSweepTask(db, 't4')).toBeNull()
    db.close()
  })
})
