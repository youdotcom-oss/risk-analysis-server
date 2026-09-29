import type { RankedQuery, RiskProfile, ScoredResult, SystemOneCaller } from './jev.ts'
import { assessSeverity, rankQueries, scoreResults, triageThreat } from './jev.ts'
import { type SweepUsage, trackJevUsage } from './usage.ts'

/**
 * The pipeline's judgment boundary. Four typed decisions, made per sweep:
 * escalate-or-not (triage), which candidate queries to spend (rank), how
 * relevant each result is (score), and how bad the situation is (severity).
 *
 * Two implementations exist: createJevJudge (TypeSafe's Jev — typed answers,
 * batched, output free) and createQwenJudge (the ablation judge — a
 * generative model answering the same questions in strict JSON, so the
 * article's comparison holds the pipeline constant and swaps only the judge).
 */
export type Judge = {
  triage(profile: RiskProfile, highlights: string[], usage: SweepUsage): Promise<number>
  rankQueries(profile: RiskProfile, queries: string[], usage: SweepUsage): Promise<RankedQuery[]>
  scoreResults(
    profile: RiskProfile,
    results: { url: string; title?: string; snippet: string; attribution?: string[]; asOf?: string }[],
    usage: SweepUsage,
  ): Promise<ScoredResult[]>
  assessSeverity(profile: RiskProfile, results: ScoredResult[], usage: SweepUsage): Promise<string>
}

/**
 * Jev-backed judge. Tallies token usage into the ledger's jev fields via
 * trackJevUsage — Jev bills input at its listed rate and output is free.
 */
export function createJevJudge(jev: SystemOneCaller): Judge {
  return {
    triage: (profile, highlights, usage) => triageThreat(trackJevUsage(jev, usage), profile, highlights),
    rankQueries: (profile, queries, usage) => rankQueries(trackJevUsage(jev, usage), profile, queries),
    scoreResults: (profile, results, usage) => scoreResults(trackJevUsage(jev, usage), profile, results),
    assessSeverity: (profile, results, usage) => assessSeverity(trackJevUsage(jev, usage), profile, results),
  }
}
