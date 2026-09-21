#!/usr/bin/env bun
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { defaultDbPath, missingKeyWarnings } from './config.ts'
import { openDb } from './db.ts'
import { buildMcpServer } from './mcp.ts'
import { getModel } from './model.ts'
import { buildSweepDeps, runSweep, runSweepForTask, type SweepDeps } from './pipeline/sweep.ts'
import { ProfileScheduler } from './scheduler.ts'
import { createJev } from './services/jev.ts'
import { createYdcClient } from './services/you.ts'

for (const warning of missingKeyWarnings()) console.warn(warning)
const db = openDb(process.env.RISK_DB_PATH ?? defaultDbPath())

// Lazy sweep deps: the You.com MCP client connects on first sweep, not at
// startup — the server must start (and serve tools that need no network)
// even when the keys are missing or the upstream is unreachable.
let cachedSweepDeps: SweepDeps | undefined

function sweepDeps(): SweepDeps {
  cachedSweepDeps ??= buildSweepDeps({
    db,
    userId: 'local-user',
    ydcClient: createYdcClient(),
    jev: createJev(new TypeSafeClient()),
    model: getModel(),
  })
  return cachedSweepDeps
}

const scheduler = new ProfileScheduler(db, 'local-user', {
  scope: 'session',
  sweep: async (profile) => runSweep(sweepDeps(), profile),
})

// Schedules: env global + DB-stored per-profile crons. Cron lives only
// while this session is alive — long-lived autonomy belongs to the HTTP
// entry (RISK_CRON_SCHEDULE + RISK_JWT_SECRET).
if (process.env.RISK_CRON_SCHEDULE) scheduler.applyGlobal(process.env.RISK_CRON_SCHEDULE)
scheduler.applyStored()

serveStdio(() =>
  buildMcpServer({
    db,
    userId: 'local-user',
    scheduler,
    sweepRunner: (profile, taskId) => runSweepForTask(db, sweepDeps(), profile, taskId),
  }),
)
