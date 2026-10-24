/**
 * Reading the results a turn chose to carry forward.
 *
 * The input/output shell around the pure selection and rendering in
 * `domains/sessions/continuation-context.ts`. It is the only part that touches
 * disk, and it reads **only** what selection returned: an earlier version read
 * every completed task's artifact in full and then chose three, so the block
 * was bounded while the reads were not.
 *
 * See `docs/adr/2026-09-09-Continuation-Context-Result-References.md`.
 */

import type { ChatMessage, SessionTask } from "../contracts/sessions.js";
import type { ResultReference } from "../contracts/schemas/result-reference.js";
import type { RunStore } from "../domains/run/run-store.js";
import type { SessionStore } from "../domains/sessions/session-store.js";
import {
  findTaskDelivery,
  projectResultReferences,
} from "../domains/sessions/result-reference-projection.js";
import {
  defaultContinuationSelection,
  renderContinuationContext,
  selectContinuationReferences,
  type ContinuationRejection,
  type ContinuationSelection,
  type ResolvedResult,
} from "../domains/sessions/continuation-context.js";
import {
  extractTeamChatPriorTurn,
  renderCarriedTeamReplies,
} from "./team-chat-context.js";
import * as crypto from "node:crypto";

/**
 * The same digest shape the publication records: hex SHA-256 of the bytes.
 *
 * The store hands back text artifacts already decoded, so this re-encodes to
 * compare. For valid UTF-8 that is byte-identical to what was published. A
 * file whose bytes are not valid UTF-8 decodes lossily and will not match,
 * which refuses the result rather than carrying unverified content — the safe
 * direction, and the reason this is a comparison rather than a computation of
 * what the digest ought to be.
 */
function sha256Of(content: string): string {
  return crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

/**
 * The read ceiling for one referenced artifact.
 *
 * Well above an ordinary deliverable and far below anything that would matter
 * to memory. `readArtifact` refuses a file larger than this rather than
 * truncating it, which is the honest outcome: the excerpt limit shortens what
 * was read, and this decides what may be read at all.
 */
export const MAX_RESULT_READ_BYTES = 256 * 1024;

type ResultStore = Pick<
  SessionStore,
  | "listResultReferences"
  | "publishResultReference"
  | "listTaskRecords"
  | "listChatMessages"
  | "resolveTaskPublication"
>;

/**
 * Every result this session can offer, recording any it had not recorded yet.
 *
 * Deriving and persisting rather than only reading, so a run that completed
 * before results were recorded is still offerable. Publication is idempotent
 * by producer and execution attempt, so this settles after the first call and
 * writes nothing on later ones.
 */
export async function ensureResultReferences(input: {
  sessionId: string;
  sessionStore: ResultStore;
}): Promise<ResultReference[]> {
  let tasks: SessionTask[] = [];
  let messages: ChatMessage[] = [];
  try {
    // Sequential, and in this order. `listTaskRecords` reconciles terminal
    // results, which can publish a delivery card; reading the transcript
    // concurrently could therefore snapshot it from before that write and
    // conclude a finished Workflow published nothing.
    tasks = await input.sessionStore.listTaskRecords(input.sessionId);
    messages = await input.sessionStore.listChatMessages(input.sessionId);
  } catch {
    // A session whose state cannot be read offers no continuation. It must
    // still be able to hold a conversation.
    return input.sessionStore
      .listResultReferences(input.sessionId)
      .then((held) => held.filter(canEverBeVerified))
      .catch(() => []);
  }

  const existing = await input.sessionStore
    .listResultReferences(input.sessionId)
    .catch(() => [] as ResultReference[]);
  const held = new Set(existing.map((reference) => reference.id));
  const projected = await withTrustedDigests({
    references: projectResultReferences({
      sessionId: input.sessionId,
      tasks,
      messages,
    }),
    sessionId: input.sessionId,
    sessionStore: input.sessionStore,
  });

  // Held records that cannot be re-verified at use time. Offering them again
  // lets the store repair them; every other held id is skipped. A record with
  // a task id but no digest is just as unusable as one with neither, so both
  // shapes are re-offered rather than only the older one.
  const unverifiable = new Set(
    existing
      .filter((reference) => needsRepair(reference) && canEverBeVerified(reference))
      .map((reference) => reference.id),
  );
  // Attempted, not written. A caller that lost every race still has to answer
  // with what is now stored: two overlapping callers project the same records
  // from the same empty list, and returning only this caller's own additions
  // made the loser answer with nothing. The later response then hid completed
  // results, or dropped a selection made against them.
  let attempted = false;
  const written: ResultReference[] = [];
  for (const reference of projected) {
    if (!canEverBeVerified(reference)) continue;
    if (held.has(reference.id) && !unverifiable.has(reference.id)) continue;
    attempted = true;
    const published = await input.sessionStore
      .publishResultReference(input.sessionId, reference)
      .catch(() => false);
    if (published) {
      held.add(reference.id);
      written.push(reference);
    }
  }
  // Nothing attempted means everything projected was already held, and a
  // concurrent caller projecting the same state had nothing to add either.
  if (!attempted) return existing.filter(canEverBeVerified);
  const listed = await input.sessionStore
    .listResultReferences(input.sessionId)
    .catch(() => withOwnWrites(existing, written));
  return listed.filter(canEverBeVerified);
}

/**
 * The held records plus the ones this call wrote, for when the re-read fails.
 *
 * Falling back to the list read before publishing answered without the very
 * references this call had just created, so a run that had only just finished
 * was missing from the picker until something listed again. A record written
 * here replaces the held one of the same id, because a repair is a rewrite of
 * that id.
 */
function withOwnWrites(
  held: readonly ResultReference[],
  written: readonly ResultReference[],
): ResultReference[] {
  const byId = new Map(held.map((reference) => [reference.id, reference]));
  for (const reference of written) byId.set(reference.id, reference);
  return [...byId.values()];
}

/**
 * Whether a digest for this reference could ever be established.
 *
 * An artifact is read only against the digest its publication recorded, and
 * the marker holding that digest is named by the execution attempt. A record
 * with neither has nothing to recover one from, and no later call changes
 * that: it sat in the picker offering a result that refused every turn it was
 * attached to, and each listing rewrote it in the hope of a repair that could
 * not happen.
 *
 * Withheld rather than offered and refused. The run is still visible — its
 * delivery card is in the transcript where it always was — and what is lost is
 * only the ability to carry bytes nothing can vouch for.
 */
function canEverBeVerified(reference: ResultReference): boolean {
  if (reference.source.kind !== "artifact") return true;
  if (reference.source.digest !== undefined) return true;
  return reference.executionAttemptId !== undefined;
}

/** Whether a held record still lacks something use-time validation needs. */
function needsRepair(reference: ResultReference): boolean {
  if (reference.producer.kind === "agent") return false;
  if (reference.producerTaskId === undefined) return true;
  return reference.source.kind === "artifact" && reference.source.digest === undefined;
}

/**
 * Fill in each artifact reference's digest from the authoritative publication.
 *
 * The delivery card only started carrying one recently, and an existing card is
 * never rewritten, so the card is not a source this can rely on. The publication
 * marker is: it records each child artifact's own SHA-256, which is the digest
 * of the file being carried rather than of the root result wrapper around it.
 *
 * Deliberately not computed from the file being checked. A digest taken from
 * the bytes under inspection proves nothing about what was published.
 */
async function withTrustedDigests(input: {
  references: readonly ResultReference[];
  sessionId: string;
  sessionStore: ResultStore;
}): Promise<ResultReference[]> {
  const filled: ResultReference[] = [];
  for (const reference of input.references) {
    const source = reference.source;
    if (
      source.kind !== "artifact" ||
      source.digest !== undefined ||
      reference.producerTaskId === undefined ||
      reference.executionAttemptId === undefined
    ) {
      filled.push(reference);
      continue;
    }
    const publication = await input.sessionStore
      .resolveTaskPublication(
        input.sessionId,
        reference.producerTaskId,
        reference.executionAttemptId,
      )
      .catch(() => null);
    const verified =
      publication?.status === "ready"
        ? publication.artifacts.find(
            (artifact) =>
              artifact.childRunId === source.runId && artifact.path === source.path,
          )
        : undefined;
    filled.push(
      verified
        ? {
            ...reference,
            source: { ...source, digest: verified.sha256 },
            ...(reference.artifacts
              ? {
                  artifacts: reference.artifacts.map((artifact) => {
                    const match =
                      publication?.status === "ready"
                        ? publication.artifacts.find(
                            (candidate) =>
                              candidate.childRunId === artifact.runId &&
                              candidate.path === artifact.path,
                          )
                        : undefined;
                    return match ? { ...artifact, digest: match.sha256 } : artifact;
                  }),
                }
              : {}),
          }
        : reference,
    );
  }
  return filled;
}

export interface ResolvedContinuation {
  /** The rendered block, or `undefined` when nothing was carried. */
  readonly context?: string;
  /** Ids that were asked for and not used, with the reason for each. */
  readonly rejected: ContinuationSelection["rejected"];
}

/**
 * The block for one admitted turn.
 *
 * Resolved once and handed to every responder in that turn, so a multi-agent
 * turn cannot give two agents different views of the same past.
 */
export async function resolveContinuationContext(input: {
  sessionId: string;
  selectedIds: readonly string[];
  /**
   * Carry this session's recent finished work when the turn named nothing.
   *
   * The composer no longer asks, so an empty list means "decide for me" rather
   * than "carry nothing". Off by default, because a background caller that
   * genuinely means nothing must be able to say so.
   */
  carryRecentWhenUnchosen?: boolean;
  sessionStore: ResultStore;
  runStore?: Pick<RunStore, "readArtifact" | "listRunEvents">;
  messages?: readonly ChatMessage[];
  signal?: AbortSignal;
}): Promise<ResolvedContinuation> {
  const chosen = input.selectedIds.length > 0;
  if (!chosen && input.carryRecentWhenUnchosen !== true) return { rejected: [] };

  const available = await ensureResultReferences({
    sessionId: input.sessionId,
    sessionStore: input.sessionStore,
  });
  // A rejection means "you asked for this and it is broken", which is worth
  // refusing a turn over. Nothing the server picked for itself carries that
  // weight: a result it cannot read is one it simply does not carry, and
  // failing the user's message over it would be a refusal they could neither
  // predict nor clear.
  const selection = selectContinuationReferences({
    available,
    selectedIds: chosen
      ? input.selectedIds
      : defaultContinuationSelection({ available }),
  });
  if (selection.selected.length === 0) {
    return { rejected: chosen ? selection.rejected : [] };
  }

  const messages =
    input.messages ??
    (await input.sessionStore.listChatMessages(input.sessionId).catch(() => []));
  const tasks = await input.sessionStore
    .listTaskRecords(input.sessionId)
    .catch(() => [] as SessionTask[]);

  const resolved: ResolvedResult[] = [];
  const rejected = [...selection.rejected];
  for (const reference of selection.selected) {
    input.signal?.throwIfAborted();
    // Checked against the run it names, not trusted because it was true once.
    // A reference is followed, and the state it points into can move: a task
    // retried under a new attempt, or one whose delivery now names a different
    // artifact, is not the result the user chose.
    if (!stillMatchesItsSource(reference, tasks, messages)) {
      if (chosen) rejected.push({ id: reference.id, reason: "changed" });
      continue;
    }
    const outcome = await readResult(reference, messages, input.runStore);
    // A validation failure is a refusal, not a note in the block. Recorded as
    // an unavailable line it left the turn running with the chosen result
    // missing while the composer still showed it attached.
    if ("rejection" in outcome) {
      if (chosen) rejected.push({ id: reference.id, reason: outcome.rejection });
      continue;
    }
    resolved.push(outcome.result);
  }

  const context = renderContinuationContext(resolved);
  return {
    ...(context === undefined ? {} : { context }),
    rejected,
  };
}

/**
 * Whether the run a reference names is still the run it was published from.
 *
 * Provenance, not content. It catches what the reference itself can prove: a
 * task that vanished, stopped being terminal, was retried under a new attempt,
 * or no longer publishes the artifact this points at. An artifact rewritten in
 * place passes all four, and `readResult` is what catches that, by comparing
 * the bytes against the digest the publication recorded.
 */
function stillMatchesItsSource(
  reference: ResultReference,
  tasks: readonly SessionTask[],
  messages: readonly ChatMessage[],
): boolean {
  // An Agent reply is its own record: its source is the transcript line, and
  // the read below either finds it or reports it gone.
  if (reference.producer.kind === "agent") return true;
  // A Team or Workflow reference has to name the run it came from. One written
  // before that was recorded cannot be checked, and an unverifiable pointer is
  // refused rather than trusted — `ensureResultReferences` upgrades those
  // records in place, so a session repairs itself on the next listing.
  if (reference.producerTaskId === undefined) return false;
  const task = tasks.find((candidate) => candidate.id === reference.producerTaskId);
  if (!task) return false;
  if (task.status !== "done") return false;
  if ((task.executionAttemptId ?? undefined) !== (reference.executionAttemptId ?? undefined)) {
    return false;
  }
  const source = reference.source;
  if (source.kind !== "artifact") return true;
  // The same rule projection used to choose this card. Two rules meant a task
  // whose retry left a second card could be rejected for ever, or carried from
  // the wrong one.
  const delivery = findTaskDelivery(messages, task);
  return (
    delivery?.artifacts.some(
      (artifact) =>
        artifact.runId === source.runId && artifact.path === source.path,
    ) === true
  );
}

/**
 * One read: the result, or the reason this reference may not be used.
 *
 * A rejection rather than an unavailable line, because the two mean different
 * things to the turn. "The Team recorded no messages" is a fact about a result
 * the user may still want attached; "these bytes are not what was published"
 * means the turn must not proceed as though it carried the result at all.
 */
type ReadOutcome =
  | { readonly result: ResolvedResult }
  | { readonly rejection: ContinuationRejection };

async function readResult(
  reference: ResultReference,
  messages: readonly ChatMessage[],
  runStore: Pick<RunStore, "readArtifact" | "listRunEvents"> | undefined,
): Promise<ReadOutcome> {
  const source = reference.source;
  if (source.kind === "chat-message") {
    const message = messages.find((candidate) => candidate.id === source.messageId);
    return message
      ? { result: { reference, content: message.text } }
      : { rejection: "changed" };
  }

  if (!runStore) {
    return {
      result: {
        reference,
        unavailable: "run state is unavailable in this build",
      },
    };
  }

  if (source.kind === "artifact") {
    // Fail closed. Without a digest nothing distinguishes the published bytes
    // from whatever now sits at that path, and inlining them anyway would
    // supply the responder unverified content under a completed result's
    // identity.
    if (source.digest === undefined) return { rejection: "unverifiable" };
    const artifact = await runStore
      .readArtifact(source.runId, source.path, { maxBytes: MAX_RESULT_READ_BYTES })
      .catch(() => null);
    if (!artifact) {
      return {
        result: {
          reference,
          unavailable: "the artifact is missing or too large to inline",
        },
      };
    }
    if (typeof artifact.content !== "string") {
      return {
        result: { reference, unavailable: "binary document, content not inlined" },
      };
    }
    // The bytes just read, against the digest the publication recorded for
    // this file. Without this a rewritten artifact reaches the responder under
    // the identity of the result the user actually chose.
    if (sha256Of(artifact.content) !== source.digest) {
      return { rejection: "changed" };
    }
    return { result: { reference, content: artifact.content } };
  }

  // A chat-only Team. Its output is the accepted messages its run recorded,
  // which is what `team-chat-context` already reads for the same Team's own
  // follow-ups. Nothing is manufactured to make it look like a delivery.
  const events = await runStore.listRunEvents(source.runId).catch(() => []);
  const turn = extractTeamChatPriorTurn(reference.brief ?? "", events);
  if (turn.replies.length === 0) {
    return {
      result: {
        reference,
        unavailable: "this run recorded no accepted messages",
      },
    };
  }
  return {
    result: {
      reference,
      // Conclusion first. Joined in publication order the lead's synthesis is
      // last, so whatever shortens this from the front removes the decision
      // before anything else — which is what made "what did they decide?"
      // reach an agent that had been given everything except the decision.
      content: renderCarriedTeamReplies(turn.replies),
    },
  };
}
