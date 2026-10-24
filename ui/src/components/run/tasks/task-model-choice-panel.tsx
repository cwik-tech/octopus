import { useEffect, useRef, useState } from "react";

import { ModelChoiceCard } from "@/components/run/chat/model-choice-card";
import {
  approveTaskModelChoice,
  getTaskModelChoice,
} from "@/lib/clients/session-client";
import type { ModelChoiceOffer } from "@contracts/model-choice";
import type { SessionTask } from "@contracts/sessions";

interface TaskModelChoicePanelProps {
  sessionId: string;
  taskId: string;
  /** Overridable only so a test can pin the key; production uses crypto. */
  newIdempotencyKey?: (() => string) | undefined;
  /**
   * Receives the task the approval admitted, so the pane adopts the
   * continuation immediately rather than waiting for the next status poll.
   */
  onApproved?: ((task: SessionTask) => void) | undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The key that makes one approval one approval.
 *
 * Drawn from the platform's cryptographic randomness, never from a clock or
 * `Math.random`: two approvals that collided on a key could be told apart by
 * nothing, and the whole point of the key is that a retry is not a second
 * decision. If no such source exists, this refuses rather than inventing one.
 */
function createIdempotencyKey(): string {
  const source = globalThis.crypto;
  if (source?.randomUUID) return source.randomUUID();
  if (source?.getRandomValues) {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  throw new Error(
    "Cannot approve a model choice: no cryptographic randomness is available for the idempotency key.",
  );
}

/**
 * The one decision a suspended task is waiting on.
 *
 * Its own surface, not human input and not the chat model choice: those admit
 * arbitrary text and arbitrary turns, while this admits exactly one offer for
 * one task. Reads and approvals both go to that task's endpoint, so what is
 * shown and what is approved are the same thing.
 *
 * The offer is durable, so a reload lands here again and reads the same pending
 * decision rather than losing it.
 */
export function TaskModelChoicePanel({
  sessionId,
  taskId,
  onApproved,
  newIdempotencyKey = createIdempotencyKey,
}: TaskModelChoicePanelProps) {
  const [offer, setOffer] = useState<ModelChoiceOffer | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  /**
   * Set once this pane's own approval succeeds.
   *
   * Without it, the moment after approval looks identical to "the task says it
   * is waiting but no offer came back", and the pane would accuse itself of a
   * fault while the continuation is starting normally.
   */
  const [approved, setApproved] = useState(false);

  /**
   * One key per offer, held across retries.
   *
   * A refused approval is retried with the key it already used, so a retry can
   * never be admitted as a second decision. A fresh key per click would make
   * the server's idempotency guarantee unreachable from here.
   */
  const acceptanceKey = useRef<{ offerId: string; key: string } | null>(null);
  const inFlight = useRef(false);
  /**
   * Which pane an answer belongs to.
   *
   * Aborting abandons this pane's wait; it cannot undo a commit the server has
   * already made. So the generation matters as much as the abort: an answer may
   * still arrive, and what must not happen is it landing on a pane that has
   * gone away, or on a different session's, and being applied there. Every
   * generation but the current one is ignored.
   */
  const generation = useRef(0);
  /**
   * Abandons a wait this pane no longer owns.
   *
   * The server may already have committed the approval, and aborting does not
   * un-commit it — it stops *this* pane waiting for an answer addressed to a
   * session it has left.
   */
  const approvalWait = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current += 1;
    const current = generation.current;
    return () => {
      if (generation.current === current) generation.current += 1;
      approvalWait.current?.abort();
      approvalWait.current = null;
    };
  }, [sessionId, taskId]);

  useEffect(() => {
    // Abandoned rather than merely ignored when the pane goes away: an
    // in-flight read that nothing will use should not stay on the wire.
    const reading = new AbortController();
    void getTaskModelChoice(sessionId, taskId, { signal: reading.signal })
      .then((pending) => {
        if (reading.signal.aborted) return;
        setOffer(pending?.offer ?? null);
        setError(null);
        setLoaded(true);
      })
      .catch((cause) => {
        if (reading.signal.aborted) return;
        setError(messageOf(cause));
        setLoaded(true);
      });
    return () => {
      reading.abort();
    };
  }, [sessionId, taskId]);

  const keyFor = (offerId: string): string => {
    const held = acceptanceKey.current;
    if (held?.offerId === offerId) return held.key;
    const fresh = { offerId, key: newIdempotencyKey() };
    acceptanceKey.current = fresh;
    return fresh.key;
  };

  const approve = async (accepted: ModelChoiceOffer) => {
    // Guarded by a ref rather than by the disabled button alone: a second click
    // can be delivered before a re-render, and admitting two continuations is
    // the failure this whole surface exists to prevent.
    if (inFlight.current) return;
    inFlight.current = true;
    const pane = generation.current;
    const waiting = new AbortController();
    approvalWait.current = waiting;
    setApproving(true);
    try {
      const admitted = await approveTaskModelChoice(
        sessionId,
        taskId,
        {
          offerId: accepted.offerId,
          idempotencyKey: keyFor(accepted.offerId),
        },
        { signal: waiting.signal },
      );
      if (generation.current !== pane) return;
      setOffer(null);
      setError(null);
      setApproved(true);
      onApproved?.(admitted.task);
    } catch (cause) {
      if (generation.current !== pane) return;
      const refusal = messageOf(cause);
      // A refusal usually means the offer moved on — a newer revision, a
      // changed app default. Re-read so the pair on screen is the pair that
      // would now run, instead of the one that was just refused.
      try {
        const refreshed = await getTaskModelChoice(sessionId, taskId, {
          signal: waiting.signal,
        });
        if (generation.current !== pane) return;
        setOffer(refreshed?.offer ?? null);
        setError(refusal);
      } catch (refreshCause) {
        if (generation.current !== pane) return;
        setError(`${refusal} Refresh failed: ${messageOf(refreshCause)}`);
      }
    } finally {
      inFlight.current = false;
      if (approvalWait.current === waiting) approvalWait.current = null;
      if (generation.current === pane) setApproving(false);
    }
  };

  if (!loaded || approved) return null;
  if (!offer) {
    // The task's status is what put this pane on screen. Reaching here means
    // the run says it is waiting while the decision cannot be read, and saying
    // so is more use than an empty space where a question should be.
    return (
      <p role="alert" className="px-4 pt-4 text-xs text-destructive">
        {error ??
          "This task is waiting on a model choice, but the decision could not be read."}
      </p>
    );
  }

  return (
    <section
      aria-label="Model choice decision"
      className="shrink-0 border-b border-border/40 p-4"
    >
      <ModelChoiceCard
        offer={offer}
        disabled={approving}
        onApprove={(accepted) => approve(accepted)}
      />
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
