---
name: extend
description: Clone this repo as a base and change its behavior - custom auth, a different model, extra tools, or a different report layout. Use when the built-in defaults (HMAC auth, qwen/qwen3.8-27b via OpenRouter, the three-section briefing) don't fit and you want the existing test scaffolding to keep you safe.
license: MIT
compatibility: Requires Bun >= 1.2.21, an OPENROUTER_API_KEY for the default sweep model, and network access for the search and judgment APIs.
---

# Extend the risk-analysis server

## Where things live

| What you want to change | File |
| --- | --- |
| MCP tools / resources | `src/mcp.ts` |
| HTTP auth, tenants, cron | `src/server.ts` |
| Sweep orchestration (triage → deep dive) | `src/pipeline/sweep.ts` |
| Query proposal / retrieval / synthesis | `src/pipeline/deep-dive.ts` |
| Report Markdown assembly | `src/pipeline/report.ts` |
| You.com access (search/contents tools) | `src/services/you.ts` |
| Jev gates (triage, query validation, scoring) | `src/services/jev.ts` |
| Sweep model selection (provider, model id) | `src/model.ts` |
| Storage schema and task lifecycle | `src/db.ts` |

## Steps

1. `git clone` the repo and `bun install`.
2. Run `bun run check && bun test` to confirm the baseline is green.
3. Change the file for your target behavior from the table above. Each module
   has its own test in `src/tests/` that pins its public behavior — change
   behavior by changing the test first, then the implementation.
4. Verify with `bun run check && bun test`. All green means your change is
   behavior-complete against the pinned contracts.

## Deploy your extension

The `assets/` folder in this skill holds the container recipe this repo uses:

- `assets/Dockerfile` — multi-stage `oven/bun:1-alpine` image, `/data` volume
  for the SQLite database.
- `assets/docker-compose.yml` — local orchestration with env wiring.

Copy them into your fork and set the env vars the compose file expects
(`RISK_JWT_SECRET`, `RISK_ALLOWED_HOSTS`, `RISK_CRON_SCHEDULE`, plus the three
API keys: `YDC_API_KEY`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`). Any host that runs a Bun container works.

## Gotchas

- The stdio entry (`src/stdio.ts`) is auth-free by design — do not add auth
  there; the HTTP entry is `src/server.ts`.
- A failed cron handler with an unhandled rejection exits the process; keep
  the per-profile `try/catch` in the cron handler when touching it.
- `buildMcpServer` runs per request on the HTTP entry — do not capture
  mutable state in the factory closure; tenant state flows through
  `userId` from the bearer token's `sub`.
