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
  return warnings
}
