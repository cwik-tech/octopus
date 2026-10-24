/**
 * Offering, and then honouring, one user-approved attempt on the app default.
 *
 * A failed explicit model does not authorize substituting another one. This
 * service decides only whether the user may be *asked*, computes an offer that
 * names exactly the pair they will see, and — when that exact offer comes back
 * approved — starts exactly one new attempt. Nothing here writes to an agent's
 * saved settings, and nothing here accepts a model from a caller.
 */

import { createHash } from "node:crypto";
import {
  reduceConversationTurnStream,
  type ConversationTurnSummary,
} from "../domains/conversations/conversation-turn-journal.js";
import { getRuntimeDefaultModelState } from "../domains/provider/default-model-selection.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import type {
  ConversationOwner,
  WorkspaceConversationJournalRegistry,
} from "./workspace-conversation-journal-registry.js";
import { runSessionAgentChatTurn } from "./agent-chat-service.js";
import type { AgentChatTurnWiring } from "./agent-chat-turn-wiring.js";
import { resolveAgentTurnJournalRecorder } from "./agent-turn-journal-recorder.js";
import type { WorkspaceExecutionJournalRegistry } from "./workspace-execution-journal-registry.js";
import type { AgentTurnSummary } from "../domains/agent-execution/agent-turn-journal.js";
import type { ChatMessage, SessionSummary } from "../contracts/sessions.js";
import type { ModelSelectionRecord } from "../contracts/agent-model-selection.js";
import {
  decideModelChoice,
  deriveExecutionToolEffectEvidence,
  evaluateModelChoiceEligibility,
  modelChoiceOfferId,
  type ModelChoiceOffer,
  type ModelChoiceAcceptance,
  type ModelChoiceRejection,
} from "../contracts/model-choice.js";

interface ConversationRegistryReader {
  /**
   * Whether this workspace journals conversations authoritatively.
   *
   * Read because it decides whether an approval can be claimed exclusively.
   * Optional so a reader built for tests or for another purpose still
   * satisfies this interface; absent is treated as no claim.
   */
  readonly journalMode?: 'authoritative' | 'disabled';
  snapshot(input: {
    owner: ConversationOwner;
    activityId: string;
    activityKind: "turn";
  }): Promise<
    | { kind: "absent" }
    | { kind: "read"; events: readonly { type: string; payload: unknown }[] }
    | { kind: string }
  >;
}

export interface ModelChoiceOfferInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sessionStore: Pick<SessionStore, "listChatMessages">;
  readonly conversationRegistry: ConversationRegistryReader;
  /**
   * Where the reply's own execution evidence lives.
   *
   * Absent means this build cannot read it, and an offer is never made without
   * it: a selected-agent reply always runs on an assignment, so the
   * conversation record alone can never prove that no tool was dispatched.
   */
  readonly executionRegistry?: WorkspaceExecutionJournalRegistry;
}

/**
 * The offer a failed turn earns, or nothing.
 *
 * Nothing is the common answer: the failure has to be one the chosen model
 * itself caused, the record has to prove no tool was dispatched, and there has
 * to be an application default that differs from what already failed.
 */
export async function offerModelChoiceForTurn(
  input: ModelChoiceOfferInput,
): Promise<ModelChoiceOffer | undefined> {
  const summary = await readTurnSummary(input);
  if (!summary) return undefined;

  // The conversation record can complete with a safe error reply while the
  // reply itself failed at the provider, so the assignment's own execution
  // record is the authority for both the failure and its side effects.
  const execution = await readExecutionSummary(input, summary);
  if (!execution || !execution.failure) return undefined;

  const messages = await input.sessionStore.listChatMessages(input.sessionId);
  const admitted = admittedSelectionsFor(messages, input.turnId);
  // One agent, because consent is per attempt. A turn that addressed several
  // agents has no single failure to attach an offer to.
  const entries = Object.entries(admitted);
  if (entries.length !== 1) return undefined;
  const [agentName, selection] = entries[0] as [string, ModelSelectionRecord];
  // Only an explicit choice can fail *as a choice*. A turn already running on
  // the default has nothing to be offered.
  if (selection.source !== "agent") return undefined;

  const eligibility = evaluateModelChoiceEligibility({
    failedChoice: { provider: selection.provider, model: selection.model },
    failureKind: execution.failure.providerKind ?? execution.failure.serviceCode,
    // The record is terminal: the existing failure policy has already finished
    // its own attempts at the chosen model.
    remainingSameModelRetries: 0,
    toolEffectEvidence: deriveExecutionToolEffectEvidence({
      failurePhase: execution.failure.phase,
      ...(execution.failure.dispatched === false
        ? { dispatched: false }
        : {}),
    }),
    appDefault: getRuntimeDefaultModelState(),
  });
  if (!eligibility.eligible) return undefined;

  const scope = {
    kind: "chat" as const,
    sessionId: input.sessionId,
    turnId: input.turnId,
  };
  const expectedRevision = turnRevision(summary);
  return {
    offerId: modelChoiceOfferId({
      scope,
      agentName,
      expectedRevision,
      proposedDefault: eligibility.proposedDefault,
    }),
    scope,
    agentName,
    expectedRevision,
    failedChoice: { provider: selection.provider, model: selection.model },
    proposedDefault: eligibility.proposedDefault,
    reason: eligibility.reason,
  };
}

export interface ModelChoiceAcceptInput extends ModelChoiceOfferInput {
  readonly session: SessionSummary;
  readonly sessionStore: SessionStore;
  readonly repoRootPath: string;
  readonly acceptance: ModelChoiceAcceptance;
  /**
   * The same collaborators an ordinary turn gets.
   *
   * Built by `agentChatTurnWiring` so an approved retry cannot end up as a
   * turn with no journals, no tool support and no cancellation — which is what
   * it was when this service assembled its own option bag.
   */
  readonly turnWiring?: AgentChatTurnWiring;
  readonly signal?: AbortSignal;
}

export type ModelChoiceAcceptResult =
  | { readonly ok: true; readonly turnId: string }
  | { readonly ok: false; readonly error: ModelChoiceRejection };

/**
 * Runs one approved attempt, or explains why it will not.
 *
 * The offer is recomputed rather than trusted, so an approval carrying an
 * identity that no longer matches — a changed default, a turn that has moved
 * on, an offer nobody made — dispatches nothing. The new attempt reuses the
 * existing turn idempotency: its id is derived from the offer and the
 * approval, so a double click replays the first attempt instead of paying for
 * a second.
 */
export async function acceptModelChoice(
  input: ModelChoiceAcceptInput,
): Promise<ModelChoiceAcceptResult> {
  const offer = await offerModelChoiceForTurn(input);
  const summary = await readTurnSummary(input);
  const messages = await input.sessionStore.listChatMessages(input.sessionId);

  // What already spent this offer, read from the transcript rather than held
  // in memory, so it survives a restart and is seen by every process.
  //
  // Looked up by the offer the caller *submitted*, not by a freshly recomputed
  // one. A recomputed offer changes when Settings change, so resolving
  // consumption through it would make a retransmission of a successful
  // approval fail after the application default moved — reporting "no such
  // offer" for work that already ran.
  const consumption = consumedApprovalFor(messages, input.acceptance.offerId);
  // An offer that has already been spent is answered from the attempt it
  // started, whoever is asking. A double click, a retransmission and a second
  // tab all learn which attempt belongs to the offer, and none of them starts
  // another one or pays for another provider call.
  if (consumption) {
    return { ok: true, turnId: consumption.turnId };
  }

  // The claim that makes one offer authorize one attempt is the conversation
  // journal's exclusive turn claim. Without it two processes can write
  // byte-identical messages, both be told the line is already present, and
  // both go on to pay for an attempt — timestamps happening to differ is luck,
  // not a guard. An approval refuses rather than running unprotected.
  if (input.conversationRegistry.journalMode !== "authoritative") {
    return {
      ok: false,
      error: {
        code: "claim-unavailable",
        message:
          "This retry cannot be authorized safely: conversation journalling is off, so one approval cannot be told from two.",
      },
    };
  }

  const decision = decideModelChoice({
    offer,
    acceptance: input.acceptance,
    currentRevision: summary ? turnRevision(summary) : "",
    appDefault: getRuntimeDefaultModelState(),
    eligibility: offer
      ? { eligible: true, reason: offer.reason, proposedDefault: offer.proposedDefault }
      : { eligible: false, reason: "no-app-default" },
    acceptedIdempotencyKeys: [],
  });
  if (!decision.ok) return { ok: false, error: decision.error };
  const approvedOffer = offer as ModelChoiceOffer;

  const retryTurnId = approvedAttemptTurnId(approvedOffer.offerId);
  const originalRequest = messages.find(
    (message) => message.role === "user" && message.turnId === input.turnId,
  );
  const originalText = originalRequest?.text ?? "";

  try {
    await runSessionAgentChatTurn({
    sessionId: input.sessionId,
    session: input.session,
    sessionStore: input.sessionStore,
    repoRootPath: input.repoRootPath,
    text: originalText,
    agentNames: [approvedOffer.agentName],
    turnId: retryTurnId,
    turnOrigin: "server",
    // Every attempt this one replaces, not just the last. Each asked the same
    // question under its own turn id and each left a user message behind, so
    // naming only the immediate predecessor lets the original re-enter the
    // quoted history on a second retry.
    supersedesTurnIds: supersededTurnIds(messages, input.turnId),
    // The same request, not a new one. Without its original context the model
    // that finally answers is answering a different question from the one that
    // failed.
    ...(originalRequest?.turnRequest?.projectContext
      ? { projectContext: originalRequest.turnRequest.projectContext }
      : {}),
    approvedSelection: {
      agentName: approvedOffer.agentName,
      selection: decision.selection,
      offer: { offerId: approvedOffer.offerId },
    },
      ...(input.turnWiring ?? {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // Where two concurrent approvals are actually separated.
    //
    // The transcript check above is a read followed by a write, so both can
    // pass it. They then meet on the turn identity they share: one opens the
    // turn, and the other is refused — either as already running, or as a
    // different message under a used identity, because the two user messages
    // carry different timestamps.
    //
    // The loser answers from what the winner durably wrote rather than
    // reporting a fault. It started nothing, paid for nothing, and the attempt
    // the user approved exists. A conflict with no durable attempt behind it
    // is a real fault and is rethrown.
    if (!isTurnIdentityConflict(error)) throw error;
    const settled = consumedApprovalFor(
      await input.sessionStore.listChatMessages(input.sessionId),
      input.acceptance.offerId,
    );
    if (!settled) throw error;
    return { ok: true, turnId: settled.turnId };
  }
  return { ok: true, turnId: retryTurnId };
}

/** True for the refusals a second approval of one offer can produce. */
function isTurnIdentityConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === "conflict") return true;
  return (
    candidate.code === "internal" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("already stored under this turn identity")
  );
}

/**
 * The new attempt's identity.
 *
 * Derived from the offer alone, deliberately not from the client's key. One
 * offer authorizes one attempt, and that has to hold against two tabs
 * approving at the same moment with keys of their own. A key in this digest
 * would give each of them a different turn, and two different turns are two
 * admissions and two provider calls — the transcript check upstream is a read
 * followed by a write and cannot stop that on its own.
 *
 * Sharing the identity makes the existing turn-admission machinery the atomic
 * claim: the first approval opens the turn, and every other approval of the
 * same offer meets it there. Shaped as a UUID because that is what a turn id
 * is allowed to be, and derived by digest so no counter or clock can make two
 * approvals collide or diverge.
 */
function approvedAttemptTurnId(offerId: string): string {
  const digest = createHash("sha256")
    .update(`model-choice\u0000${offerId}`, "utf8")
    .digest("hex");
  const version = "5";
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `${version}${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/**
 * A fingerprint of the turn's durable state.
 *
 * Changes when the turn stops being the failure the offer described, which is
 * what makes a stale tab's approval refusable.
 */
function turnRevision(summary: ConversationTurnSummary): string {
  return [
    summary.state,
    summary.failure?.code ?? "",
    summary.failure?.phase ?? "",
    summary.provider?.failure?.code ?? "",
    String(summary.assistantMessageIds.length),
  ].join("|");
}

/**
 * The reply's own execution record.
 *
 * `undefined` whenever it cannot be read or the turn named more than one
 * assignment: consent is per attempt, and an unreadable record is not evidence
 * that a repeat is safe.
 */
async function readExecutionSummary(
  input: ModelChoiceOfferInput,
  conversation: ConversationTurnSummary,
): Promise<AgentTurnSummary | undefined> {
  const registry = input.executionRegistry;
  const links = conversation.assignments ?? [];
  if (!registry || links.length !== 1) return undefined;
  const link = links[0];
  if (!link) return undefined;
  let recorder;
  try {
    recorder = await resolveAgentTurnJournalRecorder({
      registry,
      scope: {
        sessionId: input.sessionId,
        runId: input.turnId,
        assignmentId: link.assignmentId,
      },
      agentPath: "agents/unknown",
      requestId: `model-choice-read-${link.assignmentId}`,
      processIdentity: `model-choice-${input.sessionId}`,
    });
  } catch {
    return undefined;
  }
  if (!recorder) return undefined;
  try {
    return (await recorder.readSummary()) ?? undefined;
  } catch {
    return undefined;
  } finally {
    await recorder.release();
  }
}

/**
 * The approval that already spent an offer, if any.
 *
 * Read from the durable transcript. An offer authorizes one attempt, and the
 * attempt records which offer authorized it, so consumption is a fact on disk
 * rather than a client convention.
 */
function consumedApprovalFor(
  messages: readonly ChatMessage[],
  offerId: string,
): { readonly turnId: string } | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const approved = message.turnRequest?.approvedOffer;
    if (!approved || approved.offerId !== offerId) continue;
    if (!message.turnId) continue;
    return { turnId: message.turnId };
  }
  return undefined;
}

function admittedSelectionsFor(
  messages: readonly ChatMessage[],
  turnId: string,
): Readonly<Record<string, ModelSelectionRecord>> {
  return (
    messages.find(
      (message) => message.role === "user" && message.turnId === turnId,
    )?.turnRequest?.admittedSelections ?? {}
  );
}

async function readTurnSummary(
  input: ModelChoiceOfferInput,
): Promise<ConversationTurnSummary | undefined> {
  const owner: ConversationOwner = {
    kind: "run-session",
    conversationId: input.sessionId,
    sessionId: input.sessionId,
  };
  const snapshot = await input.conversationRegistry
    .snapshot({ owner, activityId: input.turnId, activityKind: "turn" })
    .catch(() => undefined);
  // A read that failed says nothing about the turn. Treating it as "no
  // evidence of tool dispatch" would be exactly the fail-open this refuses.
  if (!snapshot || snapshot.kind !== "read") return undefined;
  const events = (snapshot as { events: readonly { type: string; payload: unknown }[] })
    .events;
  return reduceConversationTurnStream(
    input.turnId,
    events.map((event) => ({ type: event.type, payload: event.payload })),
  );
}

/**
 * Every turn whose user message is this same question, re-asked.
 *
 * An approved retry runs under a turn id derived from the offer, and the offer
 * is made against the attempt that failed — so on a second retry `turnId` names
 * the *first* retry, not the original. Naming one predecessor therefore leaves
 * the original's copy in the transcript and the model reads the question twice
 * again, which is the duplication this exists to remove.
 *
 * Matched on the text rather than by walking a chain, because no link between
 * attempts is recorded and the thing being de-duplicated is the text itself.
 * A user who genuinely types the same question twice loses the earlier copy
 * from the quoted history; the earlier *answers* are untouched, so what the
 * conversation established is still there.
 */
function supersededTurnIds(
  messages: readonly ChatMessage[],
  turnId: string,
): string[] {
  const question = messages.find(
    (message) => message.role === "user" && message.turnId === turnId,
  )?.text;
  if (question === undefined) return [turnId];
  const ids = new Set<string>([turnId]);
  for (const message of messages) {
    if (message.role !== "user" || message.turnId === undefined) continue;
    if (message.text === question) ids.add(message.turnId);
  }
  return [...ids];
}
