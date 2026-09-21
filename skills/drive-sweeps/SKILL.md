---
name: drive-sweeps
description: Drive the risk-analysis MCP server from a chat client (Claude Desktop, Cursor, etc.). Use when connected to the risk-analysis server and asked to create risk profiles, run sweeps, or read risk reports — covers the two-call poll protocol (sweeps return a task_id immediately and run for 2-3 minutes in the background) and report retrieval via get_risk_report.
license: MIT
compatibility: Requires an MCP client connection to the risk-analysis server (stdio or HTTP entry) with YDC_API_KEY, TYPESAFE_API_KEY, and OPENROUTER_API_KEY configured.
---

# Drive risk sweeps from a chat client

The server exposes four tools. Work them in this order.

## The tool set

| Tool | Purpose |
| --- | --- |
| `list_risk_profiles` | List active profiles with ids. **Always call this first** — do not recreate profiles that already exist. |
| `set_risk_profile` | Create or update a profile: `title`, `locations`, `triggers`. Returns the full profile JSON including `id`. |
| `trigger_manual_sweep` | Two entry points (see below). |
| `get_risk_report` | Fetch a completed briefing: defaults to latest, or pass `report_id`. Returns GFM Markdown — summarize it, don't echo it. |

## The sweep protocol (two calls)

1. **Start:** call `trigger_manual_sweep` with `profileId`. It returns
   immediately — the tool does NOT block:
   `{ task_id, status: "working", next: "poll with task_id every ~20s" }`.
2. **Poll:** call `trigger_manual_sweep` again with `task_id` every ~20
   seconds. While running: `{ task_id, status: "working" }`. When done:
   `{ status: "completed", escalated, severity, reportId }` (or an error
   result with the failure reason).

Typical duration is 2-3 minutes (agentic search loop + judgment gates +
cloud-model synthesis). Never assume a timeout means failure — the sweep
keeps running server-side; keep polling.

## Reading the report

- Call `get_risk_report` (optionally with `report_id` from the outcome) and
  summarize the briefing: severity, key findings with source links, and
  recommended mitigations.
- Briefings are GFM Markdown — cite the key findings with their source
  links and list the mitigations; the report HTML/iframe era is gone.

## Gotchas

- Profiles are tenant-scoped; ids are random UUIDs. After a fresh
  conversation, `list_risk_profiles` is the only reliable way to get one.
- Sweeps are per-profile. Splitting a profile by location is a workaround
  for slow runs, not a requirement — prefer one profile per risk domain and
  let the pipeline cap payloads itself.
- Failed sweeps return `isError` with the upstream error (e.g.
  `max_tokens_exceeded`, rate limits). Report the error verbatim; do not
  retry silently in a loop.
