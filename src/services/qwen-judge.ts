import { generateText, type LanguageModel } from 'ai'
import type { RankedQuery, RiskProfile, ScoredResult } from './jev.ts'
import { SEVERITY_LEVELS } from './jev.ts'
import type { Judge } from './judge.ts'
import type { SweepUsage } from './usage.ts'

/**
 * The ablation judge: the same four typed decisions Jev makes, made by a
 * generative model (Qwen via OpenRouter) answering in strict JSON. Same
 * batching (one call per gate), same payloads, same rubric — only the engine
 * changes, so the comparison isolates the judgment layer.
 *
 * Parse failures are findings, not bugs: they are counted in the ledger
 * (judgeMalformed) and fail the sweep loudly. Jev structurally cannot produce
 * a malformed answer; that asymmetry is part of what the ablation measures.
 */

type ScoredCandidate = { url: string; title?: string; snippet: string; attribution?: string[]; asOf?: string }

const JSON_INSTRUCTION = 'Respond with ONLY a single JSON object and nothing else — no markdown fences, no prose.'

function extractJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    throw new Error(`Judge returned unparseable JSON: ${text.slice(0, 200)}`)
  }
}

function totalOf(value: unknown): number {
  if (typeof value === 'number') return value
  if (
    value &&
    typeof value === 'object' &&
    'total' in value &&
    typeof (value as { total: unknown }).total === 'number'
  ) {
    return (value as { total: number }).total
  }
  return 0
}

async function ask(model: LanguageModel, prompt: string, usage: SweepUsage): Promise<unknown> {
  const result = await generateText({ model, prompt: `${prompt}\n\n${JSON_INSTRUCTION}` })
  const u = result.usage as unknown as {
    inputTokens?: unknown
    outputTokens?: unknown
    input_tokens?: unknown
    output_tokens?: unknown
  }
  usage.judgeInputTokens += totalOf(u.inputTokens ?? u.input_tokens)
  usage.judgeOutputTokens += totalOf(u.outputTokens ?? u.output_tokens)
  let parsed: unknown
  try {
    parsed = extractJson(result.text)
  } catch (error) {
    usage.judgeMalformed += 1
    throw error
  }
  return parsed
}

/** Same policy as the Jev judge: licensed provenance earns +1, capped at the rubric top. */
function applyProvenanceBoost(base: number, result: ScoredCandidate, max: number): number {
  return result.attribution?.length ? Math.min(base + 1, max) : base
}

export function createQwenJudge(model: LanguageModel): Judge {
  return {
    async triage(profile: RiskProfile, highlights: string[], usage: SweepUsage): Promise<number> {
      const parsed = (await ask(
        model,
        `Profile: "${profile.title}". Locations: ${profile.locations.join(', ')}. Policy triggers: ${profile.triggers.join(', ')}.` +
          `\n\nEvidence:\n${highlights.join('\n')}\n\n` +
          'Does this evidence indicate a material supply-chain threat for the profile given its policy triggers? ' +
          'Answer as JSON: {"threat": <number between 0 and 1>}',
        usage,
      )) as { threat?: unknown }
      const threat = parsed.threat
      if (typeof threat !== 'number' || threat < 0 || threat > 1) {
        usage.judgeMalformed += 1
        throw new Error(`Judge returned invalid threat: ${JSON.stringify(parsed).slice(0, 200)}`)
      }
      return threat
    },

    async rankQueries(profile: RiskProfile, queries: string[], usage: SweepUsage): Promise<RankedQuery[]> {
      if (queries.length === 0) return []
      const parsed = (await ask(
        model,
        `Profile: "${profile.title}". Locations: ${profile.locations.join(', ')}. Policy triggers: ${profile.triggers.join(', ')}.` +
          `\n\nCandidate search queries:\n${queries.map((q, i) => `${i}. ${q}`).join('\n')}\n\n` +
          'For EACH candidate query, judge: would it precisely surface supply-chain disruptions for this profile? ' +
          'It must contain a strict geospatial identifier and avoid broad generic keywords. ' +
          'Score each query 0 to 1. Answer as JSON: {"scores": [{"query": "<the candidate query verbatim>", "noul": <0..1>]}] — one entry per candidate, no omissions.',
        usage,
      )) as { scores?: { query?: unknown; noul?: unknown }[] }
      const entries = parsed.scores
      if (!Array.isArray(entries)) {
        usage.judgeMalformed += 1
        throw new Error('Judge returned no scores array for query ranking')
      }
      const byQuery = new Map<string, number>()
      for (const entry of entries) {
        if (typeof entry.query === 'string' && typeof entry.noul === 'number') byQuery.set(entry.query, entry.noul)
      }
      const ranked: RankedQuery[] = []
      for (const query of queries) {
        const noul = byQuery.get(query)
        if (noul === undefined) {
          usage.judgeMalformed += 1
          throw new Error(`Judge ranking missing candidate: ${query.slice(0, 200)}`)
        }
        ranked.push({ query, noul })
      }
      return ranked.sort((a, b) => b.noul - a.noul)
    },

    async scoreResults(profile: RiskProfile, results: ScoredCandidate[], usage: SweepUsage): Promise<ScoredResult[]> {
      const parsed = (await ask(
        model,
        `Profile: "${profile.title}". Locations: ${profile.locations.join(', ')}. Policy triggers: ${profile.triggers.join(', ')}.` +
          `\n\nResults:\n${results.map((r, i) => `${i}. ${r.snippet}${r.attribution?.length ? ` (licensed ${r.attribution.join(', ')} data${r.asOf ? ` as of ${r.asOf}` : ''})` : ''}`).join('\n')}\n\n` +
          'Score EACH result against this ordered rubric: 0 = not relevant to the profile or its policy triggers; ' +
          '1 = marginally relevant (touches the locations or triggers, but not both); ' +
          '2 = highly relevant (concrete disruption at a profile location matching a policy trigger). ' +
          'Answer as JSON: {"scores": [{"index": <result number>, "score": <0|1|2>]}] — one entry per result, no omissions.',
        usage,
      )) as { scores?: { index?: unknown; score?: unknown }[] }
      const entries = parsed.scores
      if (!Array.isArray(entries)) {
        usage.judgeMalformed += 1
        throw new Error('Judge returned no scores array for result scoring')
      }
      const byIndex = new Map<number, number>()
      for (const entry of entries) {
        if (typeof entry.index === 'number' && typeof entry.score === 'number') byIndex.set(entry.index, entry.score)
      }
      return results.map((result, index) => {
        const base = byIndex.get(index)
        if (base === undefined || !Number.isInteger(base) || base < 0 || base > 2) {
          usage.judgeMalformed += 1
          throw new Error(`Judge returned out-of-range result score: ${base}`)
        }
        return { ...result, score: applyProvenanceBoost(base, result, 2) }
      })
    },

    async assessSeverity(profile: RiskProfile, results: ScoredResult[], usage: SweepUsage): Promise<string> {
      const parsed = (await ask(
        model,
        `Profile: "${profile.title}". Locations: ${profile.locations.join(', ')}. Policy triggers: ${profile.triggers.join(', ')}.` +
          `\n\nScored evidence:\n${results.map((r) => `- ${r.snippet} (relevance ${r.score})`).join('\n') || '(none)'}\n\n` +
          'How severe is the current supply-chain situation for the profile? ' +
          'low: no material disruption expected; routine monitoring suffices. ' +
          'medium: notable disruption risk; mitigation planning recommended. ' +
          'critical: active disruption at a profile location; immediate action needed. ' +
          'Answer as JSON: {"severity": "low" | "medium" | "critical"}',
        usage,
      )) as { severity?: unknown }
      const severity = parsed.severity
      if (typeof severity !== 'string' || !(severity in SEVERITY_LEVELS)) {
        usage.judgeMalformed += 1
        throw new Error(`Judge returned invalid severity: ${JSON.stringify(parsed).slice(0, 200)}`)
      }
      return severity
    },
  }
}
