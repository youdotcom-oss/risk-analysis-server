import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { RiskProfile } from '../services/jev.ts'

export type SweepOutcome = {
  escalated: boolean
  severity?: string
  reportId?: string
}

export type ProfileRecord = RiskProfile & {
  id: string
  userId: string
}

export type SweepDeps = {
  db: Database
  fetchHighlights: (profile: ProfileRecord) => Promise<string[]>
  triage: (profile: ProfileRecord, highlights: string[]) => Promise<number>
  deepDive: (profile: ProfileRecord) => Promise<{ severity: string; contentHtml: string }>
}

const TRIAGE_THRESHOLD = 0.5

/**
 * Stage 1→4 orchestration for one profile. Below the triage threshold the
 * sweep exits after Gate 1 — no expensive downstream compute is invoked.
 */
export async function runSweep(deps: SweepDeps, profile: ProfileRecord): Promise<SweepOutcome> {
  const highlights = await deps.fetchHighlights(profile)
  const threat = await deps.triage(profile, highlights)
  if (threat < TRIAGE_THRESHOLD) {
    return { escalated: false }
  }
  const report = await deps.deepDive(profile)
  const reportId = randomUUID()
  deps.db
    .query(
      `INSERT INTO risk_reports (id, user_id, profile_id, severity, content_html, created_at)
       VALUES ($id, $userId, $profileId, $severity, $contentHtml, $now)`,
    )
    .run({
      id: reportId,
      userId: profile.userId,
      profileId: profile.id,
      severity: report.severity,
      contentHtml: report.contentHtml,
      now: Date.now(),
    })
  return { escalated: true, severity: report.severity, reportId }
}

export type SweepResult = { profileId: string; outcome: SweepOutcome } | { profileId: string; error: string }

/**
 * Run a sweep per profile with per-profile error isolation: one profile's
 * failure is logged and returned, never propagated — a cron batch must not
 * crash the server (an unhandled rejection would exit the process).
 */
export async function sweepAllProfiles(deps: SweepDeps, profiles: ProfileRecord[]): Promise<SweepResult[]> {
  // Index-addressed so results come back in input order regardless of
  // per-profile completion timing.
  const results: SweepResult[] = new Array(profiles.length)
  for (const batch of chunk(profiles, 5)) {
    await Promise.all(
      batch.map(async (p) => {
        const index = profiles.indexOf(p)
        try {
          results[index] = { profileId: p.id, outcome: await runSweep(deps, p) }
        } catch (error) {
          results[index] = {
            profileId: p.id,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
  }
  return results
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}
