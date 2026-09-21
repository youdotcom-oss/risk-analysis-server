---
name: drive-sweeps
description: Drive the risk-analysis MCP server from a chat client (Claude Desktop, Cursor, etc.). Use when connected to the risk-analysis server and asked to create risk profiles, run sweeps, or read risk reports — covers the two-call poll protocol (sweeps return a task_id immediately and run for 2-3 minutes in the background) and report retrieval via get_risk_report.
license: MIT
compatibility: Requires an MCP client connection to the risk-analysis server (stdio or HTTP entry) with YDC_API_KEY, TYPESAFE_API_KEY, and OPENROUTER_API_KEY configured.
---

# Drive risk sweeps from a chat client

The server exposes five tools. Work them in this order.

## The tool set

| Tool | Purpose |
| --- | --- |
| `list_risk_profiles` | List active profiles with ids. **Always call this first** — do not recreate profiles that already exist. |
| `set_risk_profile` | Create or update a profile: `title`, `locations`, `triggers`. Returns the full profile JSON including `id`. |
| `trigger_manual_sweep` | Two entry points (see below). |
| `get_risk_report` | Fetch a completed briefing: defaults to latest, or pass `report_id`. Returns GFM Markdown plus a `knowledge` array (licensed facts with `attribution`/`asOf`) — summarize it, don't echo it. |
| `set_sweep_schedule` | Attach a cron expression to a profile (`"0 9 * * 1"`); omit the schedule to clear. Response names its scope: `durable` (server is a supervised service, cron keeps firing) or `session` (fires only while this client is connected). |

## The sweep protocol (two calls)

1. **Start:** call `trigger_manual_sweep` with `profileId`. It returns
   immediately — the tool does NOT block:
   `{ task_id, status: "working", next: "poll with task_id every ~20s" }`.
2. **Poll:** call `trigger_manual_sweep` again with `task_id` every ~20
   seconds. While running: `{ task_id, status: "working", next: ... }`.
   When done: `{ status: "completed", escalated, severity, reportId,
   knowledgeHits }` (or an error result with the failure reason).
   `knowledgeHits` counts licensed knowledge facts that reached the
   briefing — 0 is a valid result for news-shaped profiles.
3. **Read the report even when not escalated.** Below-threshold sweeps
   still persist a low-severity clean-sweep report (signals reviewed,
   triage score) — a report isn't always for action, sometimes it
   documents inaction. Summarize it the same way via `get_risk_report`.

Typical duration is 2-3 minutes (agentic search loop + judgment gates +
cloud-model synthesis). Never assume a timeout means failure — the sweep
keeps running server-side; keep polling.

## Reading the report

- Call `get_risk_report` (optionally with `report_id` from the outcome) and
  summarize the briefing: severity, key findings with source links, and
  recommended mitigations. Knowledge facts cite their licensed provider
  and an as-of date — surface those attributions when they appear.
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
