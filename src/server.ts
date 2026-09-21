import type { Database } from 'bun:sqlite'
import { createMcpHonoApp } from '@modelcontextprotocol/hono'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { Context, Hono } from 'hono'
import { jwtVerify } from 'jose'
import { defaultDbPath, missingKeyWarnings } from './config.ts'
import { ensureUser, openDb } from './db.ts'
import { buildMcpServer, type McpFactoryDeps } from './mcp.ts'
import { getModel } from './model.ts'
import { buildSweepDeps, type ProfileRecord, runSweep, runSweepForTask, type SweepOutcome } from './pipeline/sweep.ts'
import { ProfileScheduler } from './scheduler.ts'
import { createJev, TypeSafeClient } from './services/jev.ts'
import { createYdcClient } from './services/you.ts'

export type BearerVerifier = (req: Request) => Promise<{ sub: string } | null>

export type AppDeps = {
  db: Database
  jwtSecret: string
  /**
   * Inject your own bearer verification (OAuth introspection, IdP JWKS, …).
   * Defaults to HMAC JWT verification against `jwtSecret`. The returned
   * `sub` is the tenant id and becomes the MCP session's user.
   */
  verifyBearer?: BearerVerifier
  /** Binds a sweep runner for a tenant (used by the per-request factory). */
  sweepRunnerFactory: (
    deps: Omit<McpFactoryDeps, 'sweepRunner'>,
  ) => (profile: ProfileRecord, taskId: string) => Promise<SweepOutcome>
  /** Per-process scheduler; enables live set_sweep_schedule registration. */
  scheduler?: McpFactoryDeps['scheduler']
  /** Omitted in tests; when set, the cron sweep engine runs. */
  cronSchedule?: string
}

export function createApp(deps: AppDeps): Hono {
  const app = createMcpHonoApp({
    allowedHosts: process.env.RISK_ALLOWED_HOSTS?.split(','),
  })

  app.get('/.well-known/oauth-protected-resource', (c: Context) =>
    c.json({
      resource: 'urn:risk-analysis-server',
      authorization_servers: [process.env.RISK_ISSUER_URL ?? 'https://accounts.example.com'],
      scopes_supported: ['profile:write', 'sweep:run', 'reports:read'],
      bearer_methods_supported: ['header'],
    }),
  )

  app.all('/mcp', async (c: Context) => {
    const verify = deps.verifyBearer ?? ((req: Request) => verifyHmacBearer(req, deps.jwtSecret))
    const auth = await verify(c.req.raw)
    if (!auth) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    ensureUser(deps.db, auth.sub)
    const handler = createMcpHandler(() =>
      buildMcpServer({
        db: deps.db,
        userId: auth.sub,
        scheduler: deps.scheduler,
        sweepRunner: deps.sweepRunnerFactory({ db: deps.db, userId: auth.sub }),
      }),
    )
    return handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') })
  })

  return app
}

type TokenPayload = {
  sub: string
}

async function verifyHmacBearer(req: Request, secret: string): Promise<TokenPayload | null> {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return null
  try {
    const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secret))
    if (typeof payload.sub !== 'string' || payload.sub === '') return null
    return { sub: payload.sub }
  } catch {
    return null
  }
}

// --- Module entry: default export (Bun serves the { fetch } object directly).
// Never exercised by unit tests (they import createApp). ---

function getServerApp(): Hono {
  if (cachedApp) return cachedApp
  const secret = process.env.RISK_JWT_SECRET
  if (!secret) throw new Error('RISK_JWT_SECRET is required for the HTTP server')
  const db = openDb(process.env.RISK_DB_PATH ?? defaultDbPath())
  for (const warning of missingKeyWarnings()) console.warn(warning)

  cachedApp = createApp({
    db,
    jwtSecret: secret,
    sweepRunnerFactory: (deps) => {
      const ydcClientP = createYdcClient()
      return async (profile, taskId) => {
        const sweepDeps = buildSweepDeps({
          db: deps.db,
          userId: deps.userId,
          ydcClient: await ydcClientP,
          jev: createJev(new TypeSafeClient()),
          model: getModel(),
        })
        return runSweepForTask(deps.db, sweepDeps, profile, taskId)
      }
    },
    scheduler: _entryScheduler,
  })
  return cachedApp
}

/**
 * Entry-only scheduler startup: cron must register when this module runs as
 * the process (bun src/server.ts) — a lazy registration inside getServerApp
 * never fires on a zero-traffic server. Library imports (tests, consumers)
 * are unaffected: import.meta.main is false there.
 */
if (import.meta.main) {
  const entryDb = openDb(process.env.RISK_DB_PATH ?? defaultDbPath())
  const entryScheduler = new ProfileScheduler(entryDb, 'local-user', {
    sweep: async (profile) =>
      runSweep(
        buildSweepDeps({
          db: entryDb,
          userId: 'local-user',
          ydcClient: await createYdcClient(),
          jev: createJev(new TypeSafeClient()),
          model: getModel(),
        }),
        profile,
      ),
  })
  entryScheduler.applyStored()
  if (process.env.RISK_CRON_SCHEDULE)
    entryScheduler.applyGlobal(process.env.RISK_CRON_SCHEDULE)
    // Expose to getServerApp for live set_sweep_schedule registration
  ;(globalThis as Record<string, unknown>).__riskEntryScheduler = entryScheduler
}

let cachedApp: Hono | undefined
const _entryScheduler = (globalThis as Record<string, unknown>).__riskEntryScheduler as ProfileScheduler | undefined

export default {
  fetch: (req: Request) => getServerApp().fetch(req),
}
