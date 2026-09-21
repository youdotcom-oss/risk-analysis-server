---
name: local-run
description: Run the You.com risk-analysis MCP server locally over stdio with Ollama, no auth and no accounts. Use when setting up this repo for a local demo, wiring it into Claude Desktop/Cursor, or verifying a change before pushing.
license: MIT
compatibility: Requires Bun >= 1.2.21, Ollama running locally, and network access for You.com and TypeSafe AI calls.
---

# Run the risk-analysis server locally

## Steps

1. `bun install` in the repo root.
2. Ensure Ollama is running and pull the model: `ollama pull muse-glimmer`
   (override with `RISK_MODEL` if you use a different local model).
3. Set the two API keys: `YDC_API_KEY` (You.com) and `TYPESAFE_API_KEY` (Jev).
4. Start the stdio server: `bun src/stdio.ts` — it seeds a `local-user` tenant
   and opens `risk.sqlite` in the working directory (override with `RISK_DB_PATH`).
5. Point an MCP client at it, e.g. Claude Desktop:
   `{ "command": "bun", "args": ["src/stdio.ts"], "cwd": "<repo path>" }`.
6. In the client, call `set_risk_profile` once, then `trigger_manual_sweep`
   with the returned profile id. The briefing lands at `ui://risk-report/latest`.

## Verify

`bun run check && bun test` — all green means the local setup is correct.

## Gotchas

- No auth and no user concept in stdio mode: every profile belongs to the
  seeded `local-user`. Do not add auth here; the HTTP entry is `src/server.ts`.
- `trigger_manual_sweep` runs synchronously — the sweep completes before the
  tool result returns. Do not add MCP task machinery to make it async; SDK v2
  2.0.0 has no task runtime.
- Missing `YDC_API_KEY` silently drops the auth header, not the request — the
  hosted You.com server then falls back to its free tier for `you-search`.
  If results look empty, the key is missing, not the integration.
