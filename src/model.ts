import { createOpenRouter } from '@openrouter/ai-sdk-provider'

/**
 * Model factory — OpenRouter only. Local Ollama was tried twice and removed
 * both times: measured 137s for a one-token reply on a 32GB M2 Pro (27B
 * class), i.e. sweep-scale generation (15+ LLM calls) is impractical locally.
 * If cloud-free inference becomes viable, add a provider branch here; the
 * git history has the working wiring.
 */
export function getModel() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required for the sweep model')
  }
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  return openrouter.chat(process.env.RISK_MODEL ?? 'qwen/qwen3.8-27b')
}
