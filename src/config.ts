import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Stable per-user data dir for the default DB. Entrypoints must not use a
 * cwd-relative path: GUI launchers (Claude Desktop etc.) run with an
 * unwritable cwd like `/`, which fails SQLITE_CANTOPEN.
 */
export function defaultDbPath(env: Record<string, string | undefined> = process.env): string {
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  const dir = join(dataHome, 'risk-analysis-server')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'risk.sqlite')
}

/**
 * Startup configuration messaging. Names missing API keys and their
 * consequence so misconfiguration is visible at startup instead of
 * surfacing as empty results or a mid-sweep authentication error.
 * Never echoes key values — only presence.
 */
export function missingKeyWarnings(env: Record<string, string | undefined> = process.env): string[] {
  const warnings: string[] = []
  if (!env.YDC_API_KEY) {
    warnings.push(
      'YDC_API_KEY not set: the hosted You.com MCP server falls back to its free tier (you-search only, rate-limited, no contents).',
    )
  }
  if (!env.TYPESAFE_API_KEY) {
    warnings.push('TYPESAFE_API_KEY not set: Jev gates will fail on the first sweep (AuthenticationError).')
  }
  if (!env.OPENROUTER_API_KEY) {
    warnings.push('OPENROUTER_API_KEY not set: the sweep model cannot be constructed; manual sweeps will fail.')
  }
  return warnings
}
