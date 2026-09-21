---
name: import-integration
description: Integrate the risk-analysis server into an existing Bun app as a library, attaching your own auth and hosting. Use when you want your own OAuth/IdP flow or custom HTTP stack rather than deploying the repo as-is.
license: MIT
compatibility: Requires Bun >= 1.2.21, network access, and your own You.com and TypeSafe AI API keys.
---

# Import the server as a library

The package ships raw TypeScript — a Bun project imports it directly, no build
step. The entry points are the `exports` subpaths in package.json:

- `@youdotcom-oss/risk-analysis-server/server` — `createApp` (HTTP entry)
- `.../mcp` — `buildMcpServer` (tools factory)
- `.../pipeline` — `buildSweepDeps`, `runSweep`, `sweepAllProfiles`
- `.../db` — `openDb` — `.../model` — `getModel`
- `.../services/you` and `.../services/jev` — the You.com and Jev clients

## Steps

1. `bun add @youdotcom-oss/risk-analysis-server`
   (note the spelling: `analysis` — the published name has this typo).
2. In your own Bun entry point, build the app with your auth:

```ts
import { createApp } from '@youdotcom-oss/risk-analysis-server/server'

const app = createApp({
  db: openDb('risk.sqlite'),
  jwtSecret: process.env.JWT_SECRET!,
  verifyBearer: async (req) => {
    // your IdP / OAuth introspection here; return null to reject
  },
  sweepRunnerFactory: (deps) => /* wire buildSweepDeps for that tenant */,
})
```

3. Set `allowedHosts` on the app for your public hostname (DNS-rebinding
   protection rejects unknown `Host` headers).
4. Scheduled sweeps: pass `scheduler` (a `ProfileScheduler` wired with your
   sweep implementation) to `createApp` and either set `cronSchedule` for a
   global schedule or let users manage per-profile schedules via the
   `set_sweep_schedule` tool. (`RISK_CRON_SCHEDULE` only applies when running
   this repo's own entries directly.)

## Verify

`bun run check && bun test` in the consuming project; the exports smoke test
(`src/tests/exports.spec.ts`) in this repo proves the surface resolves.

## Gotchas

- The per-request factory in `createApp` runs per MCP request — keep the
  `verifyBearer` cheap; it runs on every `/mcp` call.
- The `verifyBearer` return `sub` becomes the tenant id and the MCP session
  user. Pick a stable value (user id or org id), not an email that changes.
- For a full OAuth 2.1 flow instead of bearer HMAC, use the MCP SDK's
  `verifyBearerToken` and the authorization-serving docs:
  https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html
