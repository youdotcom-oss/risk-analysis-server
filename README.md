# Risk Analysis Server

An autonomous risk-monitoring MCP server. Define a risk profile — a topic,
the geographic locations to watch, and the policy triggers that matter — and
the server runs an agentic sweep: live web search scoped by a judgment model
(Jev), source scoring, and a Markdown briefing you can read from any MCP
client.

Part of the You.com MCP server family. Runs on Bun only (`bun:sqlite`,
`Bun.cron`); no Node target.

## Quickstart (Claude Desktop, Cursor, any stdio client)

```sh
bun install
export YDC_API_KEY=... TYPESAFE_API_KEY=... OPENROUTER_API_KEY=...
bun src/stdio.ts
```

Point your client at `bun src/stdio.ts` (or the published bin:
`bunx @youdotcom-oss/risk-analysis-server`). SQLite lives at
`~/.local/share/risk-analysis-server/risk.sqlite` by default.

## The tools

| Tool | What it does |
| --- | --- |
| `list_risk_profiles` | List active profiles with ids. Call first — don't recreate. |
| `set_risk_profile` | Create/update a profile: title, locations, triggers. |
| `trigger_manual_sweep` | **Fire-and-poll**: call with `profileId` → instant `task_id`; call with `task_id` every ~20s until `completed`/`failed` (sweeps take 2–3 min). |
| `get_risk_report` | Fetch the latest (or by-id) briefing as GFM Markdown. |
| `set_sweep_schedule` | Attach a cron expression to a profile (or omit to clear). |

The sweep pipeline: Stage 1 surface-search triage (Jev `noul`) → Stage 2
agentic query proposal with a relevance gate inside the tool → Stage 3
retrieval + per-result scoring → Stage 4 synthesis into a Markdown briefing.
All payloads are budget-capped; results are stored durably in
`sweep_tasks`/`risk_reports`.

## Scheduling

- **In conversation**: `set_sweep_schedule` with a cron expression
  (`"0 9 * * 1"`) per profile. Runs while a server session is alive.
- **Autonomous**: run the HTTP entry persistently —
  `RISK_JWT_SECRET=... bun src/server.ts` with `RISK_CRON_SCHEDULE`.
  Stored schedules apply at startup; reports accumulate in the DB and are
  readable via `get_risk_report` from any client, any time.

See [DEPLOY.md](./DEPLOY.md) for Docker/Fly/Railway and the full env-var table.

## Architecture in one screen

```
Claude/stdio ──┐
               ├─► src/mcp.ts (shared factory) ──► pipeline/sweep.ts ──► Jev gates
HTTP + cron ───┘        │                            └─► You.com search/contents
   (Bearer JWT)         └─► bun:sqlite (profiles, sweep_tasks, reports)
```

- `src/mcp.ts` — tools + report factory (shared by both transports)
- `src/pipeline/` — sweep orchestration, deep-dive stages, report formatting
- `src/services/` — You.com MCP client, Jev (TypeSafe AI) judgments
- `src/scheduler.ts` — Bun.cron scheduling (global + per-profile)
- `src/db.ts` — SQLite schema + migrations

## For developers

This repo ships three ways to consume it, each with a skill that pins its
contract. Install them into your AI coding agent with the Skills CLI:

```sh
bunx skills add youdotcom-oss/risk-analysis-server
```

or copy `skills/*/SKILL.md` into your agent's skills directory by hand:

- **Run it as-is** → `skills/local-run`
- **Embed it in your Bun app** (your auth, your hosting) → `skills/import-integration`
- **Fork and change behavior** (model, tools, report shape) → `skills/extend`
- **Drive it from a chat client** (the poll protocol, report reading) → `skills/drive-sweeps`

Development loop: `bun run check` (skills + biome + types), `bun test`,
`bun run build`. `plan.md` (untracked) records design decisions and
deviations; `AGENTS.md` holds repo conventions.

## Environment

Three API keys are required for sweeps: `YDC_API_KEY` (You.com search),
`TYPESAFE_API_KEY` (Jev judgments), `OPENROUTER_API_KEY` (the model, default
`qwen/qwen3.8-27b` — override with `RISK_MODEL`). The server starts and
serves without them; missing keys are named in the startup warnings and
sweeps fail with the specific auth error.

A local model is available via `RISK_PROVIDER=ollama` (`OLLAMA_BASE_URL`
overrides the endpoint; model ids are provider-scoped — Ollama uses tags
like `qwen3.8:27b`). Caveat, measured on a 32GB M2 Pro: local 27B inference
ran ~137s per short reply, making sweep-scale generation impractical —
the cloud provider is the sane default unless you have real GPU capacity.

## License

MIT
