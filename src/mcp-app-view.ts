/**
 * MCP Apps view for the risk report (SEP-1865). Runs inside the host's
 * sandboxed iframe: performs the postMessage handshake via the official App
 * class, then pulls the latest briefing through get_risk_report and renders
 * it. The view owns presentation only — all data comes from server tools.
 */
import { App } from '@modelcontextprotocol/ext-apps'

const container = document.getElementById('report')

function render(html: string): void {
  // The briefing HTML is server-generated with raw markup neutralized
  // (Bun.markdown tagFilter + noHtml* in report.ts) — trusted shell output.
  if (container) container.innerHTML = html
}

function renderError(message: string): void {
  if (container) container.innerHTML = `<p style="font-family: system-ui; color: #b00;">${message}</p>`
}

const app = new App({ name: 'Risk Report', version: '0.0.1' })

async function loadReport(): Promise<void> {
  try {
    const result = await app.callServerTool({
      name: 'get_risk_report',
      arguments: {},
    })
    const text = result.content?.find((c) => c.type === 'text')?.text
    if (!text) {
      renderError('No report data returned.')
      return
    }
    const payload = JSON.parse(text) as { report_html?: string }
    if (payload.report_html) {
      render(payload.report_html)
    } else {
      renderError('Report payload missing report_html.')
    }
  } catch (error) {
    renderError(`Failed to load report: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Pushed results (e.g. a completed sweep poll) also refresh the report.
app.ontoolresult = () => {
  void loadReport()
}

void app.connect().then(() => loadReport())
