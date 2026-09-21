import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import {
  completeSweepTask,
  createSweepTask,
  failSweepTask,
  getActiveProfiles,
  getSweepTask,
  saveProfile,
  setSweepSchedule,
} from './db.ts'
import type { ProfileRecord, SweepOutcome } from './pipeline/sweep.ts'
import { isValidCron, type ProfileScheduler } from './scheduler.ts'

export type McpFactoryDeps = {
  db: Database
  /** Tenant for this server instance (stdio mode) or request (HTTP per-request factory). */
  userId: string
  /** Bound runSweepForTask: executes the sweep and mirrors status onto the task row. */
  sweepRunner: (profile: ProfileRecord, taskId: string) => Promise<SweepOutcome>
  taskTtlMs?: number
  /**
   * Per-process scheduler (optional): when present, set_sweep_schedule
   * registers/unregisters Bun.cron jobs immediately. Without it, schedule
   * changes persist to the DB and apply on the entry's next start.
   */
  scheduler?: Pick<ProfileScheduler, 'apply' | 'clear' | 'scope'>
}

export function buildMcpServer(deps: McpFactoryDeps): McpServer {
  const server = new McpServer({
    name: 'risk-analysis-server',
    version: '0.0.1',
  })

  server.registerTool(
    'set_risk_profile',
    {
      title: 'Set Risk Profile',
      description:
        'Create or update a monitored risk profile: a title, the geographic locations to watch, and the policy triggers (events/KPIs) that matter.',
      inputSchema: z.object({
        title: z.string().min(1),
        locations: z.array(z.string()).min(1),
        triggers: z.array(z.string()),
      }),
    },
    async ({ title, locations, triggers }) => {
      const profile = {
        id: randomUUID(),
        userId: deps.userId,
        title,
        locations,
        triggers,
      }
      saveProfile(deps.db, profile)
      // Echo the full profile (esp. id) so the caller can chain into
      // trigger_manual_sweep without needing a list/lookup tool.
      return {
        content: [{ type: 'text', text: JSON.stringify(profile) }],
      }
    },
  )

  server.registerTool(
    'list_risk_profiles',
    {
      title: 'List Risk Profiles',
      description:
        'List your active risk profiles with their ids, so you can pick a profileId for trigger_manual_sweep.',
      inputSchema: z.object({}),
    },
    async () => {
      const profiles = getActiveProfiles(deps.db, deps.userId)
      return {
        content: [{ type: 'text', text: JSON.stringify(profiles) }],
      }
    },
  )

  server.registerTool(
    'trigger_manual_sweep',
    {
      title: 'Trigger Manual Sweep',
      description:
        'Start a risk sweep for one of your risk profiles, or poll a running sweep. Two entry points: ' +
        'call with profileId to START — the tool returns immediately with a task_id and the sweep runs in ' +
        'the background (typical duration 60-120s). Then POLL by calling again with task_id until status ' +
        'is completed or failed; poll roughly every 20 seconds.',
      inputSchema: z.object({
        profileId: z.string().min(1).optional(),
        task_id: z.string().min(1).optional(),
      }),
    },
    async ({ profileId, task_id }) => {
      // Poll branch: status/result of an in-flight or finished sweep.
      if (task_id) {
        const task = getSweepTask(deps.db, task_id)
        if (!task || task.user_id !== deps.userId) {
          return {
            isError: true,
            content: [{ type: 'text', text: `No active sweep task ${task_id}.` }],
          }
        }
        if (task.status === 'completed') {
          const outcome = JSON.parse(task.result_json ?? '{}') as Record<string, unknown>
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'completed', ...outcome }),
              },
            ],
          }
        }
        if (task.status === 'failed') {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Sweep failed: ${task.error_json ?? 'unknown error'}`,
              },
            ],
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                task_id,
                status: task.status,
                next: 'Poll this tool again with task_id every ~20s until completed or failed.',
              }),
            },
          ],
        }
      }
      // Start branch: durably record the task, launch the sweep in the
      // background, and return the handle without blocking the caller.
      if (!profileId) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Provide profileId to start a sweep, or task_id to poll one.',
            },
          ],
        }
      }
      const profile = getActiveProfiles(deps.db, deps.userId).find((p) => p.id === profileId)
      if (!profile) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `No active profile ${profileId} for this user.`,
            },
          ],
        }
      }
      // Overlap guard: an in-flight sweep for this profile is joined, not
      // duplicated. (Recent-run suppression stays scheduler-only — explicit
      // manual re-runs are always allowed.)
      const inFlight = deps.db
        .query<{ task_id: string }, [string, string, number]>(
          `SELECT task_id FROM sweep_tasks
            WHERE profile_id = ? AND user_id = ? AND status = 'working' AND ttl_at > ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(profile.id, deps.userId, Date.now())
      if (inFlight) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                task_id: inFlight.task_id,
                status: 'working',
                already_running: true,
                next: 'A sweep for this profile is already in flight — poll with task_id.',
              }),
            },
          ],
        }
      }
      const taskId = randomUUID()
      createSweepTask(deps.db, {
        taskId,
        userId: deps.userId,
        profileId: profile.id,
        ttlMs: deps.taskTtlMs ?? 30 * 60 * 1000,
      })
      void deps
        .sweepRunner(profile, taskId)
        .then((outcome) => completeSweepTask(deps.db, taskId, outcome))
        .catch((error) => failSweepTask(deps.db, taskId, error))
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              task_id: taskId,
              status: 'working',
              next: 'Poll this tool with task_id every ~20s until status is completed or failed.',
            }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'set_sweep_schedule',
    {
      title: 'Set Sweep Schedule',
      description:
        'Schedule (or unschedule) automatic sweeps for one of your risk profiles. Pass schedule as a cron ' +
        'expression (5 or 6 fields, e.g. "0 9 * * 1" = Mondays 9am UTC) to schedule; call with only profileId ' +
        'to remove the schedule. Scheduled sweeps update the DB in the background — ask for the latest report ' +
        'to see results. Note: cron runs only while a server session is alive.',
      inputSchema: z.object({
        profileId: z.string().min(1).describe('The profile to schedule (from list_risk_profiles).'),
        schedule: z
          .string()
          .optional()
          .describe('Cron expression, 5 or 6 fields (UTC). Omit to remove the existing schedule.'),
      }),
    },
    async ({ profileId, schedule }) => {
      const profile = getActiveProfiles(deps.db, deps.userId).find((p) => p.id === profileId)
      if (!profile) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No active profile ${profileId} for this user.` }],
        }
      }
      if (schedule !== undefined && !isValidCron(schedule)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Invalid cron expression "${schedule}" — use 5 or 6 fields, e.g. "0 9 * * 1".`,
            },
          ],
        }
      }
      // Register live FIRST: a cron Bun rejects must never persist, or it
      // poisons the next startup. applyStored also tolerates bad rows, but
      // this keeps the tool honest about what actually took effect.
      if (schedule && deps.scheduler) {
        try {
          deps.scheduler.apply(profileId, schedule)
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Schedule rejected: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          }
        }
      }
      setSweepSchedule(deps.db, profileId, schedule ?? null)
      if (!schedule) deps.scheduler?.clear(profileId)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              profileId,
              schedule: schedule ?? null,
              schedulerScope: deps.scheduler?.scope ?? 'durable',
              effect: schedule
                ? (deps.scheduler?.scope ?? 'durable') === 'durable'
                  ? 'Sweep scheduled — the server process is a supervised service, so this cron keeps firing while the machine runs.'
                  : 'Sweep scheduled — but it fires only while this client is connected. Run the HTTP entry as a local service (see DEPLOY.md) to keep sweeping after you close it.'
                : 'Schedule removed.',
            }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'get_risk_report',
    {
      title: 'Get Risk Report',
      description:
        'Fetch a completed risk briefing. Defaults to the latest report; pass report_id to fetch a specific one. ' +
        'Returns the briefing as GFM Markdown — summarize it for the user rather than echoing it verbatim.',
      inputSchema: z.object({ report_id: z.string().min(1).optional() }),
    },
    async ({ report_id }) => {
      const report = report_id
        ? deps.db
            .query<
              { content_html: string; profile_title: string; severity: string; knowledge_json: string | null },
              [string, string]
            >(
              `SELECT r.content_html, p.title AS profile_title, r.severity, r.knowledge_json
                 FROM risk_reports r JOIN risk_profiles p ON p.id = r.profile_id
                WHERE r.id = ? AND r.user_id = ?`,
            )
            .get(report_id, deps.userId)
        : deps.db
            .query<
              { content_html: string; profile_title: string; severity: string; knowledge_json: string | null },
              [string]
            >(
              `SELECT r.content_html, p.title AS profile_title, r.severity, r.knowledge_json
                 FROM risk_reports r JOIN risk_profiles p ON p.id = r.profile_id
                WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 1`,
            )
            .get(deps.userId)
      if (!report) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: report_id ? `No report ${report_id}.` : 'No reports yet.',
            },
          ],
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              severity: report.severity,
              profile: report.profile_title,
              report_markdown: report.content_html,
              knowledge: report.knowledge_json ? (JSON.parse(report.knowledge_json) as unknown[]) : [],
            }),
          },
        ],
      }
    },
  )

  return server
}
