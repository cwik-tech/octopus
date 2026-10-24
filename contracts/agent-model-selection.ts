import type { ResourceArchitectComposerSelection } from './schemas/resource-architect-composer.js'

/**
 * Which provider/model an agent runs with.
 *
 * There are exactly two configuration sources. An agent either carries its own
 * complete provider/model pair, or it inherits the one application-wide default
 * from Settings → AI Providers. Team membership is not an input, and catalog
 * order is never a fallback: when the default is unset, unavailable, or unable
 * to serve the required capability, this returns a typed error rather than
 * quietly picking some other model.
 *
 * Pure by construction — no environment reads, filesystem access, catalog
 * fetches, or provider calls happen here, so the runtime, the authoring UI, and
 * the roster preview can all share one answer.
 */

/** Model id historically used to mean "no concrete choice". */
export const LEGACY_UNRESOLVED_MODEL_ID = 'default'

/** Provider id historically used as the built-in "nothing chosen" placeholder. */
export const LEGACY_BUILTIN_PROVIDER_ID = 'codex'

/**
 * Providers whose adapter can actually express "you choose the model".
 *
 * These are the CLI providers: their adapters leave the model flag off the
 * command line when the model reads `default`, so the CLI applies its own
 * current choice. Every other adapter puts whatever it is handed in the
 * request's `model` field, where the string `default` is not a model id and
 * the call fails at the provider.
 *
 * `codex` is deliberately absent even though its adapter does omit the flag:
 * `codex/default` is this repository's historical "nothing chosen" sentinel,
 * and it keeps that meaning.
 *
 * Kept here rather than derived from the adapters because this contract is
 * pure. `tests/unit/agent-model-selection.test.ts` pins the list, and
 * `tests/unit/provider-default-support.test.ts` checks it against the
 * adapters themselves.
 */
export const PROVIDER_CHOSEN_DEFAULT_PROVIDERS: readonly string[] = [
  'claude',
  'gemini',
  'kimi-cli',
  'pi',
  'qwen',
]

export interface ProviderModelPair {
  readonly provider: string
  readonly model: string
}

/** What an agent's own configuration declares. */
export type AgentModelChoice =
  | ({ readonly mode: 'explicit' } & ProviderModelPair)
  | { readonly mode: 'app-default' }

/**
 * The application-wide default, kept identifiable even when it cannot run.
 * `unavailable` still names the configured pair so the user can be told which
 * selection is broken rather than being silently moved to another one.
 */
export type AppDefaultModelState =
  | { readonly status: 'unset' }
  | ({
      readonly status: 'available'
      readonly capabilities?: readonly string[]
    } & ProviderModelPair)
  | ({
      readonly status: 'unavailable'
      readonly detail?: string
    } & ProviderModelPair)

/**
 * Where a selection came from. A workflow launched from chat carries that
 * turn's user selection to its workers; it overrides their saved configuration
 * for this task without rewriting the agents.
 */
export type ModelSelectionSource = 'agent' | 'app-default' | 'user'

export type ModelSelectionReason =
  | 'explicit-user-choice'
  | 'explicit-agent-choice'
  | 'agent-default'
  | 'user-approved-retry'

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly source: ModelSelectionSource
  readonly reason: ModelSelectionReason
  /** The pair that was displaced, present only for an approved retry. */
  readonly originalChoice?: ProviderModelPair
}

export type ModelSelectionErrorCode =
  | 'agent-model-without-provider'
  | 'agent-provider-without-model'
  | 'app-default-unset'
  | 'app-default-unavailable'
  | 'incompatible-capability'
  | 'stale-approval'

export interface ModelSelectionError {
  readonly code: ModelSelectionErrorCode
  /** Safe display text. Never raw provider response bodies. */
  readonly message: string
  readonly provider?: string
  readonly model?: string
}

export type ModelSelectionResult =
  | { readonly ok: true; readonly selection: ModelSelection }
  | { readonly ok: false; readonly error: ModelSelectionError }

export type AgentModelDiagnosticCode =
  | 'legacy-default-sentinel'
  | 'legacy-builtin-default-pair'
  | 'provider-chosen-default'
  /** `provider_options` this build cannot read as plain provider settings. */
  | 'invalid-provider-options'
  /** `provider_options` naming something that looks like a credential. */
  | 'provider-options-credential'

/**
 * The diagnostic that makes an Agent unusable, if there is one.
 *
 * Options the loader refused are an execution-boundary problem, not a note. It
 * drops them and says why, but an Agent that runs with its settings silently
 * missing leaves a person unable to tell that from a setting the provider does
 * not honour — and a credential in an Agent file is worse than ignored, it is
 * in the wrong place and nobody was told. Every entry that dispatches an Agent
 * asks this same question, so it is asked in one place.
 *
 * Other diagnostics are notes about how a pair was read and do not stop a run.
 */
export function unusableProviderOptions(
  diagnostics: readonly AgentModelDiagnostic[] | undefined,
): AgentModelDiagnostic | undefined {
  return diagnostics?.find(
    (diagnostic) =>
      diagnostic.code === 'invalid-provider-options' ||
      diagnostic.code === 'provider-options-credential',
  )
}

export interface AgentModelDiagnostic {
  readonly code: AgentModelDiagnosticCode
  readonly message: string
}

export interface AgentModelChoiceReading {
  readonly choice?: AgentModelChoice
  readonly error?: ModelSelectionError
  readonly diagnostics: readonly AgentModelDiagnostic[]
}

/**
 * The concrete pair an agent will run with, or a typed reason it cannot run.
 *
 * `requiredCapability` is checked only against a default whose capabilities are
 * known. An explicit agent choice is never second-guessed here: catalog
 * staleness is not proof that a deliberately chosen model cannot execute, so
 * readiness for an explicit pair is the provider's answer to give, not this
 * function's.
 */
export function resolveAgentModelChoice(
  agentChoice: AgentModelChoice,
  appDefault: AppDefaultModelState,
  options?: { readonly requiredCapability?: string },
): ModelSelectionResult {
  if (agentChoice.mode === 'explicit') {
    return {
      ok: true,
      selection: {
        provider: agentChoice.provider,
        model: agentChoice.model,
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    }
  }
  return selectAppDefault(appDefault, 'agent-default', options)
}

/**
 * The same app default, selected because the user approved one new attempt
 * after an explicit choice failed. The displaced pair is carried so history can
 * say what was originally requested.
 */
export function resolveApprovedDefaultRetry(
  originalChoice: ProviderModelPair,
  appDefault: AppDefaultModelState,
  options?: { readonly requiredCapability?: string },
): ModelSelectionResult {
  const result = selectAppDefault(appDefault, 'user-approved-retry', options)
  if (!result.ok) return result
  return {
    ok: true,
    selection: { ...result.selection, originalChoice },
  }
}

function selectAppDefault(
  appDefault: AppDefaultModelState,
  reason: ModelSelectionReason,
  options?: { readonly requiredCapability?: string },
): ModelSelectionResult {
  if (appDefault.status === 'unset') {
    return {
      ok: false,
      error: {
        code: 'app-default-unset',
        message:
          'No application default model is selected. Choose one in Settings → AI Providers.',
      },
    }
  }
  if (appDefault.status === 'unavailable') {
    return {
      ok: false,
      error: {
        code: 'app-default-unavailable',
        message: appDefault.detail
          ? `The application default model is unavailable: ${appDefault.detail}.`
          : 'The application default model is unavailable.',
        provider: appDefault.provider,
        model: appDefault.model,
      },
    }
  }
  const required = options?.requiredCapability
  if (
    required !== undefined &&
    appDefault.capabilities !== undefined &&
    !appDefault.capabilities.includes(required)
  ) {
    return {
      ok: false,
      error: {
        code: 'incompatible-capability',
        message: `The application default model does not support ${required}.`,
        provider: appDefault.provider,
        model: appDefault.model,
      },
    }
  }
  return {
    ok: true,
    selection: {
      provider: appDefault.provider,
      model: appDefault.model,
      source: 'app-default',
      reason,
    },
  }
}

/**
 * Interprets whatever an agent file, roster entry, or request actually holds.
 *
 * Legacy shapes that unambiguously meant "nothing chosen" become app-default
 * mode with a diagnostic. Genuinely ambiguous shapes — a model with no
 * provider, or a provider whose model was left for the provider to pick —
 * are reported as invalid instead of being completed by guesswork.
 */
export function readAgentModelChoice(raw: {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}): AgentModelChoiceReading {
  const provider = trimmed(raw.provider)
  const model = trimmed(raw.model)
  const modelIsSentinel = model === LEGACY_UNRESOLVED_MODEL_ID
  const concreteModel = model !== undefined && !modelIsSentinel

  if (provider !== undefined && concreteModel) {
    return {
      choice: { mode: 'explicit', provider, model },
      diagnostics: [],
    }
  }
  if (provider === undefined && concreteModel) {
    return {
      error: {
        code: 'agent-model-without-provider',
        message: `Model '${model}' names no provider. Choose a provider and model together, or use the app default.`,
        model,
      },
      diagnostics: [],
    }
  }
  if (provider === undefined) {
    return {
      choice: { mode: 'app-default' },
      diagnostics: modelIsSentinel
        ? [
            {
              code: 'legacy-default-sentinel',
              message:
                "Legacy 'model: default' is read as app-default mode. Remove the field or choose a provider and model.",
            },
          ]
        : [],
    }
  }
  if (provider === LEGACY_BUILTIN_PROVIDER_ID && modelIsSentinel) {
    return {
      choice: { mode: 'app-default' },
      diagnostics: [
        {
          code: 'legacy-builtin-default-pair',
          message:
            "Legacy 'codex/default' is read as app-default mode. Remove the fields or choose a provider and model.",
        },
      ],
    }
  }
  if (modelIsSentinel && PROVIDER_CHOSEN_DEFAULT_PROVIDERS.includes(provider)) {
    // Naming `default` beside a CLI provider selects that provider's own
    // provider-chosen entry, which its adapter implements by omitting the
    // model flag. It stays an explicit choice — the app default is never sent
    // to a provider the user did not pick — but it is not pinned to a specific
    // model, so it is labelled as such rather than silently shown as a version.
    return {
      choice: { mode: 'explicit', provider, model: LEGACY_UNRESOLVED_MODEL_ID },
      diagnostics: [
        {
          code: 'provider-chosen-default',
          message: `'${provider}' will choose its own model. This selection is not pinned to a specific model version.`,
        },
      ],
    }
  }
  if (modelIsSentinel) {
    // The provider has no way to be asked for its own choice: its adapter
    // would send the literal string `default` as a model id. Completing this
    // by guesswork would either invent a model or quietly move the agent onto
    // the application default under a provider the user did pick.
    return {
      error: {
        code: 'agent-provider-without-model',
        message: `'${provider}' cannot choose its own model. Choose a specific model for '${provider}', or use the app default.`,
        provider,
      },
      diagnostics: [],
    }
  }
  return {
    error: {
      code: 'agent-provider-without-model',
      message: `Provider '${provider}' names no model. Choose a specific model or alias, or use the app default.`,
      provider,
    },
    diagnostics: [],
  }
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result ? result : undefined
}

// ─── Durable provenance ─────────────────────────────────────────────────────

/**
 * Who made the call a selection belongs to.
 *
 * Deliberately separate from where the pair came from, so a generic
 * assistant's ad hoc user choice is never attributed to an agent persona and an
 * authoring helper is never mistaken for a worker.
 *
 * `title` is this server's own naming of a session or an artifact. It owns no
 * Agent, so it runs on the application default — and reusing one of the other
 * callers for it would report that default as an Agent's or an author's own
 * decision.
 */
export type ModelSelectionCaller =
  | 'agent'
  | 'generic-chat'
  | 'authoring'
  | 'title'
  | 'compression'
  | 'minutes'

/**
 * Callers that are the application's own background work rather than a turn
 * somebody took.
 *
 * Named as a set rather than checked one value at a time, because the readers
 * that build a run's roster key everything by the identity an event carries —
 * and a helper's event carries the runtime's own id, which a participant can
 * share. Every one of these has to be kept out of that, and adding the next
 * helper must not depend on remembering to extend two separate conditions.
 */
export function isHelperModelSelection(caller: ModelSelectionCaller): boolean {
  return caller === 'title' || caller === 'compression' || caller === 'minutes'
}

/**
 * Provenance sources for named workers and ad hoc calls. A task-scoped chat
 * selection is a user choice; there is deliberately no team configuration source.
 */
export type ModelSelectionRecordSource = ModelSelectionSource | 'user'

export type ModelSelectionRecordReason =
  | ModelSelectionReason
  | 'explicit-user-choice'
  | 'composer-default'

/**
 * What gets persisted. Structured data only: display wording is derived from
 * this and never stored, so it can never become stale or enter model context.
 */
export interface ModelSelectionRecord {
  readonly provider: string
  readonly model: string
  readonly source: ModelSelectionRecordSource
  readonly reason: ModelSelectionRecordReason
  readonly caller: ModelSelectionCaller
  /** The pair originally requested, when an approved retry displaced it. */
  readonly requestedProvider?: string
  readonly requestedModel?: string
}

export function toModelSelectionRecord(
  selection: ModelSelection,
  caller: ModelSelectionCaller,
): ModelSelectionRecord {
  return {
    provider: selection.provider,
    model: selection.model,
    source: selection.source,
    reason: selection.reason,
    caller,
    ...(selection.originalChoice
      ? {
          requestedProvider: selection.originalChoice.provider,
          requestedModel: selection.originalChoice.model,
        }
      : {}),
  }
}

/** An explicit pair a user chose for one ad hoc call, owned by no agent. */
export function userChoiceSelectionRecord(
  pair: ProviderModelPair,
  caller: ModelSelectionCaller = 'generic-chat',
): ModelSelectionRecord {
  return {
    provider: pair.provider,
    model: pair.model,
    source: 'user',
    reason: 'explicit-user-choice',
    caller,
  }
}

/** A Create selection retains how the displayed pair was obtained. */
export function composerSelectionRecord(
  snapshot: ResourceArchitectComposerSelection,
): ModelSelectionRecord {
  if (snapshot.origin === 'user-choice') {
    return userChoiceSelectionRecord(snapshot, 'authoring')
  }
  return {
    provider: snapshot.provider,
    model: snapshot.model,
    source: 'app-default',
    reason: 'composer-default',
    caller: 'authoring',
  }
}

/**
 * Reads an untrusted persisted selection record.
 *
 * History comes back from disk and over HTTP, so a record is validated rather
 * than asserted. A partially readable record is refused outright: a notice
 * built from half a record would state something no execution recorded.
 */
export function readModelSelectionRecord(
  value: unknown,
): ModelSelectionRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const provider = recordString(record.provider)
  const model = recordString(record.model)
  if (!provider || !model) return undefined
  const source = record.source
  if (source !== 'agent' && source !== 'app-default' && source !== 'user') {
    return undefined
  }
  const reason = record.reason
  if (
    reason !== 'explicit-agent-choice' &&
    reason !== 'agent-default' &&
    reason !== 'user-approved-retry' &&
    reason !== 'explicit-user-choice' &&
    reason !== 'composer-default'
  ) {
    return undefined
  }
  const caller = record.caller
  if (
    caller !== 'agent' &&
    caller !== 'generic-chat' &&
    caller !== 'authoring' &&
    caller !== 'title' &&
    caller !== 'compression' &&
    caller !== 'minutes'
  ) {
    return undefined
  }
  const requestedProvider = recordString(record.requestedProvider)
  const requestedModel = recordString(record.requestedModel)
  // A field that is present but unreadable is not a field that was never
  // written. Normalising it to undefined would turn a corrupt record into a
  // clean-looking one, and the notice would then say an approved retry
  // displaced nothing at all. Only an absent key -- or the undefined that a
  // key never survives JSON as -- means nothing was displaced.
  if (record.requestedProvider !== undefined && requestedProvider === undefined) {
    return undefined
  }
  if (record.requestedModel !== undefined && requestedModel === undefined) {
    return undefined
  }
  // Half a displaced pair cannot say what was originally requested.
  if ((requestedProvider === undefined) !== (requestedModel === undefined)) {
    return undefined
  }
  return {
    provider,
    model,
    source,
    reason,
    caller,
    ...(requestedProvider && requestedModel
      ? { requestedProvider, requestedModel }
      : {}),
  }
}

function recordString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * The sentence a person reads.
 *
 * Derived from the stored record every time it is shown, never persisted and
 * never placed in model context, so it cannot go stale and cannot leak into a
 * prompt. An explicit choice is described as a choice, not as a default, even
 * when the pair happens to match the default.
 */
export function describeModelSelection(
  speakerName: string,
  selection: ModelSelectionRecord,
): string {
  const pair = `${selection.provider} / ${selection.model}`
  if (selection.reason === 'composer-default') {
    return `${speakerName} used the Create composer default captured at submission: ${pair}.`
  }
  if (selection.source !== 'app-default') return `${speakerName} used ${pair}.`
  const displaced =
    selection.requestedProvider && selection.requestedModel
      ? `${selection.requestedProvider} / ${selection.requestedModel}`
      : 'the selected model'
  const reason =
    selection.reason === 'user-approved-retry'
      ? `you approved a new attempt on the app default after ${displaced} failed`
      : 'no Agent model selected'
  return `${speakerName} is using the app default: ${pair}. Reason: ${reason}.`
}

/** What to show for an execution recorded before provenance existed. */
export const UNRECORDED_MODEL_SELECTION = 'Model selection not recorded'
