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
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id) REFERENCES risk_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sweep_tasks (
  task_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL,
  status_message TEXT,
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
  db.run(MIGRATION)
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
      upsert.run({ userId, domain, delta, score: 1.0 + delta, now: Date.now() })
    }
  })
  apply.immediate(deltas)
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
  status_message: string | null
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
  ).run({ taskId: input.taskId, userId: input.userId, profileId: input.profileId, now, ttlAt: now + input.ttlMs })
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
  db.query(
    `UPDATE sweep_tasks
     SET status = $status,
         result_json = CASE WHEN $status = 'completed' THEN $payload ELSE result_json END,
         error_json = CASE WHEN $status = 'failed' THEN $payload ELSE error_json END,
         updated_at = $now
     WHERE task_id = $taskId AND status = 'working'`,
  ).run({
    status,
    payload: value === undefined ? null : JSON.stringify(value),
    now: Date.now(),
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
