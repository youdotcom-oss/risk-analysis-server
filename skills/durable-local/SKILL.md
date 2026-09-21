---
name: durable-local
description: Run the risk-analysis HTTP entry as a local durable sweep service so scheduled sweeps fire even when the chat client is closed — start it, authenticate, verify stored cron schedules loaded, and confirm fires happened. Use when a set_sweep_schedule schedule needs to fire after Claude/Cursor closes, when testing autonomous sweeps locally, or when a report should exist that no chat session produced.
license: MIT
compatibility: Requires Bun >= 1.2.21, the repo checkout, and the three API keys (YDC_API_KEY, TYPESAFE_API_KEY, OPENROUTER_API_KEY) in the environment.
---

# Run the server as a local durable sweep service

The stdio entry (what Claude Desktop launches) is a **session**: its cron
fires only while the client is connected. Durable scheduled sweeps need the
**HTTP entry running as its own process** — it applies stored per-profile
schedules at startup and keeps sweeping while the machine is on, whether or
not any chat client is open. Both processes share one SQLite file, so
reports accumulate in one place and `get_risk_report` works from any
session, any time.

For a supervised always-on service (survives reboot/crash), use the
service-manager recipes in `DEPLOY.md` instead — this skill is the quick
unsupervised loop for testing and demos.

## Steps

1. Start the HTTP entry with the keys exported (it requires
   `RISK_JWT_SECRET`):

   ```sh
   export RISK_JWT_SECRET=$(openssl rand -hex 32) \
          YDC_API_KEY=... TYPESAFE_API_KEY=... OPENROUTER_API_KEY=...
   mkdir -p ~/.local/share/risk-analysis-server/logs
   nohup bun run start:http \
     > ~/.local/share/risk-analysis-server/logs/http.log 2>&1 &
   ```

2. Save the secret and mint a long-lived token once (all later steps reuse
   them):

   ```sh
   export RISK_JWT_SECRET_FILE=~/.local/share/risk-analysis-server/http-jwt-secret
   ```
   ```sh
   echo "$RISK_JWT_SECRET" > "$RISK_JWT_SECRET_FILE" && chmod 600 "$RISK_JWT_SECRET_FILE"
   bun -e "import { SignJWT } from 'jose'" # one-time token mint, see below
   ```

   ```sh
   TOKEN=$(RISK_JWT_SECRET=$(cat "$RISK_JWT_SECRET_FILE") bun -e "
     import { SignJWT } from 'jose'
     console.log(await new SignJWT({})
       .setProtectedHeader({ alg: 'HS256' })
       .setSubject('local-user')
       .setIssuedAt()
       .setExpirationTime('365d')
       .sign(new TextEncoder().encode(process.env.RISK_JWT_SECRET)))")
   echo "$TOKEN" > "$RISK_JWT_SECRET_FILE.token"
   ```

   The token's `sub` is the tenant id — keep `local-user` so the service
   reads the same profiles and reports your stdio sessions created.

3. Verify the service is listening and stored schedules loaded:

   ```sh
   curl -s -X POST http://localhost:3000/mcp \
     -H "Authorization: Bearer $(cat "$RISK_JWT_SECRET_FILE.token")" \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_risk_profiles","arguments":{}}}' \
     | grep -o '"sweepSchedule":"[^"]*"'
   ```

   Each non-null `sweepSchedule` is a cron now live in this process.

4. **Prove autonomy**: quit the chat client, wait past the cron time, then
   check the fire landed — the sweep task is created with no chat client
   running:

   ```sh
   sqlite3 ~/.local/share/risk-analysis-server/risk.sqlite \
     "SELECT status, datetime(created_at/1000,'unixepoch') FROM sweep_tasks ORDER BY created_at DESC LIMIT 1;"
   sqlite3 ~/.local/share/risk-analysis-server/risk.sqlite \
     "SELECT p.title, r.severity, r.knowledge_json IS NOT NULL FROM risk_reports r JOIN risk_profiles p ON p.id=r.profile_id ORDER BY r.created_at DESC LIMIT 1;"
   ```

   Or reopen the chat client and ask for the most recent report — the
   sweep fired while no session existed.

## Verify

- `curl http://localhost:3000/mcp` without a token → 401 (auth wired).
- `lsof -iTCP:3000 -sTCP:LISTEN` shows the bun process.
- A `sweep_tasks` row with `status: working`→`completed` at the cron time
  while the chat client is closed is the definitive proof.

## Gotchas

- `nohup` survives terminal close but **not reboot or a crash** — that is
  what the DEPLOY.md service-manager recipes (launchd/systemd) add.
- Reuse the saved `RISK_JWT_SECRET` on restart: a newly generated secret
  invalidates previously minted tokens.
- The HTTP entry's port is Bun's default (3000). If it collides, the
  service fails to start — check `logs/http.log`.
- Manual sweeps and cron fires dedupe within a 10-minute recency window
  (`hasRecentSweep`), so don't expect a second report for a manual run
  right after a scheduled one.
- stdio sessions and the service write the same SQLite file concurrently;
  this is safe (WAL + `busy_timeout`), but quit sessions before deleting
  the database file itself.
