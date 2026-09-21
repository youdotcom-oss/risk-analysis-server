# Deployment

The server is Bun-native (`bun:sqlite`, `Bun.cron`, web-standard HTTP). There is
no Node build target — run everything with Bun.

## Local stdio (Claude Desktop, Cursor, Zed)

```sh
bun install
export YDC_API_KEY=... TYPESAFE_API_KEY=... OPENROUTER_API_KEY=...
bun src/stdio.ts
```

Points the client at the executable. SQLite defaults to
`~/.local/share/risk-analysis-server/risk.sqlite` (`XDG_DATA_HOME`
respected); override with `RISK_DB_PATH`. A `RISK_CRON_SCHEDULE` here runs
session-scoped cron sweeps (they stop when the client disconnects).

## Local HTTP

```sh
export RISK_JWT_SECRET=... YDC_API_KEY=... TYPESAFE_API_KEY=... OPENROUTER_API_KEY=...
bun src/server.ts
```

- `POST /mcp` — MCP over Streamable HTTP. Requires `Authorization: Bearer <jwt>`;
  the token's `sub` becomes the tenant id (provisioned on first use).
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata for OAuth clients.
- `RISK_CRON_SCHEDULE` (cron expression, UTC) enables scheduled sweeps across
  all tenants; per-profile schedules set via the `set_sweep_schedule` tool are
  also applied at startup. Defaults to disabled.

## Docker

```sh
export RISK_JWT_SECRET=... YDC_API_KEY=... TYPESAFE_API_KEY=... OPENROUTER_API_KEY=...
docker compose up --build
```

- Multi-stage `oven/bun:1-alpine` image; SQLite persisted on the `risk-data`
  volume at `/data/risk.sqlite`.
- Set `RISK_ALLOWED_HOSTS` to your public hostname(s) when exposing the port —
  DNS-rebinding protection rejects unknown `Host` headers.
- Run the stdio entry in a container (for piped transports):
  `docker run ... <image> bun src/stdio.ts`

## Fly.io / Railway / VPS

Any runtime that runs the image works: deploy the Dockerfile, set
`RISK_JWT_SECRET`, `RISK_ALLOWED_HOSTS` (public hostname), `RISK_CRON_SCHEDULE`,
`YDC_API_KEY`, `TYPESAFE_API_KEY`, and `OPENROUTER_API_KEY`, and mount a volume
at `/data`.
Do not run the HTTP entry on a private VPS port without TLS in front —
bearer tokens must travel over HTTPS.

## Running the HTTP entry as a local service

The stdio entry is a **session**: its cron only fires while the client is
connected. Durable scheduled sweeps need the **HTTP entry running as a
supervised service**, independent of any chat client. Service and stdio
session share one SQLite file, so reports accumulate in one place and
`get_risk_report` works from any client, any time — ask "most recent report
on X" hours later and read whatever the service swept meanwhile.

The contract the service manager supervises is just `bun run start:http`:
it registers the `ProfileScheduler` at startup (stored per-profile crons +
`RISK_CRON_SCHEDULE` global), `set_sweep_schedule` registers live, and
`RISK_JWT_SECRET` is required. Restart-on-crash is the service manager's
whole job (`KeepAlive` / `Restart=always` / restart-on-failure). No
detached children are spawned by the server itself — one supervised
process, uniform role on every OS.

### macOS — launchd

Create `~/Library/LaunchAgents/com.risk-analysis-server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.risk-analysis-server</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/.bun/bin/bun</string>
    <string>run</string><string>start:http</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/Workspace/risk-analysis-server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>RISK_JWT_SECRET</key><string>generate-one</string>
    <key>YDC_API_KEY</key><string>...</string>
    <key>TYPESAFE_API_KEY</key><string>...</string>
    <key>OPENROUTER_API_KEY</key><string>...</string>
    <key>RISK_MODEL</key><string>qwen/qwen3.8-27b</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/risk-analysis-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/risk-analysis-server.err</string>
</dict></plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.risk-analysis-server.plist
launchctl list | grep risk-analysis   # verify
```

launchd does **not** source `~/.zprofile` — keys must be in the plist's
`EnvironmentVariables` (or a wrapper script that sources it).

### Linux — systemd (user unit)

`~/.config/systemd/user/risk-analysis.service`:

```ini
[Unit]
Description=risk-analysis MCP server (HTTP entry)

[Service]
ExecStart=%h/.bun/bin/bun run start:http
WorkingDirectory=%h/Workspace/risk-analysis-server
Environment=RISK_JWT_SECRET=generate-one
Environment=YDC_API_KEY=...
Environment=TYPESAFE_API_KEY=...
Environment=OPENROUTER_API_KEY=...
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now risk-analysis
systemctl --user status risk-analysis
```

(`loginctl enable-linger YOU` keeps it running after you log out.)

### Windows — Task Scheduler

1. Create a task triggering **At startup** / **At log on**.
2. Action: `C:\Users\YOU\.bun\bin\bun.exe run start:http`, start-in
   the repo directory.
3. Settings: **Restart on failure**, or wrap with
   [NSSM](https://nssm.cc/) (`nssm install risk-analysis ...`) for full
   service semantics.
4. Set env vars as user environment variables — GUI-launched processes
   don't read shell profiles.

### Verifying it all works

1. `bun run start:http` in a terminal → start Claude (stdio entry) →
   `set_sweep_schedule` a profile for a minute from now.
2. **Quit Claude.** Wait past the cron time.
3. Relaunch Claude → `get_risk_report` → the sweep fired while it was
   closed: a fresh report (briefing with licensed data, or the
   low-severity clean-sweep record). That's the whole demo.

## Environment reference

| Variable | Used by | Meaning |
| --- | --- | --- |
| `RISK_DB_PATH` | both entries | SQLite file path (WAL mode) |
| `RISK_JWT_SECRET` | `server.ts` | HMAC secret for bearer JWT verification |
| `RISK_CRON_SCHEDULE` | both entries | global cron schedule for sweeps (UTC); stdio sessions scope it to their lifetime |
| `RISK_ALLOWED_HOSTS` | `server.ts` | comma-separated hostnames for DNS-rebinding protection |
| `RISK_ISSUER_URL` | `server.ts` | advertised authorization server for OAuth clients |
| `OPENROUTER_API_KEY` | both | OpenRouter API key for the sweep model |
| `YDC_API_KEY` | both | You.com API key (hosted MCP server auth) |
| `YDC_MCP_URL` | both | override for local You.com MCP package testing |
| `TYPESAFE_API_KEY` | both | TypeSafe AI (Jev) API key |
| `RISK_MODEL` | both | OpenRouter model id (default `qwen/qwen3.8-27b`) |
