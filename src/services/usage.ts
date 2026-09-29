import type { SystemOneCaller } from './jev.ts'

/**
 * Per-sweep usage ledger. One instance per sweep run (never shared: sweeps
 * run concurrently against shared deps, so a process-wide counter would mix
 * attribution). Rides out on the sweep outcome alongside knowledgeHits so a
 * completed task row self-reports its provider footprint.
 */
export type SweepUsage = {
  jevInputTokens: number
  jevOutputTokens: number
  searchCalls: number
  contentsCalls: number
  /** Ablation (Qwen-as-judge) counters: billed at OpenRouter rates, not Jev's. */
  judgeInputTokens: number
  judgeOutputTokens: number
  judgeMalformed: number
}

export function createSweepUsage(): SweepUsage {
  return {
    jevInputTokens: 0,
    jevOutputTokens: 0,
    searchCalls: 0,
    contentsCalls: 0,
    judgeInputTokens: 0,
    judgeOutputTokens: 0,
    judgeMalformed: 0,
  }
}

type JevUsage = { input_tokens?: number; output_tokens?: number }

/**
 * Wraps the Jev caller so every systemOne response's token usage is tallied
 * into the ledger. Answers pass through untouched — gate logic is unchanged.
 * A missing usage block counts as zero rather than failing the sweep: usage
 * is observability, not a gate.
 */
export function trackJevUsage(jev: SystemOneCaller, usage: SweepUsage): SystemOneCaller {
  const wrapped = {
    systemOne: async (request: Parameters<typeof jev.systemOne>[0]) => {
      const result = await jev.systemOne(request)
      const tokenUsage = (result as { usage?: JevUsage }).usage
      usage.jevInputTokens += tokenUsage?.input_tokens ?? 0
      usage.jevOutputTokens += tokenUsage?.output_tokens ?? 0
      return result
    },
  }
  // The real client returns APIPromise; a plain awaitable is compatible for
  // every in-repo caller (results are always awaited, never asResponse'd).
  return wrapped as unknown as SystemOneCaller
}

/**
 * Composed tracking for one sweep run: wraps the Jev caller with the token
 * tally and returns the ledger to thread through the pipeline deps. You.com
 * call counters live on the ledger itself and are incremented at the
 * pipeline's call sites.
 */
export function buildSweepUsage(jev: SystemOneCaller, usage: SweepUsage): SystemOneCaller {
  return trackJevUsage(jev, usage)
}
