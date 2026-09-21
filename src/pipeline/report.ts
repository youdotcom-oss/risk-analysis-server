import type { ProfileRecord } from './sweep.ts'

type Severity = 'low' | 'medium' | 'critical'

export type ReportInput = {
  profile: ProfileRecord
  severity: Severity
  /** Model markdown: ## Summary, ## Key findings, ## Recommended mitigations. */
  markdown: string
  generatedAt: number
}

/**
 * Stage 4 assembly: code-owned header facts (profile, date, severity,
 * source count) prepended to the model's Markdown, which is passed through
 * untouched. Agents read Markdown natively — no HTML shell, no rendering.
 */
export function formatReport(input: ReportInput): string {
  const generated = new Date(input.generatedAt).toISOString().slice(0, 10)
  const locations = input.profile.locations.join(', ') || 'All locations'
  const sourceCount = (input.markdown.match(/\]\(https?:\/\//g) ?? []).length
  return [
    `# ${input.profile.title} — risk report`,
    '',
    `- **Severity:** ${input.severity}`,
    `- **Locations:** ${locations}`,
    `- **Generated:** ${generated}`,
    `- **Linked sources:** ${sourceCount}`,
    '',
    '---',
    '',
    input.markdown.trim(),
    '',
  ].join('\n')
}
