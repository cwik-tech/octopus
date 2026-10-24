/**
 * What a run says about the model its own host process used.
 *
 * The host is a model use like any other, and it was the one that never said
 * so. A Team whose coordinator names no model runs its host on the application
 * default, and a level that declares no coordinator at all produces no agent
 * record — so this event is the only place that disclosure can come from.
 */
import { describe, expect, it } from "vitest";

import type { ModelSelectionRecord } from "@contracts/agent-model-selection";
import type { RunEvent } from "@/components/run/stage-renderers/index";
import { hostDefaultNotices } from "../host-default-notices";

const APP_DEFAULT: ModelSelectionRecord = {
  provider: "lm-studio",
  model: "loopback-b",
  source: "app-default",
  reason: "agent-default",
  caller: "agent",
};

const EXPLICIT: ModelSelectionRecord = {
  provider: "lm-studio",
  model: "loopback-b",
  source: "agent",
  reason: "explicit-agent-choice",
  caller: "agent",
};

function hostStart(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: "event-1",
    type: "host.agent_start",
    ts: 1,
    runId: "run-1",
    agentName: "reviewer",
    coordinatorRunId: 1,
    hostInstanceId: 'process-a',
    modelSelection: APP_DEFAULT,
    ...overrides,
  } as RunEvent;
}

describe("host default notices", () => {
  it("names the coordinator whose turn used the application default", () => {
    const notices = hostDefaultNotices([hostStart()])

    expect(notices).toHaveLength(1)
    expect(notices[0]?.speaker).toBe("reviewer")
    expect(notices[0]?.selection).toEqual(APP_DEFAULT);
  });

  it("says nothing when the host ran on a pair somebody chose", () => {
    // Even though this pair is identical to the default. An Agent that named
    // its own model made a choice, and calling that a fallback is false.
    expect(hostDefaultNotices([hostStart({ modelSelection: EXPLICIT })])).toEqual(
      [],
    );
  });

  it("reports one attempt once, however many times its events arrive", () => {
    // History is replayed on reload and re-delivered on reconnect. The same
    // attempt seen three times is still one thing that happened.
    const notices = hostDefaultNotices([
      hostStart({ id: "event-1" }),
      hostStart({ id: "event-2" }),
      hostStart({ id: "event-3" }),
    ]);

    expect(notices).toHaveLength(1);
  });

  it("reports two attempts separately even on the same pair", () => {
    const notices = hostDefaultNotices([
      hostStart({ id: "event-1", coordinatorRunId: 1, agentName: "lead" }),
      hostStart({ id: "event-2", coordinatorRunId: 2, agentName: "reviewer" }),
    ]);

    expect(notices.map((notice) => notice.speaker)).toEqual([
      "lead",
      "reviewer",
    ]);
  });

  it("speaks for a run whose level declares no coordinator", () => {
    // The case with no agent record at all, and therefore the one that most
    // needs this: without it the run discloses nothing about its own model.
    const coordinatorless = hostStart();
    delete coordinatorless.agentName;
    const notices = hostDefaultNotices([coordinatorless]);

    expect(notices).toHaveLength(1)
    expect(notices[0]?.speaker).toBe("This run's host")
    expect(notices[0]?.selection).toEqual(APP_DEFAULT);
  });

  it("ignores events that are not the host starting a turn", () => {
    const notices = hostDefaultNotices([
      hostStart({ type: "agent.start" } as Partial<RunEvent>),
      hostStart({ type: "host.agent_end" } as Partial<RunEvent>),
    ]);

    expect(notices).toEqual([]);
  });

  it("ignores a host event whose record could not be read", () => {
    const unreadable = hostStart();
    delete unreadable.modelSelection;
    expect(hostDefaultNotices([unreadable])).toEqual([]);
  });
});

describe("host attempts across processes", () => {
  it("keeps two host processes' first turns apart", () => {
    // The host's turn counter starts at 0 in every process
    // (`domains/runtime/runtime-context.ts`) and reaches 1 on that process's
    // first turn. A recovered run keeps its session id, so the pre-crash turn
    // and the recovered one both arrive as turn 1 of the same run — and a key
    // built from the run and the counter alone silently merges them, dropping
    // the disclosure for everything the recovered process did.
    const notices = hostDefaultNotices([
      hostStart({
        id: "event-1",
        agentName: "lead",
        coordinatorRunId: 1,
        hostInstanceId: "process-a",
      }),
      hostStart({
        id: "event-2",
        agentName: "reviewer",
        coordinatorRunId: 1,
        hostInstanceId: "process-b",
      }),
    ])

    expect(notices.map((notice) => notice.speaker)).toEqual([
      "lead",
      "reviewer",
    ])
  })

  it("still reports one turn once within a single host process", () => {
    const notices = hostDefaultNotices([
      hostStart({ id: "event-1", coordinatorRunId: 1, hostInstanceId: "process-a" }),
      hostStart({ id: "event-2", coordinatorRunId: 1, hostInstanceId: "process-a" }),
    ])

    expect(notices).toHaveLength(1)
  })

  it("keeps one coordinator's separate attempts apart", () => {
    // The same coordinator can take more than one turn. Two real turns are two
    // things that happened, and a reader has to be able to see both.
    const notices = hostDefaultNotices([
      hostStart({ id: "event-1", coordinatorRunId: 1, hostInstanceId: "process-a" }),
      hostStart({ id: "event-2", coordinatorRunId: 2, hostInstanceId: "process-a" }),
    ])

    expect(notices).toHaveLength(2)
  })
})
