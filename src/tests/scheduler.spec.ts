import { describe, expect, test } from 'bun:test'
import { openDb, saveProfile, setSweepSchedule } from '../db.ts'
import { type CronHandle, isValidCron, ProfileScheduler } from '../scheduler.ts'

function tempDb() {
  const db = openDb(`${import.meta.dir}/tmp-scheduler-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
  return db
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
