# Deployment

The server is Bun-native (`bun:sqlite`, `Bun.cron`, web-standard HTTP). There is
no Node build target — run everything with Bun.

## Local stdio (Claude Desktop, Cursor, Zed)

```sh
bun install
export YDC_API_KEY=... TYPESAFE_API_KEY=...
bun src/stdio.ts
```

Points the client at the executable. SQLite defaults to `./risk.sqlite`;
override with `RISK_DB_PATH`.

## Local HTTP

```sh
export RISK_JWT_SECRET=... YDC_API_KEY=... TYPESAFE_API_KEY=...
bun src/server.ts
```

- `POST /mcp` — MCP over Streamable HTTP. Requires `Authorization: Bearer <jwt>`;
  the token's `sub` becomes the tenant id (provisioned on first use).
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata for OAuth clients.
- `RISK_CRON_SCHEDULE` (cron expression, interpreted in UTC) enables the weekly
  sweep engine across all tenants. Defaults to disabled.

## Docker

```sh
export RISK_JWT_SECRET=... YDC_API_KEY=... TYPESAFE_API_KEY=...
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
`YDC_API_KEY`, and `TYPESAFE_API_KEY`, and mount a volume at `/data`.
Do not run the HTTP entry on a private VPS port without TLS in front —
bearer tokens must travel over HTTPS.

## Environment reference

| Variable | Used by | Meaning |
| --- | --- | --- |
| `RISK_DB_PATH` | both entries | SQLite file path (WAL mode) |
| `RISK_JWT_SECRET` | `server.ts` | HMAC secret for bearer JWT verification |
| `RISK_CRON_SCHEDULE` | `server.ts` | cron expression for the sweep engine (UTC) |
| `RISK_ALLOWED_HOSTS` | `server.ts` | comma-separated hostnames for DNS-rebinding protection |
| `RISK_ISSUER_URL` | `server.ts` | advertised authorization server for OAuth clients |
| `YDC_API_KEY` | both | You.com API key (hosted MCP server auth) |
| `YDC_MCP_URL` | both | override for local You.com MCP package testing |
| `TYPESAFE_API_KEY` | both | TypeSafe AI (Jev) API key |
| `OLLAMA_BASE_URL` | both | Ollama endpoint for the proposal/synthesis model |
| `RISK_MODEL` | both | model id (default `muse-glimmer`) |
