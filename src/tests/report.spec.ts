import { describe, expect, test } from 'bun:test'
import { formatReport } from '../pipeline/report.ts'

const markdown = [
  '## Summary',
  '',
  'A strike at Hamburg Port threatens freight schedules.',
  '',
  '## Key findings',
  '',
  '- Dockers announced a 48h strike ([Reuters](https://reuters.example/hamburg))',
  '',
  '## Recommended mitigations',
  '',
  '1. Reroute containers via Rotterdam',
].join('\n')

describe('formatReport', () => {
  test('prepends code-owned header facts and passes model markdown through untouched', () => {
    const report = formatReport({
      profile: {
        id: 'p1',
        userId: 'u',
        title: 'EU port operations',
        locations: ['Hamburg Port'],
        triggers: [],
      },
      severity: 'critical',
      markdown,
      generatedAt: 1700000000000,
    })
    // header facts are code-owned
    expect(report).toContain('# EU port operations — risk report')
    expect(report).toContain('**Severity:** critical')
    expect(report).toContain('**Locations:** Hamburg Port')
    expect(report).toContain('**Generated:** 2023-11-14')
    expect(report).toContain('**Linked sources:** 1')
    // model markdown is verbatim — links and structure intact for agents
    expect(report).toContain('## Summary')
    expect(report).toContain('[Reuters](https://reuters.example/hamburg)')
    expect(report).toContain('## Recommended mitigations')
    // no HTML shell: agents consume Markdown
    expect(report).not.toContain('<style>')
    expect(report).not.toContain('<div')
  })

  test('model output passes through unescaped — the consumer is an agent, not a browser', () => {
    const report = formatReport({
      profile: { id: 'p1', userId: 'u', title: 't', locations: [], triggers: [] },
      severity: 'low',
      markdown: '## Summary\n\nAngle brackets like <tag> stay literal in Markdown.',
      generatedAt: 1700000000000,
    })
    expect(report).toContain('<tag>')
  })

  test('empty locations render as All locations; source count handles zero', () => {
    const report = formatReport({
      profile: { id: 'p1', userId: 'u', title: 't', locations: [], triggers: [] },
      severity: 'medium',
      markdown: '## Summary\n\nNo links here.',
      generatedAt: 1700000000000,
    })
    expect(report).toContain('**Locations:** All locations')
    expect(report).toContain('**Linked sources:** 0')
  })
})

describe('formatReport licensed data section', () => {
  test('renders knowledge facts with provider, as-of date, and description', () => {
    const report = formatReport({
      profile: { id: 'p1', userId: 'u', title: 'EU port operations', locations: [], triggers: [] },
      severity: 'medium',
      markdown,
      generatedAt: 1700000000000,
      knowledgeFacts: [
        {
          title: 'Hamburg port throughput (Monthly)',
          description: 'Latest throughput was 1.2M TEU in Aug 2026.',
          attribution: ['Fiscal.ai'],
          asOf: '2026-08-31',
        },
      ],
    })
    expect(report).toContain('## Licensed data')
    expect(report).toContain('Hamburg port throughput (Monthly)')
    expect(report).toContain('per Fiscal.ai')
    expect(report).toContain('as of 2026-08-31')
    expect(report).toContain('1.2M TEU')
  })

  test('omits the section when there are no knowledge facts', () => {
    const report = formatReport({
      profile: { id: 'p1', userId: 'u', title: 't', locations: [], triggers: [] },
      severity: 'low',
      markdown,
      generatedAt: 1700000000000,
      knowledgeFacts: [],
    })
    expect(report).not.toContain('## Licensed data')
  })
})
