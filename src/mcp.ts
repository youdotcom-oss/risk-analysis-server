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
} from './db.ts'
import type { ProfileRecord, SweepOutcome } from './pipeline/sweep.ts'

export type McpFactoryDeps = {
  db: Database
  /** Tenant for this server instance (stdio mode) or request (HTTP per-request factory). */
  userId: string
  /** Bound runSweepForTask: executes the sweep and mirrors status onto the task row. */
  sweepRunner: (profile: ProfileRecord, taskId: string) => Promise<SweepOutcome>
  taskTtlMs?: number
}

export const REPORT_URI = 'ui://risk-report/latest'
/** MCP Apps (SEP-1865) resource MIME type — signals "render me in an iframe". */
export const APP_MIME_TYPE = 'text/html;profile=mcp-app'

export function buildMcpServer(deps: McpFactoryDeps): McpServer {
  const server = new McpServer({ name: 'risk-analysis-server', version: '0.0.1' })

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
      // MCP Apps binding (SEP-1865): after the sweep the host renders the
      // report resource in a sandboxed iframe. Text-only hosts fall back to
      // the JSON content below — the binding is additive.
      _meta: { ui: { resourceUri: REPORT_URI } },
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
            content: [{ type: 'text', text: JSON.stringify({ status: 'completed', ...outcome }) }],
          }
        }
        if (task.status === 'failed') {
          return {
            isError: true,
            content: [{ type: 'text', text: `Sweep failed: ${task.error_json ?? 'unknown error'}` }],
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify({ task_id, status: task.status }) }] }
      }
      // Start branch: durably record the task, launch the sweep in the
      // background, and return the handle without blocking the caller.
      if (!profileId) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Provide profileId to start a sweep, or task_id to poll one.' }],
        }
      }
      const profile = getActiveProfiles(deps.db, deps.userId).find((p) => p.id === profileId)
      if (!profile) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No active profile ${profileId} for this user.` }],
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
    'get_risk_report',
    {
      title: 'Get Risk Report',
      description:
        'Fetch a completed risk briefing. Defaults to the latest report; pass report_id to fetch a specific one. ' +
        'Returns the briefing as HTML — summarize it for the user rather than echoing it verbatim.',
      inputSchema: z.object({ report_id: z.string().min(1).optional() }),
    },
    async ({ report_id }) => {
      const report = report_id
        ? deps.db
            .query<{ content_html: string; profile_title: string; severity: string }, [string, string]>(
              `SELECT r.content_html, p.title AS profile_title, r.severity
                 FROM risk_reports r JOIN risk_profiles p ON p.id = r.profile_id
                WHERE r.id = ? AND r.user_id = ?`,
            )
            .get(report_id, deps.userId)
        : deps.db
            .query<{ content_html: string; profile_title: string; severity: string }, [string]>(
              `SELECT r.content_html, p.title AS profile_title, r.severity
                 FROM risk_reports r JOIN risk_profiles p ON p.id = r.profile_id
                WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 1`,
            )
            .get(deps.userId)
      if (!report) {
        return {
          isError: true,
          content: [{ type: 'text', text: report_id ? `No report ${report_id}.` : 'No reports yet.' }],
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              severity: report.severity,
              profile: report.profile_title,
              report_html: report.content_html,
            }),
          },
        ],
      }
    },
  )

  server.registerResource('risk-report-latest', REPORT_URI, { mimeType: APP_MIME_TYPE }, async () => {
    const report = deps.db
      .query<{ content_html: string }, [string]>(
        `SELECT content_html FROM risk_reports
           WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(deps.userId)
    return {
      contents: [
        {
          uri: REPORT_URI,
          mimeType: APP_MIME_TYPE,
          text: report?.content_html ?? '<html><body><p>No reports yet.</p></body></html>',
        },
      ],
    }
  })

  return server
}
