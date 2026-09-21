import { Database } from 'bun:sqlite'

const MIGRATION = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  locations TEXT NOT NULL,
  policy_triggers TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  sweep_schedule TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS source_utility (
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  score REAL DEFAULT 1.0,
  last_updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, domain),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  content_html TEXT NOT NULL,
  knowledge_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id) REFERENCES risk_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sweep_tasks (
  task_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ttl_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`

export function openDb(path: string): Database {
  const db = new Database(path, { strict: true })
  db.run('PRAGMA journal_mode = WAL;')
  // Multi-process writes are the norm (stdio session + HTTP service share one
  // file): wait on a held lock instead of failing with SQLITE_BUSY instantly.
  db.run('PRAGMA busy_timeout = 5000;')
  db.run(MIGRATION)
  // In-place migration for DBs created before sweep_schedule existed.
  // Only swallow the duplicate-column case: SQLITE_BUSY or anything else
  // must propagate (a swallowed BUSY leaves the schema stale silently).
  for (const column of [
    'ALTER TABLE risk_profiles ADD COLUMN sweep_schedule TEXT',
    'ALTER TABLE risk_reports ADD COLUMN knowledge_json TEXT',
  ]) {
    try {
      db.run(column)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column')) throw error
    }
  }
  db.query(
    `INSERT INTO users (id, email, created_at) VALUES ('local-user', 'local@localhost', $now)
       ON CONFLICT(id) DO NOTHING`,
  ).run({ now: Date.now() })
  return db
}

export type UtilityDelta = {
  domain: string
  delta: number
}

/** Apply Jev Gate 3 domain-utility deltas atomically; scores clamp at zero. */
export function updateSourceUtility(db: Database, userId: string, deltas: UtilityDelta[]): void {
  const upsert = db.query(
    `INSERT INTO source_utility (user_id, domain, score, last_updated)
     VALUES ($userId, $domain, MAX(0, $score), $now)
     ON CONFLICT(user_id, domain) DO UPDATE SET
       score = MAX(0, source_utility.score + $delta),
       last_updated = $now`,
  )
  const apply = db.transaction((entries: UtilityDelta[]) => {
    for (const { domain, delta } of entries) {
      upsert.run({
        userId,
        domain,
        delta,
        score: 1.0 + delta,
        now: Date.now(),
      })
    }
  })
  apply.immediate(deltas)
}

/** Provision a tenant row on first authenticated use (idempotent). */
export function ensureUser(db: Database, id: string): void {
  db.query(
    `INSERT INTO users (id, email, created_at) VALUES ($id, $email, $now)
     ON CONFLICT(id) DO NOTHING`,
  ).run({ id, email: `${id}@oauth`, now: Date.now() })
}

export type ProfileRecordRow = {
  id: string
  userId: string
  title: string
  locations: string[]
  triggers: string[]
  isActive: boolean
  /** Cron expression for scheduled sweeps; null when unscheduled. */
  sweepSchedule: string | null
}

export function saveProfile(db: Database, profile: Omit<ProfileRecordRow, 'isActive' | 'sweepSchedule'>): void {
  db.query(
    `INSERT INTO risk_profiles
       (id, user_id, title, locations, policy_triggers, is_active, updated_at)
     VALUES ($id, $userId, $title, $locations, $triggers, 1, $now)
     ON CONFLICT(id) DO UPDATE SET
       user_id = $userId,
       title = $title,
       locations = $locations,
       policy_triggers = $triggers,
       is_active = 1,
       updated_at = $now`,
  ).run({
    id: profile.id,
    userId: profile.userId,
    title: profile.title,
    locations: JSON.stringify(profile.locations),
    triggers: JSON.stringify(profile.triggers),
    now: Date.now(),
  })
}

export function getActiveProfiles(db: Database, userId?: string): ProfileRecordRow[] {
  const sql = `SELECT id, user_id, title, locations, policy_triggers, is_active, sweep_schedule
    FROM risk_profiles WHERE is_active = 1 ${userId ? 'AND user_id = ?' : ''} ORDER BY title`
  type Row = {
    id: string
    user_id: string
    title: string
    locations: string
    policy_triggers: string
    is_active: number
    sweep_schedule: string | null
  }
  const rows = userId ? db.query<Row, [string]>(sql).all(userId) : db.query<Row, []>(sql).all()
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    title: row.title,
    locations: JSON.parse(row.locations) as string[],
    triggers: JSON.parse(row.policy_triggers) as string[],
    isActive: row.is_active === 1,
    sweepSchedule: row.sweep_schedule ?? null,
  }))
}

/** Persist (or clear with null) a profile's scheduled-sweep cron expression. */
export function setSweepSchedule(db: Database, profileId: string, schedule: string | null): void {
  db.query(`UPDATE risk_profiles SET sweep_schedule = $schedule, updated_at = $now WHERE id = $id`).run({
    schedule,
    now: Date.now(),
    id: profileId,
  })
}

export type SweepTaskInput = {
  taskId: string
  userId: string
  profileId: string
  ttlMs: number
}

export type SweepTaskRow = {
  task_id: string
  user_id: string
  profile_id: string
  status: string
  result_json: string | null
  error_json: string | null
  created_at: number
  updated_at: number
  ttl_at: number
}

/** MCP Tasks durability: the row is committed before callers may respond with a task handle. */
export function createSweepTask(db: Database, input: SweepTaskInput): void {
  const now = Date.now()
  db.query(
    `INSERT INTO sweep_tasks
       (task_id, user_id, profile_id, status, created_at, updated_at, ttl_at)
     VALUES ($taskId, $userId, $profileId, 'working', $now, $now, $ttlAt)`,
  ).run({
    taskId: input.taskId,
    userId: input.userId,
    profileId: input.profileId,
    now,
    ttlAt: now + input.ttlMs,
  })
}

export function getSweepTask(db: Database, taskId: string): SweepTaskRow | null {
  const row = db
    .query<SweepTaskRow, [string, number]>(
      `SELECT * FROM sweep_tasks
       WHERE task_id = ? AND ttl_at > ?`,
    )
    .get(taskId, Date.now())
  return row ?? null
}

function transition(db: Database, taskId: string, status: 'completed' | 'failed' | 'cancelled', value?: unknown): void {
  // Unknown task ids and already-terminal tasks are natural no-ops of the
  // WHERE clause: cancellation is cooperative, transitions are idempotent.
  // Terminal states extend the TTL (24h): a result must outlive the original
  // window — a sweep completing into an expired row would be unreadable.
  db.query(
    `UPDATE sweep_tasks
     SET status = $status,
         result_json = CASE WHEN $status = 'completed' THEN $payload ELSE result_json END,
         error_json = CASE WHEN $status = 'failed' THEN $payload ELSE error_json END,
         updated_at = $now,
         ttl_at = $ttl
     WHERE task_id = $taskId AND status = 'working'`,
  ).run({
    status,
    payload: value === undefined ? null : JSON.stringify(value),
    now: Date.now(),
    ttl: Date.now() + 24 * 60 * 60 * 1000,
    taskId,
  })
}

export function completeSweepTask(db: Database, taskId: string, result: unknown): void {
  transition(db, taskId, 'completed', result)
}

export function failSweepTask(db: Database, taskId: string, error: unknown): void {
  transition(db, taskId, 'failed', error)
}

export function cancelSweepTask(db: Database, taskId: string): void {
  transition(db, taskId, 'cancelled')
}
