import type { ProfileRecord } from './sweep.ts'

type Severity = 'low' | 'medium' | 'critical'

export type KnowledgeFact = {
  title: string
  description: string
  attribution?: string[]
  asOf?: string
}

export type ReportInput = {
  profile: ProfileRecord
  severity: Severity
  /** Model markdown: ## Summary, ## Key findings, ## Recommended mitigations. */
  markdown: string
  generatedAt: number
  /** Licensed knowledge facts that reached synthesis (provenance for humans). */
  knowledgeFacts?: KnowledgeFact[]
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
  const licensed = (input.knowledgeFacts ?? [])
    .map(
      (fact) =>
        `- **${fact.title}** — ${fact.description}` +
        (fact.attribution?.length ? ` (per ${fact.attribution.join(', ')}` : '') +
        (fact.asOf ? `, as of ${fact.asOf}` : '') +
        (fact.attribution?.length ? ')' : ''),
    )
    .join('\n')
  const licensedSection = licensed ? [``, `## Licensed data`, ``, licensed, ``].join('\n') : ''
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
    licensedSection,
    '',
  ].join('\n')
}
