import { createOpenRouter } from '@openrouter/ai-sdk-provider'

// Cloud-only model factory. Ollama was removed: a 30B local model on a
// 32GB M2 Pro is too slow for sweep-scale generation (multi-minute LLM
// calls, dropped sockets) and duplicated provider plumbing. If a local
// provider returns, re-add it as an explicit RISK_PROVIDER branch here.
export function getModel() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required for the sweep model')
  }
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  return openrouter.chat(process.env.RISK_MODEL ?? 'qwen/qwen3.8-27b')
}
