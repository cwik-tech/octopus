/**
 * Job Title Summarizer
 *
 * One-shot LLM call that turns a routing brief into a 2-6 word headline used
 * as the execution card title in the admin UI. Always non-blocking from the
 * caller's perspective: timeouts and errors resolve through a deterministic
 * subject fallback so delegation never stalls on title generation.
 */

import { getProvider } from '../../providers/index.js'
import {
  deriveTitleFromBrief,
  isUsableJobTitle,
  sanitizeRawTitle,
} from './job-title-sanitize.js'
import type { ThinkingLevel } from '../../core/types.js'
import { runtimeAppDefaultPair } from '../provider/default-model-selection.js'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

export {
  deriveTitleFromBrief,
  isLazyPrefixOfBrief,
  isUsableJobTitle,
} from './job-title-sanitize.js'

const SYSTEM_PROMPT = [
  'Output a 2-6 word Title-Case headline that names the SUBJECT of the user request. Nothing else.',
  '',
  'INCLUDE: the topic, place, person, company, or thing the request is about.',
  'EXCLUDE: generic verbs like "Write", "Create", "Build", "Evaluate", "Make", "Generate".',
  'EXCLUDE: deliverable words like "one-pager", "report", "overview", "memo" unless they are the only signal of the topic.',
  '',
  'STRICT RULES:',
  '- Output exactly one line, then stop.',
  '- No quotes, no markdown, no trailing period, no explanation, no preamble.',
  '- Never narrate ("I will…", "Let me…", "First, I…", "Reading…").',
  '- Never copy the opening words of the request verbatim.',
  '- Do not read files. Do not run tools. Do not ask questions.',
  '',
  'Good examples:',
  'INPUT: Write a one-page report on Michigan for a general professional audience.',
  'OUTPUT: Michigan State Overview',
  '',
  'INPUT: Write a one-page overview of Krakow, Poland.',
  'OUTPUT: Krakow City Profile',
  '',
  'INPUT: Write a concise one-pager on London for a general professional audience.',
  'OUTPUT: London City Profile',
  '',
  'INPUT: Evaluate the Series A deal for Agridynamics Robotics.',
  'OUTPUT: Agridynamics Series A Review',
  '',
  'INPUT: Build a competitive analysis for Snowflake versus Databricks.',
  'OUTPUT: Snowflake vs Databricks Analysis',
  '',
  'Bad outputs (NEVER do this — they have no subject):',
  '- "Write a one-page overview"',
  '- "Write a concise one-pager"',
  '- "Create a report"',
  '- "Evaluate the deal"',
].join('\n')

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PROVIDER_CONFIG = {
  max_output_tokens: 48,
  reasoning: false,
}

export interface TitleSummarizerConfig {
  provider: string
  model: string
  thinking: ThinkingLevel
  providerConfig?: Record<string, unknown>
}

/**
 * The model this background helper runs with.
 *
 * The helper owns no agent, so it uses the one application default. It never
 * borrows a team setting, and returns `null` when no default is configured
 * rather than reaching for some other model — a missing title is harmless,
 * an unrequested model call is not.
 */
export function resolveTitleSummarizerConfig(): TitleSummarizerConfig | null {
  const appDefault = runtimeAppDefaultPair()
  if (!appDefault) return null
  return {
    provider: appDefault.provider,
    model: appDefault.model,
    thinking: 'low',
  }
}

export function postProcessTitle(raw: string): string | null {
  return sanitizeRawTitle(raw)
}

export async function summarizeJobTitle(params: {
  brief: string
  config: TitleSummarizerConfig
  signal?: AbortSignal
  timeoutMs?: number
  /** See `ConciseTitleInput.onSelected`. */
  onSelected?: (selection: ModelSelectionRecord) => Promise<boolean>
}): Promise<string | null> {
  const trimmedBrief = params.brief.trim()
  if (!trimmedBrief) return null

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutController.signal])
    : timeoutController.signal

  try {
    // Nothing is recorded for a call that will not be made. Recording first is
    // what keeps an account of a model that was about to run; on an already
    // cancelled request there is no such model, and the record would name one
    // that was asked for nothing.
    if (signal.aborted) return deriveTitleFromBrief(trimmedBrief)
    // Recorded before anything is sent. Naming a delegated job owns no Agent,
    // so the pair is the one application default this config was resolved from
    // — and an owner that cannot record it declines, leaving the deterministic
    // title below. A model used with no account of it is what this prevents.
    if (params.onSelected) {
      const recorded = await params.onSelected({
        provider: params.config.provider,
        model: params.config.model,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      })
      if (!recorded) return deriveTitleFromBrief(trimmedBrief)
    }
    const provider = getProvider(params.config.provider)
    const result = await provider.execute({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: trimmedBrief,
      model: params.config.model,
      thinking: params.config.thinking,
      providerConfig: {
        ...DEFAULT_PROVIDER_CONFIG,
        ...(params.config.providerConfig ?? {}),
      },
      signal,
    })
    const cleaned = postProcessTitle(result.text)
    if (!cleaned) return deriveTitleFromBrief(trimmedBrief)
    if (!isUsableJobTitle(cleaned, trimmedBrief)) {
      return deriveTitleFromBrief(trimmedBrief)
    }
    return cleaned
  } catch {
    return deriveTitleFromBrief(trimmedBrief)
  } finally {
    clearTimeout(timer)
  }
}
