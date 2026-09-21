import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getActiveProfiles, openDb, saveProfile, setSweepSchedule } from '../db.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

describe('openDb', () => {
  test('migrates all tables and is idempotent across reopens', () => {
    const path = tempDbPath()

    const first = openDb(path)
    const tables = first
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    expect(tables).toEqual(['risk_profiles', 'risk_reports', 'source_utility', 'sweep_tasks', 'users'])
    first.close()

    const second = openDb(path)
    const reopened = second.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    expect(reopened.all().map((row) => row.name)).toEqual(tables)
    second.close()
  })
  test('enables WAL mode on file-backed databases', () => {
    const db = openDb(tempDbPath())
    const row = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
    expect(row?.journal_mode).toBe('wal')
    db.close()
  })

  test('seeds the local-user row', () => {
    const db = openDb(tempDbPath())
    const user = db
      .query<{ id: string; email: string }, [string]>('SELECT id, email FROM users WHERE id = ?')
      .get('local-user')
    expect(user).toEqual({ id: 'local-user', email: 'local@localhost' })
    db.close()
  })

  test('strict mode throws on missing bind parameters', () => {
    const db = openDb(tempDbPath())
    expect(() =>
      db
        .query('SELECT $message') // deliberate typo in bind object: proves strict mode rejects it
        .get({ messag: 'hello' }),
    ).toThrow()
    db.close()
  })
})

describe('sweep schedules', () => {
  test('setSweepSchedule persists and getActiveProfiles returns it; null clears', () => {
    const db = openDb(tempDbPath())
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    setSweepSchedule(db, 'p1', '*/30 * * * *')
    expect(getActiveProfiles(db, 'local-user')[0]?.sweepSchedule).toBe('*/30 * * * *')
    setSweepSchedule(db, 'p1', null)
    expect(getActiveProfiles(db, 'local-user')[0]?.sweepSchedule).toBeNull()
    db.close()
  })

  test('openDb migrates a pre-schedule database (ALTER TABLE path)', () => {
    // simulate an old DB: schema without sweep_schedule
    const path = tempDbPath()
    const legacy = new Database(path, { strict: true })
    legacy.run(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL)`)
    legacy.run(`CREATE TABLE risk_profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
      locations TEXT NOT NULL, policy_triggers TEXT NOT NULL,
      is_active INTEGER DEFAULT 1, updated_at INTEGER NOT NULL)`)
    legacy.close()
    const db = openDb(path)
    saveProfile(db, { id: 'p1', userId: 'local-user', title: 't', locations: [], triggers: [] })
    setSweepSchedule(db, 'p1', '0 12 * * 1')
    expect(getActiveProfiles(db, 'local-user')[0]?.sweepSchedule).toBe('0 12 * * 1')
    db.close()
  })
})
