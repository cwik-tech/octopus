/**
 * Listening again for a disclosure that may have been missed, without
 * replaying what was already shown.
 *
 * The stream is a preview: it can drop, and its client returns normally once
 * its retries are exhausted, so "the subscription ended" is not "it delivered".
 * A turn that is still running and has disclosed nothing therefore has to be
 * reconciled against the record — and possibly listened to again.
 *
 * Two rules make that safe, and both are easy to get subtly wrong inside a
 * component where the symptom looks like a rendering problem: where to resume
 * from, and whether a second reader is allowed to exist.
 */
import { describe, expect, it } from "vitest";

import {
  advancedStreamCursor,
  planDisclosureRecovery,
} from "@/lib/chat/disclosure-recovery";

describe("advancedStreamCursor", () => {
  it("resumes after the last frame it saw", () => {
    expect(advancedStreamCursor(0, { type: "delta", cursor: 0 })).toBe(1);
    expect(advancedStreamCursor(1, { type: "delta", cursor: 4 })).toBe(5);
  });

  it("never moves backwards", () => {
    // Frames can arrive out of order across a reconnect. Taking the newest
    // cursor at face value would rewind the reader and replay text already on
    // screen.
    expect(advancedStreamCursor(9, { type: "delta", cursor: 2 })).toBe(9);
  });

  it("does not advance past a reset", () => {
    // A reset says frames were lost, not that a frame was read. Counting it
    // would skip the very frames the recovery exists to find.
    expect(advancedStreamCursor(4, { type: "reset" })).toBe(4);
  });
});

describe("planDisclosureRecovery", () => {
  const running = {
    activeJobId: "job-a",
    jobId: "job-a",
    selectionSeen: false,
    readerActive: false,
    remainingResubscribes: 3,
  };

  it("reconciles and listens again while the turn is still running silently", () => {
    expect(planDisclosureRecovery(running)).toBe("reload-and-resubscribe");
  });

  it("stops once the turn has said what it runs on", () => {
    // An explicit choice discloses by saying nothing at all, so a turn that has
    // spoken is finished with this whether or not a notice appeared.
    expect(
      planDisclosureRecovery({ ...running, selectionSeen: true }),
    ).toBe("stop");
  });

  it("stops when the panel has moved on to another turn", () => {
    expect(
      planDisclosureRecovery({ ...running, activeJobId: "job-b" }),
    ).toBe("stop");
    expect(planDisclosureRecovery({ ...running, activeJobId: null })).toBe(
      "stop",
    );
  });

  it("reconciles but does not open a second reader beside a live one", () => {
    // A reset arrives on a subscription that is still open. Listening again
    // then makes every later delta arrive twice.
    expect(planDisclosureRecovery({ ...running, readerActive: true })).toBe(
      "reload-only",
    );
  });

  it("gives up listening again once its attempts are spent", () => {
    // Bounded by attempts rather than by a timer: it is the turn that ends
    // this, and a timer would either give up on a slow provider or never stop.
    expect(
      planDisclosureRecovery({ ...running, remainingResubscribes: 0 }),
    ).toBe("reload-only");
  });
});
