import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, updateSourceUtility } from '../db.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

describe('updateSourceUtility', () => {
  test('upserts domain scores for a user in one transaction', () => {
    const db = openDb(tempDbPath())
    updateSourceUtility(db, 'local-user', [
      { domain: 'reuters.com', delta: 0.4 },
      { domain: 'blogspam.io', delta: -0.6 },
    ])
    const rows = db
      .query<{ domain: string; score: number }, []>('SELECT domain, score FROM source_utility ORDER BY domain')
      .all()
    expect(rows).toEqual([
      { domain: 'blogspam.io', score: expect.closeTo(0.4, 5) },
      { domain: 'reuters.com', score: expect.closeTo(1.4, 5) },
    ])

    // second application compounds from current scores
    updateSourceUtility(db, 'local-user', [{ domain: 'reuters.com', delta: -1.4 }])
    const reuters = db
      .query<{ score: number }, [string]>('SELECT score FROM source_utility WHERE domain = ?')
      .get('reuters.com')
    expect(reuters?.score).toBe(0)
    db.close()
  })

  test('scores never drop below zero', () => {
    const db = openDb(tempDbPath())
    updateSourceUtility(db, 'local-user', [{ domain: 'low.example', delta: -5 }])
    const row = db
      .query<{ score: number }, [string]>('SELECT score FROM source_utility WHERE domain = ?')
      .get('low.example')
    expect(row?.score).toBe(0)
    db.close()
  })
})
