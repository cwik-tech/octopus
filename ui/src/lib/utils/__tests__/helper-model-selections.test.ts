/**
 * What counts as a record of a model one of the application's own helpers used.
 *
 * Three of them: naming a delegated job, compressing a discussion and writing a
 * run's minutes. Each writes its account before it asks anything and each
 * reaches the conversation as an ordinary run event. Three things have to be
 * true of the reading: it must pick out those facts rather than any selection
 * that happens to travel beside them, it must say *which* helper it was, and it
 * must survive a stored time that is not a time — those arrive as strings and
 * nothing validates them as dates.
 */
import { describe, expect, it } from "vitest";

import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { RunEvent } from "@/components/run/stage-renderers";
import {
  HELPER_MODEL_SELECTED_EVENT,
  JOB_TITLE_SELECTED_EVENT,
  collectHelperModelSelections,
} from "@/lib/utils/helper-model-selections";

const SELECTION: ModelSelectionRecord = {
  provider: "openai",
  model: "app-default-model",
  source: "app-default",
  reason: "agent-default",
  caller: "title",
};

function event(overrides: Partial<RunEvent>): RunEvent {
  return {
    id: "event-1",
    type: JOB_TITLE_SELECTED_EVENT,
    ts: Date.parse("2026-09-09T10:00:00.000Z"),
    delegationId: "parent:research-team:abc",
    modelSelection: SELECTION,
    ...overrides,
  };
}

function helperEvent(overrides: Partial<RunEvent>): RunEvent {
  return {
    id: "helper-1",
    type: HELPER_MODEL_SELECTED_EVENT,
    ts: Date.parse("2026-09-09T10:00:00.000Z"),
    helper: "compression",
    modelSelection: { ...SELECTION, caller: "compression" },
    ...overrides,
  };
}

describe("collectHelperModelSelections", () => {
  it("reads the naming a delegation recorded", () => {
    expect(collectHelperModelSelections([{ events: [event({})] }])).toEqual([
      {
        // Namespaced by kind: one set deduplicates every notice, and a
        // delegation id must not be able to equal a helper's task-and-event key.
        key: "job-title:parent:research-team:abc",
        speaker: "job title",
        selection: SELECTION,
        at: "2026-09-09T10:00:00.000Z",
      },
    ]);
  });

  it("reads what a run's own background helpers ran on, and names each one", () => {
    // Told apart, not lumped together. "A helper used the app default" leaves a
    // person no way to know what work that model actually did.
    expect(
      collectHelperModelSelections([
        {
          events: [
            helperEvent({}),
            helperEvent({
              id: "helper-2",
              helper: "minutes",
              modelSelection: { ...SELECTION, caller: "minutes" },
            }),
          ],
        },
      ]).map(({ speaker }) => speaker),
    ).toEqual(["context compression", "meeting minutes"]);
  });

  it("reports every helper turn a run took, not only its first", () => {
    // A long discussion is compressed more than once. Keying by the helper
    // rather than by the turn would report one model use where there were two.
    expect(
      collectHelperModelSelections([
        { events: [helperEvent({}), helperEvent({ id: "helper-2" })] },
      ]),
    ).toHaveLength(2);
  });

  it("tells apart the same event id in two different runs", () => {
    // Event ids are per stream: a second run starts numbering again, so two
    // unrelated helper turns can both be `12`. Keyed by the id alone they
    // collapse into one notice, and the run that came second is reported as
    // having used no model at all.
    const collected = collectHelperModelSelections([
      { taskId: "task-a", events: [helperEvent({ id: "12" })] },
      { taskId: "task-b", events: [helperEvent({ id: "12" })] },
    ]);

    // Distinct keys, because the key is what the conversation deduplicates on.
    // Two entries that share one are one notice by the time a person sees them.
    expect(new Set(collected.map((one) => one.key)).size).toBe(2);
  });

  it("does not read a speaker off the prototype", () => {
    // `helper` comes off the wire. An inherited key such as `constructor`
    // resolves to a function on a plain object literal, which is not a name —
    // and the notice's own display helper throws on it, inside the
    // conversation it was meant to appear in.
    for (const helper of ["constructor", "toString", "__proto__", "valueOf"]) {
      expect(
        collectHelperModelSelections([{ events: [helperEvent({ helper })] }]),
      ).toEqual([]);
    }
  });

  it("ignores a helper record it has no name for", () => {
    // An event naming a helper this build does not know about describes work
    // this reader cannot explain, and an unexplained notice is worse than none.
    expect(
      collectHelperModelSelections([
        { events: [helperEvent({ helper: "something-else" })] },
      ]),
    ).toEqual([]);
  });

  it("ignores a selection that merely travels beside a delegation", () => {
    // An agent's own turn, and a host's own lifecycle, can both carry a
    // selection and a delegation id. Neither of them named the job, and
    // reporting one as though it had would say a model named something it did
    // not.
    expect(
      collectHelperModelSelections([
        {
          events: [
            event({ type: "agent.start" }),
            event({ type: "delegation.event" }),
            event({ type: "run.host_started" }),
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("keeps a naming whose stored time is not a time", () => {
    // `ts` comes from a string nothing validates as a date. Converting it
    // blindly throws, and the throw lands inside the conversation the notice
    // was meant to appear in.
    const collected = collectHelperModelSelections([
      { events: [event({ ts: Number.NaN })] },
    ]);

    expect(collected).toHaveLength(1);
    expect(collected[0]?.at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("reads namings from every task group, not only the newest", () => {
    // A conversation that ran more than one task still has to account for what
    // each of them delegated.
    expect(
      collectHelperModelSelections([
        { events: [event({ delegationId: "first" })] },
        { events: [event({ delegationId: "second" })] },
      ]).map((naming) => naming.key),
    ).toEqual(["job-title:first", "job-title:second"]);
  });

  it("keeps two runs' helper turns apart when neither group names a task", () => {
    // The task is what scopes a helper's event id, and it is optional. Falling
    // back to a shared empty string would put two runs in one namespace, so the
    // second run's turn would be dropped as a repeat of the first's — which is
    // the failure the key exists to prevent, reintroduced by its own fallback.
    const collected = collectHelperModelSelections([
      { events: [helperEvent({ id: "1", runId: "run-a" })] },
      { events: [helperEvent({ id: "1", runId: "run-b" })] },
    ]);

    expect(collected).toHaveLength(2);
    expect(new Set(collected.map((one) => one.key)).size).toBe(2);
  });
});
