/**
 * Resource Architect — what one provider request may carry.
 *
 * Every Agent Architect phase is measured before it is dispatched. The selected
 * Agent's package is supplied whole or not at all: a phase that cannot fit it
 * is refused, never sent with a shortened package.
 */
import { resolveOutputReserve } from '../../core/context-fit.js'
import { estimateContextTokens } from '../../core/context-tokens.js'
import { contextWindowMayRefuse, resolveContextWindow } from '../provider/context-window.js'
import type { ModelMessage } from '../provider/model-client.js'
import {
  accountProviderRequest,
  admitProviderRequest,
  ProviderRequestBudgetError,
  type ProviderRequestAccounting,
  type ProviderRequestBudget,
} from '../provider/provider-request-budget.js'

/** What kind of connection a `connection:<id>` provider routes to, if known. */
export type ResolveConnectionKind = (provider: string) => string | undefined

export interface ResourceArchitectRequestBudget {
  readonly provider: string
  readonly model: string
  readonly budget: ProviderRequestBudget
  /** False for an assumed window, which may never end a turn before dispatch. */
  readonly mayRefuse: boolean
  /**
   * The input tokens one whole request may carry: the window minus the answer
   * reserve. A selected package larger than this can never be sent whole.
   */
  readonly draftAdmissibleInputTokens: number
}

export function resolveResourceArchitectRequestBudget(
  pair: { readonly provider: string; readonly model: string },
  resolveConnectionKind?: ResolveConnectionKind,
): ResourceArchitectRequestBudget {
  const connectionKind = resolveConnectionKind?.(pair.provider)
  const window = resolveContextWindow({
    provider: pair.provider,
    model: pair.model,
    ...(connectionKind === undefined ? {} : { connectionKind }),
  })
  const outputReserveTokens = resolveOutputReserve(window.tokens, window.maxOutputTokens)
  return {
    provider: pair.provider,
    model: pair.model,
    budget: { contextWindowTokens: window.tokens, outputReserveTokens },
    mayRefuse: contextWindowMayRefuse(window.source),
    // The same ceiling admitProviderRequest applies to the whole draft.
    draftAdmissibleInputTokens: Math.max(0, window.tokens - outputReserveTokens),
  }
}

/**
 * Measure one phase's request and refuse it when it cannot fit.
 *
 * An assumed window is measured but never refuses, which is the one rule
 * `contextWindowMayRefuse` states for the whole system.
 */
export function admitResourceArchitectRequest(input: {
  readonly stage: string
  readonly budget: ResourceArchitectRequestBudget
  readonly systemPrompt: string
  readonly messages: readonly ModelMessage[]
  readonly outputSchema?: unknown
}): ProviderRequestAccounting {
  const request = {
    stage: input.stage,
    budget: input.budget.budget,
    systemPrompt: input.systemPrompt,
    userMessage: input.messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
    toolDescriptors: input.outputSchema === undefined ? [] : [JSON.stringify(input.outputSchema)],
    remediation:
      'Nothing was sent, and no context was shortened. Choose a model with a larger context window, or reduce the selected Agent package, attached files, or conversation.',
  }
  return input.budget.mayRefuse ? admitProviderRequest(request) : accountProviderRequest(request)
}

/** The selected Agent's package cannot be supplied whole on this model. */
export class SelectedAgentPackageBudgetError extends Error {
  constructor(
    readonly agentName: string,
    readonly packageTokens: number,
    readonly packageBytes: number,
    readonly budget: ResourceArchitectRequestBudget,
  ) {
    super(
      `The saved package for Agent ${agentName} is about ${packageTokens} tokens ` +
        `(${packageBytes} bytes), more than the ${budget.draftAdmissibleInputTokens} input tokens ` +
        `the ${budget.provider}/${budget.model} context window admits for a whole request. ` +
        'Nothing was sent, and the package was not shortened. Choose a model with a larger ' +
        'context window, select a different Agent, or make the package smaller, then ask again.',
    )
    this.name = 'SelectedAgentPackageBudgetError'
  }
}

/**
 * The selected package's measured size, or a refusal when it alone exceeds
 * what a whole request may carry. A package that fits here can still be
 * refused by the draft admission once the rest of the request is added; there
 * is no separate, smaller share for it.
 */
export function admitSelectedAgentPackage(input: {
  readonly agentName: string
  readonly text: string
  readonly budget: ResourceArchitectRequestBudget
}): { readonly tokens: number; readonly bytes: number } {
  const tokens = estimateContextTokens(input.text)
  const bytes = Buffer.byteLength(input.text, 'utf8')
  if (input.budget.mayRefuse && tokens > input.budget.draftAdmissibleInputTokens) {
    throw new SelectedAgentPackageBudgetError(input.agentName, tokens, bytes, input.budget)
  }
  return { tokens, bytes }
}

/** A refusal decided before dispatch, with a message a person can act on. */
export function isResourceArchitectBudgetRefusal(
  error: unknown,
): error is ProviderRequestBudgetError | SelectedAgentPackageBudgetError {
  return error instanceof ProviderRequestBudgetError || error instanceof SelectedAgentPackageBudgetError
}
