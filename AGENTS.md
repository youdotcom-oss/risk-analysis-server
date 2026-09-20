# Agent Instructions

This repo packages You.com risk analysis server package. Keep changes small, verified, and tied to the requested surface.

## Tooling discovery

- Prefer Bun for TypeScript, scripts, orchestration, and running checks. Use Bun to trigger Python and TypeScript tooling unless an existing script says otherwise.
- Bun MCP docs: https://bun.com/docs/mcp
- Before choosing commands, scan `package.json` scripts and `biome.json`. Do not guess command names.
- Checks currently flow through Bun: `bun test`, `bun run check`, `bun run check:types`, `bun run check:ts`, `bun run check:package`.

## Minimal-implementation directive

Before writing code, resolve the task at the FIRST step that holds:

1. Does this capability need to exist for the stated task? If it is speculative, do not build it. Say so in one sentence and stop.
2. Does something already in THIS codebase do it? Reuse it. Read before you write; re-implementing a helper that lives three files over is the most common waste.
3. Does the standard library or the runtime/platform already do it? (`<input type="date">`, a DB unique constraint, a CSS rule.) Use it.
4. Does an already-installed dependency do it? Use it. Do not add a new dependency for something a few lines cover.
5. Can it be one clear expression? Write the one expression.
6. Otherwise: the smallest code that fully handles the task.

NON-NEGOTIABLE FLOOR: none of the steps above may remove any of these, and "minimal" is never a reason to drop them:

- input validation at trust boundaries (anything crossing a process, network, file, or user edge),
- error handling that prevents data loss or silent corruption,
- authn/authz and other security checks,
- accessibility for anything a human interacts with.

If a step would require cutting one of these, that step does not apply.

Leave exactly one runnable check behind for any non-trivial logic.
Mark deliberate shortcuts with a `MINIMAL:` comment naming the ceiling and the upgrade path, so "later" is greppable instead of forgotten.

## Style enforcement

- TypeScript, JSON, and Markdown formatting/linting are governed by `biome.json` plus `tsc`.
- Read these config files before changing style rules. Keep only conventions not enforced by tools in this file.

## Workflow

- Read existing code before editing. Prefer `Read`, `Grep`, and `Glob` for exploration.
- For PR review work, use `gh` when available and check PR comments, reviews, code scanning alerts, and inline comments.
- Conventional commits only: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `ci:`.

## Verification

- Non-trivial TypeScript/script change: at least `bun test <target>` and `bun run check:types`.
- Formatting/linting: `bun run check:ts` for Biome, `bun run check:package` for package manifests.
- Before final handoff after edits, run the smallest relevant checks plus any requested full checks. Report known pre-existing warnings separately.
