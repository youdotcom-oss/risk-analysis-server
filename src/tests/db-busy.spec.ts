import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db.ts'

// Child holds a write transaction for ~800ms, then commits. The test's own
// write races the child: with busy_timeout it waits out the lock; without
// one it fails instantly with SQLITE_BUSY.
const HOLDER = `
import { openDb } from '${process.cwd()}/src/db.ts'
const db = openDb(process.argv[2]!)
db.run('BEGIN IMMEDIATE')
console.log('held')
setTimeout(() => { db.run('COMMIT'); process.exit(0) }, 800)
`

describe('openDb concurrency', () => {
  test('a writer waits out a held lock instead of failing with SQLITE_BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-busy-'))
    try {
      const path = join(dir, 'risk.sqlite')
      writeFileSync(join(dir, 'holder.ts'), HOLDER)
      const db = openDb(path)
      db.run('CREATE TABLE IF NOT EXISTS probe (v TEXT)')

      const holder = Bun.spawn(['bun', join(dir, 'holder.ts'), path])
      const reader = holder.stdout.getReader()
      let seen = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        seen += new TextDecoder().decode(value)
        if (seen.trim() === 'held') break
      }

      // Lock is now held by the child. This write must block until the
      // child commits (~800ms), not fail instantly.
      const start = Date.now()
      db.run("INSERT INTO probe VALUES ('from-test')")
      const waited = Date.now() - start
      expect(waited).toBeGreaterThanOrEqual(400)
      expect(db.query('SELECT v FROM probe').all() as { v: string }[]).toContainEqual({
        v: 'from-test',
      })

      await reader.cancel().catch(() => {})
      await holder.exited
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
