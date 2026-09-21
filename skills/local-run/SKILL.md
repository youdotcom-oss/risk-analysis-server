---
name: local-run
description: Run the You.com risk-analysis MCP server locally over stdio, no auth and no accounts. Use when setting up this repo for a local demo, wiring it into Claude Desktop/Cursor, or verifying a change before pushing.
license: MIT
compatibility: Requires Bun >= 1.2.21, an OPENROUTER_API_KEY (sweep model), YDC_API_KEY (You.com), and TYPESAFE_API_KEY (Jev) — network access for all three.
---

# Run the risk-analysis server locally

## Steps

1. `bun add @youdotcom-oss/risk-analsis-server`
   (note the spelling: `analsis` — the published package name has this typo).
2. Set the three API keys: `OPENROUTER_API_KEY` (sweep model — required;
   `RISK_MODEL` selects the model, default `qwen/qwen3.8-27b`), `YDC_API_KEY`
   (You.com), and `TYPESAFE_API_KEY` (Jev).
3. Start the stdio server with the package's bin entry:
   `bunx @youdotcom-oss/risk-analsis-server` — it seeds a `local-user` tenant
   and opens the database at
   `~/.local/share/risk-analysis-server/risk.sqlite` (`XDG_DATA_HOME` is
   respected; override with `RISK_DB_PATH`).
4. Point an MCP client at it, e.g. Claude Desktop:
   `{ "command": "bunx", "args": ["@youdotcom-oss/risk-analsis-server"], "cwd": "<project path>" }`.
5. In the client, call `set_risk_profile` once, then `trigger_manual_sweep`
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
- Missing `OPENROUTER_API_KEY` is named in the startup stderr warning and
  makes `trigger_manual_sweep` fail on model construction.
- GUI launchers (Claude Desktop) run the server via a login shell that does
  not source `~/.zshrc` — put the API keys in `~/.zprofile` or the config's
  `env` block. A cwd-relative `RISK_DB_PATH` is unnecessary: the default
  database path is already stable and writable.
- A manual sweep takes ~60–120s (agentic search loop + judgment gates +
  synthesis through the cloud model); the tool call stays open until done.
- Developing this repo itself? Clone it and run `bun src/stdio.ts` from the
  checkout instead — that path is for contributors, not consumers.
