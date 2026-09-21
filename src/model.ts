import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createOllama } from 'ai-sdk-ollama'

/**
 * Model factory with an explicit provider switch:
 *
 * - `RISK_PROVIDER=ollama` → local Ollama (`OLLAMA_BASE_URL` overrides
 *   `http://localhost:11434`; `RISK_MODEL` is an Ollama tag — provider-scoped,
 *   default `qwen3.8:27b`). Measured on a 32GB M2 Pro (2026-09-21): 137s for a
 *   one-token reply, i.e. sweep-scale generation (15+ LLM calls per sweep) is
 *   impractical locally — expect multi-minute calls and socket drops. Kept for
 *   larger machines / privacy-sensitive use; profile before relying on it.
 * - default / `RISK_PROVIDER=openrouter` → OpenRouter (`OPENROUTER_API_KEY`
 *   required; `RISK_MODEL` is an OpenRouter id, default `qwen/qwen3.8-27b`).
 */
export function getModel() {
  const provider = process.env.RISK_PROVIDER ?? 'openrouter'
  if (provider === 'ollama') {
    const ollama = createOllama({
      // MINIMAL: SDK appends /api/chat itself — base URL must NOT include /api.
      baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    })
    return ollama.chat(process.env.RISK_MODEL ?? 'qwen3.8:27b')
  }
  if (provider !== 'openrouter') throw new Error(`Unknown RISK_PROVIDER: ${provider}`)
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is required for the sweep model (or set RISK_PROVIDER=ollama for a local model)',
    )
  }
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  return openrouter.chat(process.env.RISK_MODEL ?? 'qwen/qwen3.8-27b')
}
