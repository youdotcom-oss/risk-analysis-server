# Agent Instructions

This repo packages You.com risk analysis MCP server. Keep changes small, verified, and tied to the requested surface. Read existing code before editing.

## External service docs (source of truth)

- TypeSafe AI / Jev (used by `src/services/jev.ts`): start at https://docs.typesafe.ai/llms.txt —
  read the [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md) and the relevant
  primitive pages (`noul`, `choice`, `score`) before changing gate logic.
- You.com MCP server: https://you.com/docs/build-with-agents/mcp-server.md (tools, scoping,
  free profile).
- MCP SDK v2 serving (Hono): https://ts.sdk.modelcontextprotocol.io/v2/serving/hono.html

## Tooling

- Use Bun for TypeScript, scripts, orchestration, and running checks.
- Don't guess command names — check `package.json` scripts first. Current checks:
  `bun test`, `bun run check`, `bun run check:types`, `bun run check:biome`, `bun run check:write`.

## Minimal-implementation directive

Before writing code, resolve the task at the FIRST step that holds:

1. Does this capability need to exist for the stated task? If speculative, say so in one sentence and stop.
2. Does something already in this codebase do it? Reuse it.
3. Does the standard library or the runtime already do it? Use it.
4. Does an already-installed dependency do it? Use it; don't add a dependency for what a few lines cover.
5. Can it be one clear expression? Write it.
6. Otherwise: the smallest code that fully handles the task.

NON-NEGOTIABLE FLOOR: "minimal" never removes input validation at trust boundaries (anything crossing a process, network, file, or user edge), error handling that prevents data loss or silent corruption, authn/authz or other security checks, or accessibility for anything a human interacts with. If a step requires cutting one of these, that step does not apply.

Leave exactly one runnable check behind for any non-trivial logic. Mark deliberate shortcuts with a `MINIMAL:` comment naming the ceiling and the upgrade path.

## Style

TypeScript, JSON, and Markdown formatting/linting are governed by `biome.json` plus `tsc`. Read those configs before changing style rules; only document conventions the tools don't enforce.

## GitHub CLI

Always use `gh` for GitHub URLs (`gh api`, `gh pr view`, `gh issue view`) — never generic web fetchers.

## Git commits

- Conventional commits only: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`. Never `--no-verify`.
- Wrap commit body lines at 100 chars or less (commitlint enforces this). Prefer `git commit -F /tmp/message.txt` for multi-line messages; use repeated `-m` only for short, pre-checked lines. If commitlint rejects a message, rewrite it with wrapped body lines — don't retry the same shape.
- If `.git/index.lock` exists, assume an interrupted Git operation: confirm no Git/hook process is running, then `rm -f .git/index.lock` before retrying.

## Validation

Before committing, choose validation by area of effect:

- Minimum gate (bounded change, verified by inspection or path/wording-only edits): `bun run check:types` plus targeted tests for the changed surface. State the scope and why the narrower gate suffices.
- Broader validation when runtime behavior, tool behavior, schemas/validators, shared infrastructure, or any broad/uncertain surface changes — e.g. `src/stdio.ts` changes run its tests plus shared checks. Area-aware, not "run unrelated tests."
- Formatting/linting: `bun run check:biome`.
- `docs:` and `chore:` commits may skip executable validation when they don't change behavior.
- Before final handoff, run the smallest relevant checks plus any requested full checks; report known pre-existing warnings separately.