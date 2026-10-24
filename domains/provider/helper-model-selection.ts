/**
 * The model the application's own background helpers run on, and its account.
 *
 * Compressing a long discussion and writing a run's minutes are the
 * application's own work. Neither owns an Agent, so by the same rule every
 * other caller keeps, each runs on the one application default — never on a
 * provider substituted further down, and never on a model id that is not a
 * model.
 *
 * Two helpers share this because they share the decision, not merely the shape:
 * resolve the whole pair or do nothing, and say which pair before using it. A
 * third helper added later gets the same answer by calling this rather than by
 * reimplementing it.
 */

import type { ModelSelectionCaller, ModelSelectionRecord } from '../../contracts/agent-model-selection.js'
import { logRuntimeEvent } from '../runtime/logger.js'
import { whenDefined } from '../../core/optional-properties.js'
import { runtimeAppDefaultPair } from './default-model-selection.js'

/** The one event that says which model a background helper ran on. */
export const HELPER_MODEL_SELECTED_EVENT = 'runtime.helper_model_selected'

/**
 * The one report that says a helper answered without a model, and which one.
 *
 * Falling back is the right answer when the summarizing model cannot be used,
 * but a helper that quietly produces its mechanical output leaves nobody able
 * to find out what was unavailable. That is how the desktop application came to
 * ship for a whole release cycle without the minutes prompt template, taking
 * that path on every run, unnoticed.
 *
 * Reported on the process boundary rather than into the run's journal: the run
 * is not failing, it is getting its answer, and a record in its history would
 * read as a failure. Shared by both helpers because they already share the
 * disclosure rule — reporting one and not the other is the same gap in a
 * smaller place.
 */
export const HELPER_FALLBACK_EVENT = 'runtime.helper_summary_unavailable'

/** Where a helper's account belongs, when the caller has a run to put it in. */
export interface HelperRunIdentity {
  /** The assignment whose journal owns the record. */
  readonly outputPath: string
  readonly sessionId: string
  readonly rootSessionId?: string
  readonly levelId?: string
}

/**
 * The application default as this helper's own selection, or `null`.
 *
 * `null` means there is nothing usable to run on — unset, or configured and
 * unavailable. Callers fall back to their existing mechanical behaviour rather
 * than reaching for some other model, which is the whole point: a default that
 * cannot run is not a licence to pick a replacement nobody chose.
 */
export function resolveHelperModelSelection(
  caller: ModelSelectionCaller,
): ModelSelectionRecord | null {
  const appDefault = runtimeAppDefaultPair()
  if (!appDefault) return null
  return {
    provider: appDefault.provider,
    model: appDefault.model,
    source: 'app-default',
    reason: 'agent-default',
    caller,
  }
}

/**
 * Writes the account, before the model is used.
 *
 * Returns whether it is durable. A caller that cannot record what it is about
 * to use does not use it: a model used with no account of it is the thing this
 * prevents, and the mechanical fallback is a perfectly good answer.
 *
 * A run to write into is required rather than optional. Treating its absence as
 * permission to proceed would be an exception that says "disclose this unless
 * it is inconvenient", which is the rule inverted — a caller with nowhere to
 * record what it is about to use has no business using it.
 */
/**
 * Says a helper fell back, with a fixed category and identity only.
 *
 * The underlying error is deliberately not carried. It can be a provider's own
 * message or a filesystem path, and neither belongs in anything this repository
 * writes down; the category plus the run's identity says everything a reader
 * needs to find the run and ask it.
 */
export function reportHelperFallback(
  helper: ModelSelectionCaller,
  context: { readonly sessionId?: string; readonly rootSessionId?: string; readonly team?: string },
): void {
  console.error(JSON.stringify({
    event: HELPER_FALLBACK_EVENT,
    error: 'summary_unavailable',
    helper,
    ...whenDefined(context.team, (team) => ({ team })),
    ...whenDefined(context.sessionId, (session_id) => ({ session_id })),
    ...whenDefined(context.rootSessionId, (root_session_id) => ({ root_session_id })),
  }))
}

export function recordHelperModelSelection(
  identity: HelperRunIdentity,
  helper: ModelSelectionCaller,
  selection: ModelSelectionRecord,
): boolean {
  try {
    logRuntimeEvent(identity.outputPath, {
      timestamp: new Date().toISOString(),
      event: HELPER_MODEL_SELECTED_EVENT,
      helper,
      session_id: identity.sessionId,
      ...whenDefined(identity.rootSessionId, (root_session_id) => ({ root_session_id })),
      ...whenDefined(identity.levelId, (level_id) => ({ level_id })),
      model_selection: selection,
    })
    return true
  } catch {
    return false
  }
}
