/**
 * Provider domain — request admission.
 *
 * The one place a runtime-built provider request is measured before it is
 * paid for. A context overflow reported by the provider is a receipt, not a
 * control signal: by the time it arrives the process has started, the run has
 * been marked as progressing, and the caller has to unwind a stage that never
 * had a chance of succeeding. Admission moves that decision in front of the
 * dispatch, where the runtime still owns every part of the request and can say
 * exactly which part did not fit.
 *
 * Callers own the budget, because only the stage knows which model it will
 * reach and how much of that window its answer needs. This boundary owns the
 * counting and the refusal.
 */

import { estimateContextTokens } from '../../core/context-tokens.js'

export interface ProviderRequestBudget {
  /** The model's total context window, in tokens. */
  readonly contextWindowTokens: number
  /** Tokens held back for the answer, never offered to the input. */
  readonly outputReserveTokens: number
}

/** The parts of a request a caller will actually send, for accounting. */
export interface RenderedProviderRequest {
  readonly systemPrompt: string
  readonly userMessage: string
  readonly toolDescriptors?: readonly string[]
}

export interface ProviderRequestAccounting {
  readonly systemPromptTokens: number
  readonly userMessageTokens: number
  readonly toolDefinitionTokens: number
  readonly estimatedInputTokens: number
  readonly admissibleInputTokens: number
}

/**
 * The admission estimator, as this boundary's own name for it.
 *
 * The arithmetic and the ratio now live in `core/context-tokens.ts` — one
 * estimator for a system that had three, two of which disagreed with each
 * other. The value and the byte basis are unchanged, so this returns what it
 * always returned.
 *
 * No module imports it today: the three Deep Research files that import from
 * this one take `accountProviderRequest` and `refuseProviderRequest` instead.
 * It is kept because it is the named, documented way to ask this boundary what
 * a request will cost, and admission is about to acquire callers.
 */
export function estimateProviderRequestTokens(value: string): number {
  return estimateContextTokens(value)
}

/**
 * Account for every part of the request the provider will read: the system
 * instructions, the user message including any artifact text the runtime
 * materialized into it, and the tool definitions the turn pays context for.
 */
export function accountProviderRequest(input: {
  readonly budget: ProviderRequestBudget
  readonly systemPrompt: string
  readonly userMessage: string
  readonly toolDescriptors?: readonly string[]
}): ProviderRequestAccounting {
  const systemPromptTokens = estimateProviderRequestTokens(input.systemPrompt)
  const userMessageTokens = estimateProviderRequestTokens(input.userMessage)
  const toolDefinitionTokens = estimateProviderRequestTokens(
    (input.toolDescriptors ?? []).join('\n'),
  )
  return {
    systemPromptTokens,
    userMessageTokens,
    toolDefinitionTokens,
    estimatedInputTokens:
      systemPromptTokens + userMessageTokens + toolDefinitionTokens,
    admissibleInputTokens: Math.max(
      0,
      input.budget.contextWindowTokens - input.budget.outputReserveTokens,
    ),
  }
}

/**
 * A request the runtime refused to send, with the arithmetic that decided.
 *
 * Deliberately not a `ProviderError`: no provider was contacted, nothing was
 * charged, and nothing about the provider failed. The stage that built the
 * oversized input is the party that has to act, so the error names that stage,
 * both numbers, and the remediation already attempted.
 */
export class ProviderRequestBudgetError extends Error {
  constructor(
    readonly stage: string,
    readonly accounting: ProviderRequestAccounting,
    readonly budget: ProviderRequestBudget,
    readonly remediation: string,
  ) {
    super(
      `${stage} request was refused before launch: estimated ` +
      `${accounting.estimatedInputTokens} input tokens ` +
      `(${accounting.systemPromptTokens} instructions, ` +
      `${accounting.userMessageTokens} prompt and attached content, ` +
      `${accounting.toolDefinitionTokens} tool definitions) exceeds the ` +
      `${accounting.admissibleInputTokens} admissible tokens of a ` +
      `${budget.contextWindowTokens}-token context window reserving ` +
      `${budget.outputReserveTokens} tokens for the answer. ${remediation}`,
    )
    this.name = 'ProviderRequestBudgetError'
  }
}

export function admitProviderRequest(input: {
  readonly stage: string
  readonly budget: ProviderRequestBudget
  readonly systemPrompt: string
  readonly userMessage: string
  readonly toolDescriptors?: readonly string[]
  readonly remediation?: string
}): ProviderRequestAccounting {
  const accounting = accountProviderRequest(input)
  if (accounting.estimatedInputTokens <= accounting.admissibleInputTokens) {
    return accounting
  }
  refuseProviderRequest(input)
}

/**
 * Refuse a request that has already run out of compaction, with the same
 * arithmetic `admitProviderRequest` would have produced.
 *
 * Returns `never`, so a caller that has exhausted its compaction ladder ends
 * there instead of carrying an unreachable fallback for the type checker.
 */
export function refuseProviderRequest(input: {
  readonly stage: string
  readonly budget: ProviderRequestBudget
  readonly systemPrompt: string
  readonly userMessage: string
  readonly toolDescriptors?: readonly string[]
  readonly remediation?: string
}): never {
  throw new ProviderRequestBudgetError(
    input.stage,
    accountProviderRequest(input),
    input.budget,
    input.remediation ?? 'Reduce the attached content before dispatch.',
  )
}
