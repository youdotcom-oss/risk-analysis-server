import type { Database } from 'bun:sqlite'
import { completeSweepTask, createSweepTask, failSweepTask, getActiveProfiles, type ProfileRecordRow } from './db.ts'
import type { SweepOutcome } from './pipeline/sweep.ts'

export type CronHandle = { stop(): void }
export type CronRegistrar = (expression: string, fn: () => unknown) => CronHandle

type SweepFn = (profile: ProfileRecordRow) => Promise<SweepOutcome>

const defaultRegistrar: CronRegistrar = (expression, fn) => Bun.cron(expression, fn, { tz: 'UTC' })

/** 5- or 6-field cron expression (Bun accepts both). */
export function isValidCron(expression: string): boolean {
  return /^(\S+\s+){4}\S+(\s+\S+)?$/.test(expression.trim())
}

/** Skip window: don't re-sweep a profile that swept within this window (ms). */
const RECENT_WINDOW_MS = 10 * 60 * 1000

function hasRecentSweep(db: Database, profileId: string): boolean {
  const row = db
    .query<{ updated_at: number }, [string]>(
      `SELECT max(updated_at) AS updated_at FROM sweep_tasks WHERE profile_id = ?`,
    )
    .get(profileId)
  return row?.updated_at !== undefined && Date.now() - row.updated_at < RECENT_WINDOW_MS
}

/**
 * Per-process scheduler: env global schedule + DB-stored per-profile
 * schedules. Each process applies DB schedules at startup; schedule changes
 * made through tools update the DB and this process immediately — other
 * processes pick them up on their next start. Cron runs on Bun.cron.
 */
export class ProfileScheduler {
  private jobs = new Map<string, CronHandle>()
  private globalHandle: CronHandle | null = null

  /** 'durable' = process runs as a supervised service; 'session' = cron dies
   *  with the client connection (stdio). Surfaced by set_sweep_schedule. */
  readonly scope: 'session' | 'durable'

  constructor(
    private readonly db: Database,
    private readonly opts: {
      register?: CronRegistrar
      sweep?: SweepFn
      ttlMs?: number
      scope?: 'session' | 'durable'
    } = {},
  ) {
    this.scope = opts.scope ?? 'durable'
  }

  private registrar(): CronRegistrar {
    return this.opts.register ?? defaultRegistrar
  }

  private sweep(profile: ProfileRecordRow): Promise<SweepOutcome> {
    if (this.opts.sweep) return this.opts.sweep(profile)
    throw new Error('ProfileScheduler requires an injected sweep implementation')
  }

  /** Run one scheduled sweep for a profile, guarded against recent runs. */
  private async sweepProfile(registered: ProfileRecordRow): Promise<void> {
    // Fire-time fresh read: profiles edited after registration sweep with
    // their current locations/triggers, not the registration snapshot.
    const profile = getActiveProfiles(this.db).find((p) => p.id === registered.id) ?? registered
    if (hasRecentSweep(this.db, profile.id)) return
    const taskId = crypto.randomUUID()
    try {
      createSweepTask(this.db, {
        taskId,
        userId: profile.userId,
        profileId: profile.id,
        ttlMs: this.opts.ttlMs ?? 30 * 60 * 1000,
      })
      const outcome = await this.sweep(profile)
      completeSweepTask(this.db, taskId, outcome)
    } catch (error) {
      // JSON.stringify(new Error()) is '{}' — store a diagnosable payload.
      failSweepTask(this.db, taskId, {
        code: 'scheduled_sweep_failed',
        message: error instanceof Error ? error.message : String(error),
      })
      console.error(
        `[scheduler] scheduled sweep failed for ${profile.id}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  /** Register (or replace) the cron for one profile. Empty schedule clears. */
  apply(profileId: string, schedule: string | null): void {
    this.clear(profileId)
    if (!schedule) return
    if (!isValidCron(schedule)) throw new Error(`Invalid cron expression: ${schedule}`)
    const profile = getActiveProfiles(this.db).find((p) => p.id === profileId)
    if (!profile) throw new Error(`No active profile ${profileId}`)
    const handle = this.registrar()(schedule, () => {
      void this.sweepProfile(profile).catch(() => {})
    })
    this.jobs.set(profileId, handle)
  }

  clear(profileId: string): void {
    this.jobs.get(profileId)?.stop()
    this.jobs.delete(profileId)
  }

  /** Register the env global schedule (all active profiles) once. */
  applyGlobal(schedule: string): void {
    if (this.globalHandle) return
    if (!isValidCron(schedule)) throw new Error(`Invalid cron expression: ${schedule}`)
    this.globalHandle = this.registrar()(schedule, () => {
      void (async () => {
        for (const profile of getActiveProfiles(this.db)) {
          await this.sweepProfile(profile)
        }
      })().catch(() => {})
    })
  }

  /** Apply all DB-stored per-profile schedules (call at startup). */
  applyStored(): void {
    for (const profile of getActiveProfiles(this.db)) {
      if (!profile.sweepSchedule) continue
      try {
        this.apply(profile.id, profile.sweepSchedule)
      } catch (error) {
        // A stale/invalid stored schedule must not crash the entry: skip the
        // profile, keep serving. The row stays for the user to fix/clear.
        console.error(
          `[scheduler] failed to register schedule for ${profile.id}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  stopAll(): void {
    for (const handle of this.jobs.values()) handle.stop()
    this.jobs.clear()
    this.globalHandle?.stop()
    this.globalHandle = null
  }
}
