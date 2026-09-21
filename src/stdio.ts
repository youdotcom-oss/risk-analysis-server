import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { missingKeyWarnings } from './config.ts'
import { openDb } from './db.ts'
import { buildMcpServer } from './mcp.ts'
import { getModel } from './model.ts'
import { buildSweepDeps, runSweepForTask, type SweepDeps } from './pipeline/sweep.ts'
import { createJev } from './services/jev.ts'
import { createYdcClient } from './services/you.ts'

for (const warning of missingKeyWarnings()) console.warn(warning)
const db = openDb(process.env.RISK_DB_PATH ?? 'risk.sqlite')

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

serveStdio(() =>
  buildMcpServer({
    db,
    userId: 'local-user',
    sweepRunner: (profile, taskId) => runSweepForTask(db, sweepDeps(), profile, taskId),
  }),
)
