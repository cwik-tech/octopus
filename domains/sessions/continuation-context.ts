/**
 * The results a turn carries forward, and the block a responder reads.
 *
 * Pure: selection is a decision about typed references, and rendering is a
 * decision about strings. Neither reads anything.
 *
 * Two selection rules. A turn that names ids carries exactly those, refusing
 * rather than trimming, because a caller that asked for something specific is
 * owed it or owed an error. A turn that names nothing carries this session's
 * recent finished work, because a session is one topic.
 *
 * The second rule replaced a picker in the composer. That picker was the
 * honest answer to an earlier version which attached the three most recent
 * results with no way to see or clear them; making the choice visible fixed
 * the invisibility but left the user managing plumbing, and its commonest
 * offer — an agent reply already sitting in the transcript the next agent
 * reads — changed nothing at all. What remains automatic is narrower than
 * what was reverted: only work the transcript cannot reach.
 *
 * See `docs/adr/2026-09-09-Continuation-Context-Result-References.md`.
 */

import {
  MAX_CONTEXT_RESULTS_PER_TURN,
  type ResultReference,
} from "../../contracts/schemas/result-reference.js";

/** How many results one turn may carry. More is refused, never trimmed. */
export const MAX_CONTINUATION_RESULTS = MAX_CONTEXT_RESULTS_PER_TURN;

/** How much of one result may be quoted. */
export const MAX_CONTINUATION_RESULT_CHARS = 2000;

/** The ceiling on the whole block, whatever the per-result limits allowed. */
export const MAX_CONTINUATION_CONTEXT_CHARS = 6000;

/** Why a selected reference was not used. */
export type ContinuationRejection =
  | "unknown"
  | "not-terminal"
  | "too-many"
  | "duplicate"
  /** The run it names is no longer the run it was published from. */
  | "changed"
  /**
   * Nothing can prove the content is what was published.
   *
   * Separate from `changed` because they need different answers: a changed
   * result is one the user should look at again, and an unverifiable one is a
   * gap in what this build recorded.
   */
  | "unverifiable";

export interface ContinuationSelection {
  /** The references to resolve, in the order they were selected. */
  readonly selected: readonly ResultReference[];
  /** Every id that was asked for and will not be used, and why. */
  readonly rejected: readonly { id: string; reason: ContinuationRejection }[];
}

/**
 * What a turn carries when nobody named anything.
 *
 * A session is one topic. The work it has already finished belongs to whoever
 * is asked next, and requiring the user to say so on every turn made them manage
 * plumbing the system can see for itself.
 *
 * Agent replies are deliberately excluded. Every agent turn already receives a
 * window of the shared transcript, so an agent's reply is in front of the next
 * reader whether this carries it or not; spending one of three slots on it
 * would push out a Team or Workflow result, which the transcript cannot reach
 * at all. A chat-only Team writes its conclusions to its run's event log and a
 * Workflow leaves a card rather than its document, so those two are the whole
 * reason this exists.
 *
 * Ordered oldest first, so the block reads forwards like the conversation it
 * belongs to.
 */
export function defaultContinuationSelection(input: {
  available: readonly ResultReference[];
}): string[] {
  return input.available
    .filter(
      (reference) =>
        reference.status === "done" && reference.producer.kind !== "agent",
    )
    .slice()
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
    .slice(-MAX_CONTINUATION_RESULTS)
    .map((reference) => reference.id);
}

/**
 * Which of the session's results this turn asked for.
 *
 * Rejections are returned rather than thrown, because the boundary decides
 * what a rejection means: the request layer refuses the turn, and a background
 * caller may prefer to answer without the context. Both need to know which id
 * and why.
 */
export function selectContinuationReferences(input: {
  available: readonly ResultReference[];
  selectedIds: readonly string[];
}): ContinuationSelection {
  const byId = new Map(input.available.map((entry) => [entry.id, entry]));
  const selected: ResultReference[] = [];
  const rejected: { id: string; reason: ContinuationRejection }[] = [];
  const seen = new Set<string>();

  for (const id of input.selectedIds) {
    if (seen.has(id)) {
      rejected.push({ id, reason: "duplicate" });
      continue;
    }
    seen.add(id);
    const reference = byId.get(id);
    if (!reference) {
      rejected.push({ id, reason: "unknown" });
      continue;
    }
    if (reference.status !== "done") {
      rejected.push({ id, reason: "not-terminal" });
      continue;
    }
    if (selected.length >= MAX_CONTINUATION_RESULTS) {
      rejected.push({ id, reason: "too-many" });
      continue;
    }
    selected.push(reference);
  }

  return { selected, rejected };
}

/** One selected result, with whatever content the shell could read for it. */
export interface ResolvedResult {
  readonly reference: ResultReference;
  /** The result text, when there is one that can be read. */
  readonly content?: string;
  /** Why there is no content, when there is not. */
  readonly unavailable?: string;
}

/**
 * The block, or `undefined` when nothing was carried forward.
 *
 * `undefined` rather than an empty heading: a heading with nothing under it
 * reads as "there were no results" when the truth is that none was chosen.
 */
export function renderContinuationContext(
  results: readonly ResolvedResult[],
): string | undefined {
  if (results.length === 0) return undefined;

  const lines: string[] = [
    "Results carried into this turn. These were chosen for you and are yours to read, quote and summarize:",
  ];
  for (const { reference, content, unavailable } of results) {
    lines.push("");
    lines.push(
      `- ${reference.producer.label} (${reference.producer.kind}), completed ${reference.completedAt}`,
    );
    // The stable identity stays beside the content even when the content is
    // an excerpt, so a shortened result is still traceable to its source.
    lines.push(`  Result id: ${reference.id}`);
    if (reference.source.kind === "artifact") {
      lines.push(`  Artifact: ${reference.source.path}`);
    }
    if (reference.brief) lines.push(`  Asked: ${collapse(reference.brief, 300)}`);
    if (content === undefined) {
      lines.push(`  Content: (${unavailable ?? "not available"})`);
      continue;
    }
    lines.push("  Content:");
    lines.push(indent(bounded(content, MAX_CONTINUATION_RESULT_CHARS)));
  }

  return bounded(lines.join("\n"), MAX_CONTINUATION_CONTEXT_CHARS);
}

/** A cap that says it was applied, so nothing reads as a complete document. */
function bounded(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n… (truncated)`;
}

function collapse(value: string, limit: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
