/**
 * The provider budget one update job shares, with cancellation.
 *
 * `ConcurrencySemaphore` has no notion of a withdrawn waiter, so a cancelled
 * job queued behind held capacity would wait for provider work it no longer
 * wants. This gate keeps that behaviour inside the update path rather than
 * changing the semaphore every other caller relies on.
 */

import type { PlannedAgentGenerationGate } from "../domains/agent-generator/planned-agent-builder.js";

interface QueuedWaiter {
  admit(): void;
  reject(reason: Error): void;
  settled: boolean;
}

export function createResourceUpdateGate(limit: number): PlannedAgentGenerationGate {
  const capacity = Math.max(1, limit);
  let inUse = 0;
  const waiting: QueuedWaiter[] = [];

  const admitNext = (): void => {
    while (waiting.length > 0 && inUse < capacity) {
      const next = waiting.shift();
      if (!next || next.settled) continue;
      inUse += 1;
      next.admit();
    }
  };

  return {
    acquire(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(abortError());
      if (inUse < capacity) {
        inUse += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: QueuedWaiter = {
          settled: false,
          admit: () => {
            if (waiter.settled) return;
            waiter.settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          reject: (reason) => {
            if (waiter.settled) return;
            waiter.settled = true;
            signal?.removeEventListener("abort", onAbort);
            reject(reason);
          },
        };
        function onAbort(): void {
          // Removed from the queue, and no permit is returned: this waiter
          // never held one.
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          waiter.reject(abortError());
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.push(waiter);
      });
    },
    release(): void {
      if (inUse > 0) inUse -= 1;
      admitNext();
    },
  };
}

function abortError(): Error {
  const error = new Error("Resource update cancelled while waiting for capacity");
  error.name = "AbortError";
  return error;
}
