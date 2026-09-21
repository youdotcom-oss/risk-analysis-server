---
name: local-run
description: Run the You.com risk-analysis MCP server locally over stdio with Ollama, no auth and no accounts. Use when setting up this repo for a local demo, wiring it into Claude Desktop/Cursor, or verifying a change before pushing.
license: MIT
compatibility: Requires Bun >= 1.2.21, Ollama running locally, and network access for You.com and TypeSafe AI calls.
---

# Run the risk-analysis server locally

## Steps

1. `bun add @youdotcom-oss/risk-analsis-server`
   (note the spelling: `analsis` — the published package name has this typo).
2. Ensure Ollama is running and pull the model: `ollama pull muse-glimmer`
   (override with `RISK_MODEL` if you use a different local model).
3. Set the two API keys: `YDC_API_KEY` (You.com) and `TYPESAFE_API_KEY` (Jev).
4. Start the stdio server with the package's bin entry:
   `bunx @youdotcom-oss/risk-analsis-server` — it seeds a `local-user` tenant
   and opens `risk.sqlite` in the working directory (override with `RISK_DB_PATH`).
5. Point an MCP client at it, e.g. Claude Desktop:
   `{ "command": "bunx", "args": ["@youdotcom-oss/risk-analsis-server"], "cwd": "<project path>" }`.
6. In the client, call `set_risk_profile` once, then `trigger_manual_sweep`
   with the returned profile id. The briefing lands at `ui://risk-report/latest`.

## Verify

`bunx @youdotcom-oss/risk-analsis-server` responds to an MCP `initialize`
request over stdin/stdout — e.g. pipe a JSON-RPC `initialize` message in and
confirm a `serverInfo` response comes back.

## Gotchas

- No auth and no user concept in stdio mode: every profile belongs to the
  seeded `local-user`. Auth belongs in the HTTP entry (`src/server.ts`), which
  consumers reach via the import-integration skill instead.
- `trigger_manual_sweep` runs synchronously — the sweep completes before the
  tool result returns. Do not add MCP task machinery to make it async; SDK v2
  2.0.0 has no task runtime.
- Missing `YDC_API_KEY` silently drops the auth header, not the request — the
  hosted You.com server then falls back to its free tier for `you-search`.
  If results look empty, the key is missing, not the integration.
- Developing this repo itself? Clone it and run `bun src/stdio.ts` from the
  checkout instead — that path is for contributors, not consumers.
