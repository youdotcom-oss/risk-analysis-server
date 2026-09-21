import type { Database } from 'bun:sqlite'
import { createMcpHonoApp } from '@modelcontextprotocol/hono'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { Context, Hono } from 'hono'
import { jwtVerify } from 'jose'
import { ensureUser, getAllActiveProfiles, openDb } from './db.ts'
import { buildMcpServer, type McpFactoryDeps } from './mcp.ts'
import { getModel } from './model.ts'
import {
  buildSweepDeps,
  type ProfileRecord,
  runSweepForTask,
  type SweepOutcome,
  sweepAllProfiles,
} from './pipeline/sweep.ts'
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
  /** Omitted in tests; when set, the cron sweep engine runs. */
  cronSchedule?: string
}

export function createApp(deps: AppDeps): Hono {
  const app = createMcpHonoApp({ allowedHosts: process.env.RISK_ALLOWED_HOSTS?.split(',') })

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

// --- Module entry: default export (Bun serves the { fetch } object directly),
// env wiring + cron engine. Never exercised by unit tests (they import createApp). ---

let cachedApp: Hono | undefined

function getServerApp(): Hono {
  if (cachedApp) return cachedApp
  const secret = process.env.RISK_JWT_SECRET
  if (!secret) throw new Error('RISK_JWT_SECRET is required for the HTTP server')
  const db = openDb(process.env.RISK_DB_PATH ?? 'risk.sqlite')

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
  })

  if (process.env.RISK_CRON_SCHEDULE) {
    // Per-profile error isolation lives in sweepAllProfiles; the outer catch
    // guards against unhandled rejections exiting the server (Bun cron
    // semantics). No-overlap guarantee makes long sweeps safe on a schedule.
    Bun.cron(
      process.env.RISK_CRON_SCHEDULE,
      async () => {
        try {
          const profiles = getAllActiveProfiles(db)
          const sweepDeps = buildSweepDeps({
            db,
            userId: 'local-user',
            ydcClient: await createYdcClient(),
            jev: createJev(new TypeSafeClient()),
            model: getModel(),
          })
          const results = await sweepAllProfiles(sweepDeps, profiles)
          for (const result of results) {
            if ('error' in result) console.error(`sweep failed for ${result.profileId}: ${result.error}`)
          }
        } catch (error) {
          console.error('cron sweep failed:', error)
        }
      },
      { tz: 'UTC' },
    )
  }
  return cachedApp
}

export default {
  fetch: (req: Request) => getServerApp().fetch(req),
}
