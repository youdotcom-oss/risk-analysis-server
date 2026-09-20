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
