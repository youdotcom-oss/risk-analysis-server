# Risk Analysis Server

A guide/cookbook MCP server demonstrating how You.com's **knowledge
parameter** composes with an agentic risk pipeline. Define a risk profile —
a topic, the geographic locations to watch, and the policy triggers that
matter — and the server runs an agentic sweep:

- **You.com search with `knowledge: "core"`** — alongside web results, the
  sweep pulls licensed factual answers (e.g. financials from Fiscal.ai)
  into the synthesis, verified end-to-end via `results.knowledge`
- **Jev judgments** (TypeSafe AI) — `noul`/`score`/`choice` gates at every
  stage: triage, query relevance, per-result scoring, severity
- **Vercel AI SDK** — the agentic proposal loop runs on `generateText`
  with tools, on OpenRouter (default `qwen/qwen3.8-27b`)

The output is a source-linked Markdown briefing readable from any MCP
client. Runs on Bun only (`bun:sqlite`, `Bun.cron`); no Node target.

## Quickstart (Claude Desktop, Cursor, any stdio client)

```sh
bun install
export YDC_API_KEY=... TYPESAFE_API_KEY=... OPENROUTER_API_KEY=...
bun src/stdio.ts
```

Point your client at `bun src/stdio.ts` (or the published bin:
`bunx @youdotcom-oss/risk-analysis-server`). SQLite lives at
`~/.local/share/risk-analysis-server/risk.sqlite` by default.

## First run

Paste one of these into your client after connecting:

1. > Create a risk profile "PNW data center buildout" watching Oregon, Washington, and California with these triggers: data center moratoriums and permitting pauses, power grid capacity constraints, electricity price today. Then run a manual sweep for it and summarize the report when done — note whether the report cites a live electricity price.
2. > Create a risk profile "US AI lab operations" watching Taiwan and the United States with these triggers: TSMC revenue latest quarter, chip export policy changes, electricity price today, interest rate today. Then run a manual sweep for it and summarize the report when done.
3. > Create a risk profile "Gulf AI infrastructure" watching Saudi Arabia with these triggers: crude oil price today, weather in Riyadh, Gulf shipping and infrastructure security, chip export policy changes. Then run a manual sweep for it and summarize the report when done.

The tool descriptions carry the protocol (start → poll until
`completed`/`failed`); expect ~2–3 minutes. The completed outcome includes
`knowledgeHits` — the count of licensed knowledge facts that reached the
briefing — so you can verify knowledge influenced the result. Every Stage-3 search runs
with `knowledge: "core"`: fact-shaped queries (prices, rates, revenues,
weather) return licensed answers in `results.knowledge` (Fiscal.ai, S&P
Global, BLS, EIA, AccuWeather) that flow into the briefing **with
provenance** — provider attribution and an `as_of` date, so the briefing
can say what a fact was true as of; news-shaped
queries simply omit the key. The second prompt is the most likely to
show knowledge at work — TSMC revenue, electricity price, and interest
rate are all verified to return licensed results (Fiscal.ai, BLS,
Federal Reserve).

## The tools

| Tool | What it does |
| --- | --- |
| `list_risk_profiles` | List active profiles with ids. Call first — don't recreate. |
| `set_risk_profile` | Create/update a profile: title, locations, triggers. |
| `trigger_manual_sweep` | **Fire-and-poll**: call with `profileId` → instant `task_id`; call with `task_id` every ~20s until `completed`/`failed` (sweeps take 2–3 min). |
| `get_risk_report` | Fetch the latest (or by-id) briefing as GFM Markdown, plus a `knowledge` array carrying each licensed fact's `attribution` and `as_of`. |
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
  readable via `get_risk_report` from any client, any time. To keep
  sweeping after you close the chat client, run it as a supervised local
  service (launchd / systemd / Task Scheduler) — recipes in
  [DEPLOY.md](./DEPLOY.md#running-the-http-entry-as-a-local-service).

See [DEPLOY.md](./DEPLOY.md) for Docker/Fly/Railway and the full env-var table.

## Resetting local state

Reports, profiles, and sweep tasks live in one SQLite file. To start over:

```sh
sqlite3 ~/.local/share/risk-analysis-server/risk.sqlite \
  "DELETE FROM risk_reports; DELETE FROM sweep_tasks; DELETE FROM risk_profiles; DELETE FROM source_utility;"
```

(Quitting the client first avoids WAL writer contention.)

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

This repo ships four ways to consume it, each with a skill that pins its
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

## License

MIT
