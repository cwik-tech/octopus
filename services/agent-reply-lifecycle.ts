import { providerAbortReason, providerAbortSource } from '../contracts/provider-abort.js';
import { whenDefined } from '../core/optional-properties.js';
import { logProcessWarning } from '../domains/runtime/logger.js';
import type { AgentTurnFailureIdentity } from '../domains/agent-execution/agent-turn-journal.js';
import type { AgentTurnPreparedInput, AgentTurnJournalRecorder } from './agent-turn-journal-recorder.js';
import type { AgentReplyJournal, AgentReplyResult } from './agent-reply-service.js';

export type AgentReplyPublication<T> =
  | { readonly kind: 'publish'; readonly assistantMessageId: string; readonly text: string; readonly persist: () => Promise<void>; readonly value: T }
  | { readonly kind: 'passed'; readonly value: T }
  | { readonly kind: 'failed'; readonly failure: AgentTurnFailureIdentity; readonly value: T };

export interface AgentReplyLifecycleInput<T> {
  readonly turnId: string;
  readonly replyId: string;
  readonly speakerOrdinal: number;
  readonly agentPath: string;
  readonly requestedProvider?: string;
  readonly requestedModel?: string;
  readonly recorder?: AgentTurnJournalRecorder;
  readonly signal?: AbortSignal;
  readonly providerDeadlineMs?: number;
  readonly providerCleanupBudgetMs?: number;
  readonly generate: (signal: AbortSignal) => Promise<AgentReplyResult>;
  readonly prepare: (result: AgentReplyResult, signal: AbortSignal) => Promise<AgentReplyPublication<T>>;
  /** Publish a durable result before giving its borrowed journal back. */
  readonly afterPublication?: (value: T) => void;
}

export async function runAgentReplyLifecycle<T>(input: AgentReplyLifecycleInput<T>): Promise<T> {
  const signal = input.signal ?? new AbortController().signal;
  const { recorder, turnId, replyId } = input;
  let turnFailure: { readonly cause: unknown } | undefined;
  try {
    await recorder?.recordStarted({
      turnId, replyId, speakerOrdinal: input.speakerOrdinal, agentPath: input.agentPath,
      ...whenDefined(input.requestedProvider, (requestedProvider) => ({ requestedProvider })),
      ...whenDefined(input.requestedModel, (requestedModel) => ({ requestedModel })),
    });
    const result = await withAgentReplyDeadline({
      turnId, replyId,
      deadlineMs: input.providerDeadlineMs ?? AGENT_REPLY_PROVIDER_DEADLINE_MS,
      cleanupBudgetMs: input.providerCleanupBudgetMs ?? AGENT_REPLY_PROVIDER_CLEANUP_BUDGET_MS,
      signal,
      run: input.generate,
    }).catch(async (error: unknown) => {
      await withoutMaskingAgentReplyCause(error, () => recordAgentReplyAbandonment({
        recorder, turnId, replyId, aborted: signal.aborted,
        interrupted: error instanceof AgentChatProviderInterruptedError,
      }));
      throw error;
    });

    // Playback may wait here after generation. Its cancellation belongs to the
    // caller's signal; the provider's generation deadline has already ended.
    let publication: AgentReplyPublication<T>;
    try {
      requireActivePublication(signal, turnId, replyId);
      publication = await input.prepare(result, signal);
      requireActivePublication(signal, turnId, replyId);
    } catch (error) {
      await recordPublicationFailure(error, { recorder, turnId, replyId, signal,
        route: result.journal.route, phase: 'artifact-publication' });
      throw error;
    }

    if (publication.kind === 'passed') {
      if (result.journal.outcome !== 'success') {
        throw new Error('A failed Agent reply cannot be recorded as a pass.');
      }
      await recorder?.recordPassed({
        turnId, replyId, route: result.journal.route,
        ...whenDefined(result.journal.resolvedModel, (resolvedModel) => ({ resolvedModel })),
        ...whenDefined(result.journal.declaredToolCount, (declaredToolCount) => ({ declaredToolCount })),
        ...whenDefined(result.journal.executedToolCount, (executedToolCount) => ({ executedToolCount })),
        ...whenDefined(result.journal.usage, (usage) => ({ usage })),
      });
    } else if (publication.kind === 'failed') {
      await recorder?.recordFailed({ turnId, replyId, route: result.journal.route, failure: publication.failure });
    } else {
      await recorder?.recordPrepared(buildAgentReplyPreparedInput({
        turnId, replyId, assistantMessageId: publication.assistantMessageId,
        outputByteLength: Buffer.byteLength(publication.text, 'utf8'), journal: result.journal,
      }));
      try {
        requireActivePublication(signal, turnId, replyId);
        await publication.persist();
      } catch (error) {
        await recordPublicationFailure(error, { recorder, turnId, replyId, signal,
          route: result.journal.route, phase: 'assistant-persistence' });
        throw error;
      }
      await recordAgentReplyPublished({ recorder, turnId, replyId,
        assistantMessageId: publication.assistantMessageId, journal: result.journal });
    }
    input.afterPublication?.(publication.value);
    return publication.value;
  } catch (error) {
    turnFailure = { cause: error };
    throw error;
  } finally {
    if (turnFailure) {
      await withoutMaskingAgentReplyCause(turnFailure.cause, () => recorder?.release(), 'journal lease not released');
    } else {
      await recorder?.release();
    }
  }
}

function requireActivePublication(signal: AbortSignal, turnId: string, replyId: string): void {
  if (signal.aborted) throw new AgentChatTurnCancelledError(turnId, replyId);
}

async function recordPublicationFailure(cause: unknown, input: {
  recorder: AgentTurnJournalRecorder | undefined;
  turnId: string;
  replyId: string;
  signal: AbortSignal;
  route: AgentReplyJournal['route'];
  phase: 'artifact-publication' | 'assistant-persistence';
}): Promise<void> {
  await withoutMaskingAgentReplyCause(cause, () => input.signal.aborted
    ? input.recorder?.recordCancelled({ turnId: input.turnId, replyId: input.replyId,
        route: input.route, phase: 'assistant-persistence' })
    : input.recorder?.recordFailed({ turnId: input.turnId, replyId: input.replyId,
        route: input.route,
        failure: { layer: input.phase === 'artifact-publication' ? 'chat-delivery' : 'chat-persistence',
          phase: input.phase,
          serviceCode: input.phase === 'artifact-publication' ? 'delivery_not_published' : 'assistant_message_not_stored',
          retryable: false } }));
}

// Ordinary chat/dialogue replies only; research Workflow workers have their own budgets.
export const AGENT_REPLY_PROVIDER_DEADLINE_MS = 1_800_000;
// Teardown cannot turn an interrupted reply into an indefinite wait.
export const AGENT_REPLY_PROVIDER_CLEANUP_BUDGET_MS = 5_000;

/**
 * The durable identity of a turn that was ended for taking too long.
 *
 * Kept apart from the provider's own error taxonomy because the two answer
 * different questions: a provider failure is something the provider said, and
 * this is something nobody said. Nothing about the provider's outcome is known
 * when this is raised, which is exactly why the turn may not be retried on the
 * user's behalf.
 */
export class AgentChatProviderInterruptedError extends Error {
  readonly turnId: string;
  readonly replyId: string;

  constructor(turnId: string, replyId: string) {
    super("The agent did not respond before this turn's deadline.");
    this.name = "AgentChatProviderInterruptedError";
    this.turnId = turnId;
    this.replyId = replyId;
  }
}

/** The safe code an interruption is recorded and reported under. */
export const AGENT_CHAT_PROVIDER_INTERRUPTED_CODE = "provider_interrupted";

/**
 * A turn the caller withdrew, raised once the turn stops waiting for the
 * provider to notice.
 *
 * Separate from the interruption above because the two mean opposite things to
 * the user: one is their own decision and the other is a fault they may retry.
 * Cancellation is still classified from the caller's signal rather than from
 * this type, so a provider that raises its own cancellation first is recorded
 * the same way; only the interruption is classified from its cause, because
 * that is the one ending a later signal could otherwise overwrite.
 */
export class AgentChatTurnCancelledError extends Error {
  readonly turnId: string;
  readonly replyId: string;

  constructor(turnId: string, replyId: string) {
    super("This turn was cancelled.");
    this.name = "AgentChatTurnCancelledError";
    this.turnId = turnId;
    this.replyId = replyId;
  }
}

/**
 * Run one provider operation under a wall-clock ceiling.
 *
 * The signal handed to the operation is this turn's own, derived from the
 * caller's: a client that goes away still cancels, and the deadline can also
 * withdraw the call without the caller having done anything.
 *
 * Once the deadline fires the turn is interrupted, whatever arrives afterwards.
 * A late result is not published — the reply's stream terminal and both journal
 * terminals have to be decided from one moment, and a result racing them would
 * mean the user is told two different things about the same turn. Teardown gets
 * its own small budget so a bridge that will not close cannot turn a recorded
 * interruption back into the indefinite wait this exists to end.
 */
export async function withAgentReplyDeadline<T>(input: {
  turnId: string;
  replyId: string;
  deadlineMs: number;
  cleanupBudgetMs?: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const cleanupBudgetMs =
    input.cleanupBudgetMs ?? AGENT_REPLY_PROVIDER_CLEANUP_BUDGET_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  // Both endings are raced, not just the deadline. Forwarding the caller's
  // abort into the operation asks it to stop; it does not make it stop, and an
  // adapter that ignores the signal used to leave a withdrawn turn waiting on
  // the provider's own ceiling. The user has already gone.
  const ended = new Promise<"deadline" | "cancelled">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), input.deadlineMs);
    if (input.signal?.aborted) {
      resolve("cancelled");
      return;
    }
    // Named rather than inline, so the `finally` below can take it off again.
    // An anonymous listener on a signal that outlives this call — a request
    // abort controller is shared by every reply in the turn — accumulates one
    // entry per reply for the life of the request.
    onCallerAbort = () => {
      controller.abort(providerAbortReason(providerAbortSource(input.signal?.reason)));
      resolve("cancelled");
    };
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  });
  // Short-circuited before the operation is entered. Forwarding an abort into
  // a call that has already started is the best that can be done once it is
  // running; not starting it is strictly better, and the difference is a
  // provider request — and every side effect that request would cause — spent
  // on an answer nobody is waiting for.
  if (input.signal?.aborted) {
    controller.abort(providerAbortReason(providerAbortSource(input.signal?.reason)));
    if (timer) clearTimeout(timer);
    throw new AgentChatTurnCancelledError(input.turnId, input.replyId);
  }

  try {
    const work = input.run(controller.signal);
    // Tagged rather than raced bare: `Promise.race` on a value and a sentinel
    // cannot say which settled when the value could itself be the sentinel.
    const settled = await Promise.race([
      work.then((value) => ({ kind: "work" as const, value })),
      ended.then((reason) => ({ kind: reason })),
    ]);
    if (settled.kind === "work") return settled.value;

    controller.abort(providerAbortReason(settled.kind === 'deadline' ? 'provider-deadline' : providerAbortSource(input.signal?.reason)));
    // The operation is given the cleanup budget to finish on its own terms
    // before this decides for it. A withdrawn turn whose provider raises its
    // own cancellation seconds later has a better reason on hand than anything
    // invented here, and that reason is what the caller has always been given.
    const unwound = await raceCleanupBudget(work, cleanupBudgetMs);
    // Only a failure is carried out of the cleanup window, and only for a
    // cancellation. An answer that arrives after the user has withdrawn is not
    // an answer they asked for: publishing it would put a reply on the
    // transcript for a turn they cancelled, and close a bubble they had
    // already stopped watching. A *reason*, by contrast, is worth keeping —
    // the provider's own account of the withdrawal is better than anything
    // invented here, and classification still comes from the caller's signal
    // rather than from the error, so a provider raising something
    // unrecognisable cannot turn a withdrawal into a fault.
    if (
      settled.kind === "cancelled" &&
      unwound.kind === "settled" &&
      unwound.failure
    ) {
      throw unwound.failure.cause;
    }
    throw settled.kind === "cancelled"
      ? new AgentChatTurnCancelledError(input.turnId, input.replyId)
      : // A deadline is this turn's own decision, and after it nothing is known
        // about the provider — including whatever it raises on the way out,
        // which is a consequence of the abort rather than the reason for it.
        new AgentChatProviderInterruptedError(input.turnId, input.replyId);
  } finally {
    if (timer) clearTimeout(timer);
    if (onCallerAbort) input.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Wait for an operation to unwind, but not for longer than it is worth.
 *
 * Reports whether it actually settled, because "it finished with this error"
 * and "it never finished" are different facts and only the first carries a
 * reason worth passing on.
 *
 * The rejection is captured rather than propagated: once the budget is running
 * this promise is no longer awaited for its answer, and an unobserved rejection
 * would surface as an unhandled one. The timer is cleared on the early path as
 * well as the late one — left pending it keeps an event-loop handle alive for
 * the whole budget after the turn has already finished.
 */
async function raceCleanupBudget<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<
  | { kind: "settled"; value: T; failure?: undefined }
  | { kind: "settled"; value?: undefined; failure: { cause: unknown } }
  | { kind: "budget-exhausted" }
> {
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        (value) => ({ kind: "settled" as const, value }),
        (cause: unknown) => ({
          kind: "settled" as const,
          failure: { cause },
        }),
      ),
      new Promise<{ kind: "budget-exhausted" }>((resolve) => {
        cleanupTimer = setTimeout(
          () => resolve({ kind: "budget-exhausted" }),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

/**
 * Record a terminal for a turn that is already failing, without replacing the
 * reason it failed.
 *
 * A journal that is unreachable must fail a turn closed *before* the provider
 * is asked, which is why `recordStarted` propagates. Here the turn has already
 * failed, so a second fault raised while recording why would hide the first
 * from the caller and from the user — and the stream stays honestly
 * non-terminal either way, which is what an operator reads.
 */
export async function withoutMaskingAgentReplyCause(
  cause: unknown,
  record: () => Promise<void> | undefined,
  failureLabel = "terminal not recorded",
): Promise<void> {
  try {
    await record();
  } catch (recordingFailure) {
    // Names only, never messages: this is a note about a journal that could
    // not be written, not a place to put provider or user text.
    logProcessWarning(
      "agent-turn-journal",
      `${failureLabel} (${describeErrorForLog(recordingFailure)}) for a turn failing with ${describeErrorForLog(cause)}`,
    );
  }
}

function describeErrorForLog(value: unknown): string {
  return value instanceof Error ? value.name : typeof value;
}

/**
 * The prepared record for one speaker's outcome.
 *
 * Written as two whole shapes rather than one object with conditional spreads,
 * because the outcome and its failure identity are a discriminated pair: a
 * spread would erase the discrimination and let a success carry a failure, or
 * a failure carry none.
 */
export function buildAgentReplyPreparedInput(input: {
  turnId: string;
  replyId: string;
  assistantMessageId: string;
  outputByteLength: number;
  journal: AgentReplyJournal;
}): AgentTurnPreparedInput {
  const { journal } = input;
  const common = {
    turnId: input.turnId,
    replyId: input.replyId,
    assistantMessageId: input.assistantMessageId,
    route: journal.route,
    outputByteLength: input.outputByteLength,
    ...whenDefined(journal.resolvedModel, (resolvedModel) => ({ resolvedModel })),
    ...whenDefined(journal.declaredToolCount, (declaredToolCount) => ({
      declaredToolCount,
    })),
    ...whenDefined(journal.executedToolCount, (executedToolCount) => ({
      executedToolCount,
    })),
    ...whenDefined(journal.usage, (usage) => ({ usage })),
  };
  return journal.outcome === "success"
    ? { ...common, outcome: "success" }
    : { ...common, outcome: journal.outcome, failure: journal.failure };
}

/**
 * The terminal that matches the outcome the user was actually given.
 *
 * Truncation is a failure here even though the chat surface closes its bubble
 * as a finished reply: what reached the transcript is the safe failure copy,
 * not the partial answer the reader saw, so a `completed` would claim an
 * answer nobody stored.
 */
export async function recordAgentReplyPublished(input: {
  recorder?: AgentTurnJournalRecorder | undefined;
  turnId: string;
  replyId: string;
  assistantMessageId: string;
  journal: AgentReplyJournal;
}): Promise<void> {
  if (!input.recorder) return;
  const { failure } = input.journal;
  if (failure) {
    await input.recorder.recordFailed({
      turnId: input.turnId,
      replyId: input.replyId,
      assistantMessageId: input.assistantMessageId,
      route: input.journal.route,
      failure,
    });
    return;
  }
  await input.recorder.recordCompleted({
    turnId: input.turnId,
    replyId: input.replyId,
    assistantMessageId: input.assistantMessageId,
    route: input.journal.route,
  });
}

/**
 * A turn that threw before it could prepare a reply.
 *
 * Cancellation is kept separate from failure because the two mean different
 * things to whoever reads the journal next: one is a user's decision and the
 * other is a fault, and only the second is worth retrying.
 */
export async function recordAgentReplyAbandonment(input: {
  recorder?: AgentTurnJournalRecorder | undefined;
  turnId: string;
  replyId: string;
  aborted: boolean;
  /** The turn's own deadline ended it; nothing is known about the provider. */
  interrupted?: boolean;
}): Promise<void> {
  if (!input.recorder) return;
  // The cause that ended the turn decides, not the signal's state at the moment
  // of recording. Both endings can land on one turn — the deadline decides it,
  // and the user closes the tab while it is unwinding — and reading the signal
  // here made that durably a cancellation, losing the interruption and the
  // retry that goes with it. A withdrawal that came *first* never reaches this
  // branch, because that turn is not raised as an interruption.
  if (input.interrupted) {
    await input.recorder.recordFailed({
      turnId: input.turnId,
      replyId: input.replyId,
      failure: {
        layer: "chat-delivery",
        phase: "provider-request",
        // Named apart from `speaker_turn_abandoned`, which is a turn that threw
        // for some reason the layers below it could describe. An interruption
        // is the absence of any such reason, and it is the one outcome the user
        // may safely be offered a retry for.
        serviceCode: AGENT_CHAT_PROVIDER_INTERRUPTED_CODE,
        retryable: true,
      },
    });
    return;
  }
  if (input.aborted) {
    await input.recorder.recordCancelled({
      turnId: input.turnId,
      replyId: input.replyId,
      phase: "provider-request",
    });
    return;
  }
  await input.recorder.recordFailed({
    turnId: input.turnId,
    replyId: input.replyId,
    failure: {
      layer: "chat-delivery",
      phase: "provider-request",
      serviceCode: "speaker_turn_abandoned",
      retryable: false,
    },
  });
}

