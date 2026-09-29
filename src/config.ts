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

export const DEFAULT_TRIAGE_THRESHOLD = 0.5

/**
 * Gate 1 escalation cutoff: escalate the sweep when the triage noul reaches
 * this value. Invalid values fail loudly at startup — a silently-different
 * threshold would invalidate every escalation decision made under it.
 */
export function resolveTriageThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RISK_TRIAGE_THRESHOLD
  if (raw === undefined) return DEFAULT_TRIAGE_THRESHOLD
  const value = Number(raw)
  // Number('') is 0 — an empty value must fail loudly, not mean "never escalate".
  if (raw.trim() === '' || Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(`RISK_TRIAGE_THRESHOLD must be a number in [0, 1], got: "${raw}"`)
  }
  return value
}

export const DEFAULT_MAX_QUERIES = 8

/**
 * How many model-proposed queries execute after Gate 2 ranking. Invalid
 * values fail loudly — a silently-different budget would change the
 * retrieval bill and the report's evidence base without anyone noticing.
 */
export function resolveMaxQueries(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RISK_MAX_QUERIES
  if (raw === undefined) return DEFAULT_MAX_QUERIES
  const value = Number(raw)
  // Number('') is 0 — an empty value must fail loudly, not mean "execute none".
  if (raw.trim() === '' || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error(`RISK_MAX_QUERIES must be an integer in [1, 20], got: "${raw}"`)
  }
  return value
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
