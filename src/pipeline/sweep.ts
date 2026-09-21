import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { MCPClient } from '@ai-sdk/mcp'
import { completeSweepTask, failSweepTask } from '../db.ts'
import { triageThreat } from '../services/jev.ts'
import { parseSearchResults } from '../services/you.ts'
import type { DeepDiveDeps } from './deep-dive.ts'
import { deepDive, fallbackQuery } from './deep-dive.ts'

export type ProfileRecord = {
  id: string
  userId: string
  title: string
  locations: string[]
  triggers: string[]
}

export type SweepOutcome = {
  escalated: boolean
  severity?: string
  reportId?: string
}

export type SweepDeps = {
  db: Database
  fetchHighlights: (profile: ProfileRecord) => Promise<string[]>
  triage: (profile: ProfileRecord, highlights: string[]) => Promise<number>
  deepDive: (profile: ProfileRecord) => Promise<{ severity: string; contentHtml: string }>
}

const TRIAGE_THRESHOLD = 0.5

/** Stage 1 surface-sweep query: the deterministic template from the deep-dive module. */
async function fetchHighlights(client: Pick<MCPClient, 'tools'>, profile: ProfileRecord): Promise<string[]> {
  const tools = await client.tools()
  const search = tools['you-search']
  if (!search) throw new Error('you-search tool not exposed by the You.com MCP server')
  const output = await search.execute(
    { query: fallbackQuery(profile), extraction: 'highlights' },
    undefined as unknown as Parameters<typeof search.execute>[1],
  )
  const text =
    (output as { content?: { type: string; text?: string }[] }).content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? ''
  // Compact projection: "title — description" per result. The legacy flat
  // shape + raw-text fallback once sent the entire payload to Gate 1
  // (TypeSafe 400 max_tokens_exceeded on live runs).
  const MINIMAL_HIGHLIGHTS = 40
  return parseSearchResults(text)
    .slice(0, MINIMAL_HIGHLIGHTS)
    .map((item) => [item.title, item.description].filter((part) => part !== '').join(' — '))
    .filter((highlight) => highlight !== '')
}

export type BuildSweepDepsArgs = Omit<DeepDiveDeps, 'client'> & {
  db: Database
  /** The You.com MCP client, or a promise for it (lazy connect keeps startup
   *  independent of the upstream server's availability). */
  ydcClient: Pick<MCPClient, 'tools'> | Promise<Pick<MCPClient, 'tools'>>
}

/** Compose the real SweepDeps: Stage 1 highlight triage + the full deep dive. */
export function buildSweepDeps(args: BuildSweepDepsArgs): SweepDeps {
  const resolveClient = async () => await args.ydcClient
  return {
    db: args.db,
    fetchHighlights: async (profile) => fetchHighlights(await resolveClient(), profile),
    triage: (profile, highlights) => triageThreat(args.jev, profile, highlights),
    deepDive: async (profile) =>
      await deepDive(
        {
          model: args.model,
          client: await resolveClient(),
          jev: args.jev,
          db: args.db,
          userId: args.userId,
        },
        profile,
      ),
  }
}

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
          results[index] = {
            profileId: p.id,
            outcome: await runSweep(deps, p),
          }
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

/**
 * Task-connected sweep: run the orchestration and mirror its outcome onto
 * the durably-created sweep_tasks row (MCP Tasks contract). The error is
 * re-thrown so the MCP layer can respond with the JSON-RPC failure.
 */
export async function runSweepForTask(
  db: Database,
  deps: SweepDeps,
  profile: ProfileRecord,
  taskId: string,
): Promise<SweepOutcome> {
  try {
    const outcome = await runSweep(deps, profile)
    completeSweepTask(db, taskId, outcome)
    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failSweepTask(db, taskId, { code: -32000, message })
    throw error
  }
}
