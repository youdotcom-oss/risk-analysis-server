import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { TypeSafeClient } from '@typesafe-ai/sdk'
import { openDb } from './db.ts'
import { buildMcpServer } from './mcp.ts'
import { getModel } from './model.ts'
import { buildSweepDeps, runSweepForTask } from './pipeline/sweep.ts'
import { createJev } from './services/jev.ts'
import { createYdcClient } from './services/you.ts'

const db = openDb(process.env.RISK_DB_PATH ?? 'risk.sqlite')
const [ydcClient] = await Promise.all([createYdcClient()])
const sweepDeps = buildSweepDeps({
  db,
  userId: 'local-user',
  ydcClient,
  jev: createJev(new TypeSafeClient()),
  model: getModel(),
})

serveStdio(() =>
  buildMcpServer({
    db,
    userId: 'local-user',
    sweepRunner: (profile, taskId) => runSweepForTask(db, sweepDeps, profile, taskId),
  }),
)
