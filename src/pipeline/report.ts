import type { ProfileRecord } from './sweep.ts'

// MINIMAL: Bun.markdown is an unstable Bun API (documented as such); pinned by
// engines.bun. Upgrade path: swap to a pinned markdown lib if the API breaks.
const RENDER_OPTIONS = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tagFilter: true,
} as const

type Severity = 'low' | 'medium' | 'critical'

const SEVERITY_CLASS: Record<Severity, string> = {
  low: 'severity-low',
  medium: 'severity-medium',
  critical: 'severity-critical',
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&').replaceAll('<', '<').replaceAll('>', '>').replaceAll('"', '"')
}

/**
 * Code-owned shell CSS (the report theme is this constant — no external
 * design file). The model returns Markdown only; Bun.markdown.html() renders
 * it with raw HTML neutralized (tagFilter + noHtml*), and descendant
 * selectors style it — the model never touches markup classes.
 */
const SHELL_CSS = `
:root {
  --bg: #F9F9F9;
  --surface: #FFFFFF;
  --border: #E8E8E8;
  --fg-primary: #202020;
  --fg-secondary: #646464;
  --brand: #4A5EE0;
  --radius-md: 8px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: var(--bg);
  color: var(--fg-primary);
  font-family: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 22px;
}
.report {
  max-width: 720px;
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 24px;
}
.report-head {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.report-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
}
.report-meta {
  margin-top: 4px;
  color: var(--fg-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}
.report-tag {
  display: inline-block;
  margin-top: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  color: #FFFFFF;
}
.severity-low { background: #2EA37C; }
.severity-medium { background: #B8860B; }
.severity-critical { background: #E5484D; }
.report-body h2 {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  margin: 20px 0 8px;
}
.report-body p { margin: 0 0 8px; }
.report-body li { margin-bottom: 4px; }
.report-body a { color: var(--brand); }
.report-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.report-source-count {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--fg-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}
`

export type ReportInput = {
  profile: ProfileRecord
  severity: Severity
  /** Model markdown: ## Summary, ## Key findings, ## Recommended mitigations. */
  markdown: string
  generatedAt: number
}

/** Stage 4 assembly: code-owned shell + Jev severity + model Markdown content. */
export function renderReport(input: ReportInput): string {
  const generated = new Date(input.generatedAt).toISOString().slice(0, 10)
  const locations = input.profile.locations.join(', ')
  const sourceCount = (input.markdown.match(/\]\(https?:\/\//g) ?? []).length
  const body = Bun.markdown.html(input.markdown, RENDER_OPTIONS).trim()
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(input.profile.title)} — risk report</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="report">
  <div class="report-head">
    <h1 class="report-title">${escapeHtml(input.profile.title)}</h1>
    <div class="report-meta">${escapeHtml(locations || 'All locations')} · Generated ${generated}</div>
    <span class="report-tag ${SEVERITY_CLASS[input.severity]}">${input.severity}</span>
  </div>
  <div class="report-body">
${body}
  </div>
  <div class="report-source-count">${sourceCount} linked source${sourceCount === 1 ? '' : 's'}</div>
</div>
</body>
</html>`
}
