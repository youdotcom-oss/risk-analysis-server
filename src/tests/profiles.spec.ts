import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getActiveProfiles, openDb, saveProfile } from '../db.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = mkdtempSync(`${tmpdir()}/risk-db-`)
  dirs.push(dir)
  return join(dir, 'risk.sqlite')
}

describe('profile persistence', () => {
  test('saveProfile inserts and getActiveProfiles returns it scoped to user', () => {
    const db = openDb(tempDbPath())
    saveProfile(db, {
      id: 'p1',
      userId: 'local-user',
      title: 'EU ports',
      locations: ['Hamburg Port'],
      triggers: ['strikes'],
    })
    const profiles = getActiveProfiles(db, 'local-user')
    expect(profiles).toEqual([
      {
        id: 'p1',
        userId: 'local-user',
        title: 'EU ports',
        locations: ['Hamburg Port'],
        triggers: ['strikes'],
        isActive: true,
        sweepSchedule: null,
      },
    ])
    db.close()
  })

  test('saveProfile upserts on the same id and updates fields', () => {
    const db = openDb(tempDbPath())
    saveProfile(db, {
      id: 'p1',
      userId: 'local-user',
      title: 'EU ports',
      locations: ['Hamburg Port'],
      triggers: ['strikes'],
    })
    saveProfile(db, {
      id: 'p1',
      userId: 'local-user',
      title: 'EU ports + rail',
      locations: ['Hamburg Port', 'Duisburg'],
      triggers: ['strikes', 'rail blockades'],
    })
    const profiles = getActiveProfiles(db, 'local-user')
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.title).toBe('EU ports + rail')
    db.close()
  })

  test('tenant scoping: other users see nothing', () => {
    const db = openDb(tempDbPath())
    saveProfile(db, {
      id: 'p1',
      userId: 'local-user',
      title: 'EU ports',
      locations: ['Hamburg Port'],
      triggers: ['strikes'],
    })
    expect(getActiveProfiles(db, 'someone-else')).toEqual([])
    db.close()
  })
})
