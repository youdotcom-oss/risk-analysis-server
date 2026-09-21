import { describe, expect, test } from 'bun:test'
import { renderReport } from '../pipeline/report.ts'

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

describe('renderReport', () => {
  test('builds a self-contained styled document with header, tag, and rendered sections', () => {
    const html = renderReport({
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
    // code-owned header facts
    expect(html).toContain('EU port operations')
    expect(html).toContain('Hamburg Port')
    expect(html).toContain('critical')
    // markdown rendered through Bun.markdown with our classes
    expect(html).toContain('<h2>Summary</h2>')
    expect(html).toContain('A strike at Hamburg Port threatens freight schedules.')
    expect(html).toContain('<a href="https://reuters.example/hamburg">Reuters</a>')
    expect(html).toContain('Recommended mitigations')
    // shell: inline CSS, no external requests
    expect(html).toContain('<style>')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('http-equiv')
  })

  test('model HTML is neutralized: raw tags never reach the output', () => {
    const html = renderReport({
      profile: {
        id: 'p1',
        userId: 'u',
        title: 't',
        locations: [],
        triggers: [],
      },
      severity: 'low',
      markdown: '## Summary\n\nHello <script>alert(1)</script> and <img src=x onerror=alert(1)>',
      generatedAt: 1700000000000,
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    const escapedScript = '&' + 'lt;script' + '&' + 'gt;'
    expect(html).toContain(escapedScript)
  })

  test('severity tag carries text alongside color', () => {
    const html = renderReport({
      profile: {
        id: 'p1',
        userId: 'u',
        title: 't',
        locations: [],
        triggers: [],
      },
      severity: 'medium',
      markdown,
      generatedAt: 1700000000000,
    })
    expect(html).toContain('>medium<')
    expect(html).toContain('severity-medium')
  })
})
