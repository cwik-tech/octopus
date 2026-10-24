/**
 * Turning two sources of "which model ran" into one honest list.
 *
 * A turn in flight publishes its selection on the stream; a turn that finished
 * is described by what the run recorded. They overlap, they arrive in either
 * order, and only one of them is what a person should be shown for a given
 * turn — so the folding rule is the thing worth testing on its own, away from
 * a rendered panel where a wrong answer looks like a layout problem.
 */
import { describe, expect, it } from "vitest";

import {
  architectSelectionNotices,
  readArchitectTurnHistory,
} from "@/lib/models/architect-turn-history";

const INHERITED = {
  provider: "connection:fixture",
  model: "fake/app-default",
  source: "app-default",
  reason: "agent-default",
  caller: "authoring",
} as const;

const CHOSEN = {
  provider: "connection:fixture",
  model: "fake/app-default",
  source: "user",
  reason: "explicit-user-choice",
  caller: "authoring",
} as const;

describe("readArchitectTurnHistory", () => {
  it("keeps the readable turns and drops only what it cannot read", () => {
    const records = readArchitectTurnHistory({
      turns: [
        { jobId: "job-a", selection: INHERITED },
        // No pair: the turn happened and is kept, but claims nothing.
        { jobId: "job-b" },
        // Half a record. A notice built from this would state something no
        // turn recorded, so the selection goes and the turn stays.
        { jobId: "job-c", selection: { provider: "connection:fixture" } },
        // Not a turn at all.
        { selection: INHERITED },
        "job-d",
        null,
      ],
    });

    expect(records).toEqual([
      { jobId: "job-a", selection: INHERITED },
      { jobId: "job-b" },
      { jobId: "job-c" },
    ]);
  });

  it("answers nothing for a payload it cannot read", () => {
    for (const payload of [undefined, null, [], "turns", { turns: {} }, {}]) {
      expect(readArchitectTurnHistory(payload)).toEqual([]);
    }
  });
});

describe("architectSelectionNotices", () => {
  const speaker = "Workflow Architect";

  it("describes one turn once, whichever source it came from", () => {
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a", selection: INHERITED }],
      live: [{ jobId: "job-a", selection: INHERITED }],
      speaker,
    });

    expect(notices).toEqual([
      { jobId: "job-a", speaker, selection: INHERITED },
    ]);
  });

  it("keeps a live turn when its history arrives late", () => {
    // The load can land after the turn it does not contain has already begun.
    // Folding by job means the newcomer survives rather than being replaced by
    // a list that predates it.
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a", selection: INHERITED }],
      live: [{ jobId: "job-b", selection: INHERITED }],
      speaker,
    });

    expect(notices.map((notice) => notice.jobId)).toEqual(["job-a", "job-b"]);
  });

  it("says nothing about a pair somebody chose", () => {
    // Even though this pair is identical to the default. An explicit choice
    // described as inherited is false, and identical values are exactly when
    // that mistake cannot be seen.
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a", selection: CHOSEN }],
      live: [{ jobId: "job-b", selection: CHOSEN }],
      speaker,
    });

    expect(notices).toEqual([]);
  });

  it("says nothing about a turn that recorded no pair", () => {
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a" }],
      live: [{ jobId: "job-b" }],
      speaker,
    });

    expect(notices).toEqual([]);
  });

  it("lets a live choice retract a recorded default for the same turn", () => {
    // The order matters. Deciding which records deserve a notice *before*
    // folding them by job leaves the stale default in the list: the live record
    // says this turn is running on a pair somebody chose, and the recorded one
    // still says it inherited. Fold first, then ask.
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a", selection: INHERITED }],
      live: [
        {
          jobId: "job-a",
          selection: { ...CHOSEN, model: "fake/chosen-instead" },
        },
      ],
      speaker,
    });

    expect(notices).toEqual([]);
  });

  it("keeps other turns when one of them is retracted", () => {
    const notices = architectSelectionNotices({
      history: [
        { jobId: "job-a", selection: INHERITED },
        { jobId: "job-b", selection: INHERITED },
      ],
      live: [{ jobId: "job-a", selection: CHOSEN }],
      speaker,
    });

    expect(notices.map((notice) => notice.jobId)).toEqual(["job-b"]);
  });

  it("prefers the live record when two records disagree about one turn", () => {
    // Precedence, not a model switch: a turn's selection is decided once, per
    // invocation. What this settles is which of two records describing the same
    // job is the one shown — the live one, which is what the person is
    // watching, over a recorded one that may be a stale `running` row.
    const later = { ...INHERITED, model: "fake/replacement-default" } as const;
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a", selection: INHERITED }],
      live: [{ jobId: "job-a", selection: later }],
      speaker,
    });

    expect(notices).toEqual([{ jobId: "job-a", speaker, selection: later }]);
  });
});

describe("history labels", () => {
  it("carries the record's own time, not the time it was read", () => {
    // A restored notice has to say which turn it describes. Stamping it when
    // history was read would date every old turn to this moment, which is the
    // same mistake as re-deriving its model from today's Settings.
    const records = readArchitectTurnHistory({
      turns: [
        {
          jobId: "job-a",
          recordedAt: "2026-09-09T10:00:00.000Z",
          selection: INHERITED,
        },
        // No usable time: the turn is kept and simply carries no label.
        { jobId: "job-b", recordedAt: "", selection: INHERITED },
        { jobId: "job-c", recordedAt: 1757412000, selection: INHERITED },
      ],
    });

    expect(records[0]?.recordedAt).toBe("2026-09-09T10:00:00.000Z");
    expect(records[1]?.recordedAt).toBeUndefined();
    expect(records[2]?.recordedAt).toBeUndefined();

    const notices = architectSelectionNotices({
      history: records,
      live: [],
      speaker: "Workflow Architect",
    });
    expect(notices[0]?.recordedAt).toBe("2026-09-09T10:00:00.000Z");
    expect(notices[1]?.recordedAt).toBeUndefined();
  });
});

describe("merging a live turn with its own record", () => {
  it("keeps the recorded time when the live record supersedes it", () => {
    // The normal same-visit path: the live entry outlives the turn's
    // completion, so once history loads both describe the same job. The live
    // one decides which pair is shown — but it has no timestamp of its own, and
    // replacing the record wholesale throws away the only time that turn has.
    const notices = architectSelectionNotices({
      history: [
        {
          jobId: "job-a",
          recordedAt: "2026-09-09T10:00:00.000Z",
          selection: INHERITED,
        },
      ],
      live: [{ jobId: "job-a", selection: INHERITED }],
      speaker: "Workflow Architect",
    });

    expect(notices).toEqual([
      {
        jobId: "job-a",
        speaker: "Workflow Architect",
        selection: INHERITED,
        recordedAt: "2026-09-09T10:00:00.000Z",
      },
    ]);
  });

  it("still lets the live record decide the pair", () => {
    const later = { ...INHERITED, model: "fake/replacement-default" } as const;
    const notices = architectSelectionNotices({
      history: [
        {
          jobId: "job-a",
          recordedAt: "2026-09-09T10:00:00.000Z",
          selection: INHERITED,
        },
      ],
      live: [{ jobId: "job-a", selection: later }],
      speaker: "Workflow Architect",
    });

    expect(notices[0]?.selection).toEqual(later);
    expect(notices[0]?.recordedAt).toBe("2026-09-09T10:00:00.000Z");
  });

  it("invents no time when neither record has one", () => {
    const notices = architectSelectionNotices({
      history: [{ jobId: "job-a", selection: INHERITED }],
      live: [{ jobId: "job-a", selection: INHERITED }],
      speaker: "Workflow Architect",
    });

    expect(notices[0]?.recordedAt).toBeUndefined();
  });
});
