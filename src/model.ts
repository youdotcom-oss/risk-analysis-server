import { createOllama } from 'ai-sdk-ollama'

export function getModel() {
  const ollama = createOllama({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/api',
  })
  // MINIMAL: ollama-only factory; cloud provider fallback lands when the
  // pipeline (Phase 3) needs it — add an env-selected provider branch there.
  return ollama.chat(process.env.RISK_MODEL ?? 'muse-glimmer')
}
