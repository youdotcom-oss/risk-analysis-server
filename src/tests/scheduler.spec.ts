import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSweepTask, openDb, saveProfile, setSweepSchedule } from '../db.ts'
import { type CronHandle, isValidCron, ProfileScheduler } from '../scheduler.ts'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDb() {
  const dir = mkdtempSync(`${tmpdir()}/risk-scheduler-`)
  tmpDirs.push(dir)
  return openDb(join(dir, 'risk.sqlite'))
}

class FakeRegistrar {
  jobs = new Map<string, () => unknown>()
  register(expression: string, fn: () => unknown): CronHandle {
    this.jobs.set(expression, fn)
    return { stop: () => this.jobs.delete(expression) }
  }
}

describe('isValidCron', () => {
  test('accepts 5- and 6-field expressions, rejects garbage', () => {
    expect(isValidCron('*/30 * * * *')).toBe(true)
    expect(isValidCron('0 12 * * 1')).toBe(true)
    expect(isValidCron('0 0 * * * 1-5')).toBe(true)
    expect(isValidCron('every hour')).toBe(false)
    expect(isValidCron('* * *')).toBe(false)
    expect(isValidCron('')).toBe(false)
  })
})

describe('ProfileScheduler', () => {
  test('apply registers the cron under the profile id; clear stops it', () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    const registrar = new FakeRegistrar()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => registrar.register(expr, fn),
      sweep: async () => ({ escalated: false }),
    })
    scheduler.apply('p1', '*/30 * * * *')
    expect(registrar.jobs.has('*/30 * * * *')).toBe(true)
    scheduler.clear('p1')
    expect(registrar.jobs.has('*/30 * * * *')).toBe(false)
    db.close()
  })

  test('invalid expression throws before registering', () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    const registrar = new FakeRegistrar()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => registrar.register(expr, fn),
      sweep: async () => ({ escalated: false }),
    })
    expect(() => scheduler.apply('p1', 'whenever')).toThrow('Invalid cron expression')
    expect(registrar.jobs.size).toBe(0)
    db.close()
  })

  test('sweepProfile honors the recent-run guard', async () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    let sweeps = 0
    const jobs = new Map<string, () => unknown>()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => {
        jobs.set(expr, fn)
        return { stop: () => jobs.delete(expr) }
      },
      sweep: async () => {
        sweeps++
        return { escalated: false }
      },
    })
    scheduler.apply('p1', '* * * * *')
    const fire = jobs.get('* * * * *')!
    // fire the cron body twice back-to-back: the recent-run window (10 min)
    // must collapse the second into a no-op
    await fire()
    await fire()
    expect(sweeps).toBe(1)
    db.close()
  })

  test('applyStored registers every profile with a stored schedule', () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 'a', locations: [], triggers: [] })
    saveProfile(db, { id: 'p2', userId: 'local-user', title: 'b', locations: [], triggers: [] })
    setSweepSchedule(db, 'p1', '0 9 * * *')
    const registrar = new FakeRegistrar()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => registrar.register(expr, fn),
      sweep: async () => ({ escalated: false }),
    })
    scheduler.applyStored()
    expect(registrar.jobs.has('0 9 * * *')).toBe(true)
    expect(registrar.jobs.size).toBe(1) // p2 has no schedule
    db.close()
  })
})

describe('ProfileScheduler.applyStored', () => {
  test('a profile whose cron Bun rejects is skipped with a log, not a startup crash', () => {
    const db = tempDb()
    saveProfile(db, { id: 'p-ok', userId: 'local-user', title: 'ok', locations: [], triggers: [] })
    saveProfile(db, { id: 'p-bad', userId: 'local-user', title: 'bad', locations: [], triggers: [] })
    setSweepSchedule(db, 'p-ok', '0 9 * * 1')
    setSweepSchedule(db, 'p-bad', 'a b c d e') // passes isValidCron, Bun.cron rejects
    const registrar = new FakeRegistrar()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => {
        if (expr === 'a b c d e') throw new Error('Invalid cron expression: value out of range for field')
        return registrar.register(expr, fn)
      },
      sweep: async () => ({ escalated: false }),
    })
    expect(() => scheduler.applyStored()).not.toThrow()
    expect(registrar.jobs.has('0 9 * * 1')).toBe(true) // good profile still applied
    db.close()
  })
})

describe('ProfileScheduler.sweepProfile failure path', () => {
  test('a failing sweep stores a diagnosable error, not {}', async () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    const jobs = new Map<string, () => unknown>()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => {
        jobs.set(expr, fn)
        return { stop: () => jobs.delete(expr) }
      },
      sweep: async () => {
        throw new Error('OpenRouter 503 no healthy upstream')
      },
    })
    scheduler.apply('p1', '* * * * *')
    await jobs.get('* * * * *')!()
    const row = db.query<{ error_json: string }, []>('SELECT error_json FROM sweep_tasks').get()
    const parsed = JSON.parse(row?.error_json ?? '{}') as { message?: string }
    expect(parsed.message).toContain('503')
    db.close()
  })
})

describe('task TTL semantics', () => {
  test('a completed result stays readable after the original TTL expires', async () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    const jobs = new Map<string, () => unknown>()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => {
        jobs.set(expr, fn)
        return { stop: () => jobs.delete(expr) }
      },
      sweep: async () => ({ escalated: true, severity: 'medium' }),
      ttlMs: 1,
    })
    scheduler.apply('p1', '* * * * *')
    // sweep takes longer than its own TTL window (ttlMs: 1): the completion
    // lands into an already-expired row — the result must still be readable
    await new Promise((resolve) => setTimeout(resolve, 5))
    await jobs.get('* * * * *')!()
    const taskId = db.query<{ task_id: string }, []>('SELECT task_id FROM sweep_tasks').get()?.task_id ?? ''
    const row = getSweepTask(db, taskId)
    expect(row?.status).toBe('completed')
    expect(row?.result_json).toContain('medium')
    db.close()
  })
})

describe('ProfileScheduler snapshot freshness', () => {
  test('cron fires read the profile as it is at fire time, not registration time', async () => {
    const db = tempDb()
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 'old title', locations: ['Salem'], triggers: [] })
    const seen: string[] = []
    const jobs = new Map<string, () => unknown>()
    const scheduler = new ProfileScheduler(db, 'local-user', {
      register: (expr, fn) => {
        jobs.set(expr, fn)
        return { stop: () => jobs.delete(expr) }
      },
      sweep: async (profile) => {
        seen.push(profile.title)
        return { escalated: false }
      },
    })
    scheduler.apply('p1', '* * * * *')
    // profile edited after registration
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 'new title', locations: ['Salem'], triggers: [] })
    await jobs.get('* * * * *')!()
    expect(seen).toEqual(['new title'])
    db.close()
  })
})
