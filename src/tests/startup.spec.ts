import { afterAll, describe, expect, test } from 'bun:test'
import { type Subprocess, spawn } from 'bun'

/**
 * Startup smoke for the HTTP entry's import.meta.main block: with a global
 * schedule set, the process must boot, serve, and survive two seconds —
 * a bad persisted schedule or a registration crash would kill it here.
 * (Cron FIRING itself is covered by the env-gated live smoke, not CI.)
 */
const procs: Subprocess[] = []
afterAll(() => {
  for (const proc of procs) proc.kill()
})

describe('server entry startup with schedules', () => {
  test('boots with RISK_CRON_SCHEDULE and serves, without crashing', async () => {
    const proc = spawn({
      cmd: ['bun', 'src/server.ts'],
      env: {
        ...process.env,
        RISK_JWT_SECRET: 'startup-smoke',
        RISK_CRON_SCHEDULE: '0 3 * * 0',
        RISK_DB_PATH: `${import.meta.dir}/tmp-startup.sqlite`,
        YDC_API_KEY: '',
        TYPESAFE_API_KEY: '',
        OPENROUTER_API_KEY: '',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    procs.push(proc)
    // poll until the server answers — a registration crash would exit the
    // process and exhaust this loop instead of serving
    let res: Response | undefined
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const attempt_res = await fetch('http://localhost:3000/.well-known/oauth-protected-resource')
        res = attempt_res
        break
      } catch {
        await Bun.sleep(100)
      }
    }
    if (!res) throw new Error('server did not answer before timeout')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource?: string }
    expect(body.resource).toBe('urn:risk-analysis-server')
    proc.kill()
  }, 10_000)
})
