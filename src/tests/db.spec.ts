import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db.ts'

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
