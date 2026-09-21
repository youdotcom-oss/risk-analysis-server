import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { getActiveProfiles, saveProfile } from './db.ts'
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
    async (_args, ctx) => {
      // TEMP probe: what client capabilities does the host actually declare?
      // Drives the decision to wire task-augmented sweeps (SEP-2663).
      const envelope = (ctx as { mcpReq?: { envelope?: unknown } }).mcpReq?.envelope
      console.error('[caps]', JSON.stringify(envelope ?? null))
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
      description: 'Run the risk sweep pipeline now for one of your risk profiles.',
      inputSchema: z.object({ profileId: z.string().min(1) }),
      // MCP Apps binding (SEP-1865): after the sweep the host renders the
      // report resource in a sandboxed iframe. Text-only hosts fall back to
      // the JSON content below — the binding is additive.
      _meta: { ui: { resourceUri: REPORT_URI } },
    },
    async ({ profileId }) => {
      const profile = getActiveProfiles(deps.db, deps.userId).find((p) => p.id === profileId)
      if (!profile) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No active profile ${profileId} for this user.` }],
        }
      }
      const outcome = await deps.sweepRunner(profile, randomUUID())
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome) }],
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
