import { describe, expect, it } from "vitest";

import {
  emptyChatTarget,
  selectChatAgents,
  selectChatTeam,
  showsTeamRunWorkspace,
  toSessionMessageTarget,
  discussionWorkspacePresentation,
  pendingWorkflowTarget,
  showsWorkflowLaunchConfirmation,
} from "@/components/run/chat/chat-target";

describe("chat target selection", () => {
  it("starts with nothing selected", () => {
    expect(emptyChatTarget()).toEqual({ agentNames: [], teamId: null });
  });

  it("selecting a team clears selected agents", () => {
    const current = { agentNames: ["pragmatist", "quick-scout"], teamId: null };
    expect(selectChatTeam(current, "problem-thinking-board")).toEqual({
      agentNames: [],
      teamId: "problem-thinking-board",
    });
  });

  it("selecting agents clears the selected team", () => {
    const current = { agentNames: [], teamId: "problem-thinking-board" };
    expect(selectChatAgents(current, ["pragmatist"])).toEqual({
      agentNames: ["pragmatist"],
      teamId: null,
    });
  });

  it("clearing the team leaves agents empty rather than restoring them", () => {
    const current = { agentNames: [], teamId: "writing-team" };
    expect(selectChatTeam(current, null)).toEqual({
      agentNames: [],
      teamId: null,
    });
  });

  it("does not mutate the previous selection", () => {
    const current = { agentNames: ["pragmatist"], teamId: null };
    selectChatTeam(current, "writing-team");
    expect(current).toEqual({ agentNames: ["pragmatist"], teamId: null });
  });
});

describe("team run workspace visibility", () => {
  it("shows while a Team is the explicit target", () => {
    expect(
      showsTeamRunWorkspace({ teamId: "problem-thinking-board" }),
    ).toBe(true);
  });

  it("shows for a session whose latest task is a Team run", () => {
    expect(
      showsTeamRunWorkspace({ teamId: null, hasTeamChatTask: true }),
    ).toBe(true);
  });

  it("shows for a session running a user-selected Workflow", () => {
    expect(
      showsTeamRunWorkspace({
        teamId: null,
        hasWorkflowRun: true,
      }),
    ).toBe(true);
  });

  it("stays hidden for an ordinary Coordinator conversation", () => {
    expect(
      showsTeamRunWorkspace({
        teamId: null,
        hasTeamChatTask: false,
        hasWorkflowRun: false,
      }),
    ).toBe(false);
  });
});

describe("discussion workspace presentation", () => {
  it("presents a Team target as a team chat", () => {
    expect(
      discussionWorkspacePresentation({ teamId: "writing-team" }),
    ).toBe("team-chat");
  });

  it("presents a persisted Team task as a team chat", () => {
    expect(
      discussionWorkspacePresentation({ teamId: null, hasTeamChatTask: true }),
    ).toBe("team-chat");
  });

  it("presents everything else as a workflow", () => {
    expect(
      discussionWorkspacePresentation({ teamId: null, hasTeamChatTask: false }),
    ).toBe("workflow");
  });
});

describe("workflow launch confirmation visibility", () => {
  const READY = {
    hasTasks: false,
    isLaunchReady: true,
    activeWorkflowId: "writing-workflow",
    selectedWorkflowId: "writing-workflow",
    selectionSource: "user" as const,
  };

  it("offers Begin for a ready plan the user selected", () => {
    expect(showsWorkflowLaunchConfirmation(READY)).toBe(true);
  });

  it("never offers Begin for a workflow the Coordinator only recommended", () => {
    expect(
      showsWorkflowLaunchConfirmation({
        ...READY,
        selectionSource: "coordinator",
      }),
    ).toBe(false);
  });

  it("never offers Begin for a legacy plan with no recorded provenance", () => {
    expect(
      showsWorkflowLaunchConfirmation({ ...READY, selectionSource: undefined }),
    ).toBe(false);
  });

  it("never offers Begin for a plan that is not ready", () => {
    expect(
      showsWorkflowLaunchConfirmation({ ...READY, isLaunchReady: false }),
    ).toBe(false);
  });

  it("never offers Begin once a task has consumed the plan", () => {
    expect(showsWorkflowLaunchConfirmation({ ...READY, hasTasks: true })).toBe(
      false,
    );
  });

  it("never offers Begin when the ready plan names a different workflow", () => {
    expect(
      showsWorkflowLaunchConfirmation({
        ...READY,
        selectedWorkflowId: "some-other-workflow",
      }),
    ).toBe(false);
  });

  it("offers Begin for a workflow picked by hand before any plan exists", () => {
    // The picker is the user speaking too. With no plan there is no recorded
    // provenance to consult, and the only way a workflow becomes active here
    // is that the user chose it.
    expect(
      showsWorkflowLaunchConfirmation({
        ...READY,
        selectedWorkflowId: null,
        selectionSource: undefined,
      }),
    ).toBe(true);
  });

  it("never offers Begin with no active workflow to launch", () => {
    expect(
      showsWorkflowLaunchConfirmation({ ...READY, activeWorkflowId: null }),
    ).toBe(false);
  });
});

describe("picker selection as a dispatch target", () => {
  it("addresses nobody when nothing is picked", () => {
    expect(toSessionMessageTarget(emptyChatTarget())).toBeUndefined();
  });

  it("addresses the picked agents", () => {
    expect(
      toSessionMessageTarget({ agentNames: ["analyst", "writer"], teamId: null }),
    ).toEqual({ kind: "agents", agentNames: ["analyst", "writer"] });
  });

  it("addresses the picked team", () => {
    expect(
      toSessionMessageTarget({ agentNames: [], teamId: "writing-team" }),
    ).toEqual({ kind: "team", teamId: "writing-team" });
  });

  it("prefers the team when both are somehow present", () => {
    expect(
      toSessionMessageTarget({ agentNames: ["analyst"], teamId: "writing-team" }),
    ).toEqual({ kind: "team", teamId: "writing-team" });
  });
});

describe("a Workflow picked before the plan exists", () => {
  const PICKED = {
    manualWorkflowId: "discussion-to-writing3",
    planId: null,
    planWorkflowId: null,
    planSelectionSource: undefined,
  };

  it("travels with the next message as a null-expectation Workflow target", () => {
    // Selection cannot be persisted before a plan exists, so the choice would
    // otherwise be lost the moment the user speaks again.
    expect(pendingWorkflowTarget(PICKED)).toEqual({
      kind: "workflow",
      workflowId: "discussion-to-writing3",
      expectedPlanId: null,
    });
  });

  it("carries the current plan id once one exists", () => {
    expect(
      pendingWorkflowTarget({ ...PICKED, planId: "run-plan-4" }),
    ).toEqual({
      kind: "workflow",
      workflowId: "discussion-to-writing3",
      expectedPlanId: "run-plan-4",
    });
  });

  it("stops travelling once the plan records it as the user's own choice", () => {
    expect(
      pendingWorkflowTarget({
        ...PICKED,
        planId: "run-plan-4",
        planWorkflowId: "discussion-to-writing3",
        planSelectionSource: "user",
      }),
    ).toBeUndefined();
  });

  it("still travels when the plan names it as a Coordinator recommendation", () => {
    // A recommendation is not the user's choice, so picking it is still an act
    // the next turn has to carry.
    expect(
      pendingWorkflowTarget({
        ...PICKED,
        planId: "run-plan-4",
        planWorkflowId: "discussion-to-writing3",
        planSelectionSource: "coordinator",
      }),
    ).toEqual({
      kind: "workflow",
      workflowId: "discussion-to-writing3",
      expectedPlanId: "run-plan-4",
    });
  });

  it("never promotes a Workflow the user did not pick", () => {
    expect(
      pendingWorkflowTarget({
        manualWorkflowId: null,
        planId: "run-plan-4",
        planWorkflowId: "deep-research-report",
        planSelectionSource: "coordinator",
      }),
    ).toBeUndefined();
  });
});

describe("a Workflow pick that is already being persisted", () => {
  it("does not also ride along on the next message", () => {
    // The picker's own PUT and a message target would compare-and-set the same
    // plan against the same expectation, so one of them loses and the user
    // sees a conflict for something they did once.
    expect(
      pendingWorkflowTarget({
        manualWorkflowId: "discussion-to-writing3",
        planId: "run-plan-4",
        planWorkflowId: "deep-research-report",
        planSelectionSource: "coordinator",
        isPersisting: true,
      }),
    ).toBeUndefined();
  });

  it("still rides along when nothing is being persisted", () => {
    // Picking before the first plan starts no request at all, so there is
    // nothing to race and the choice must still reach the turn.
    expect(
      pendingWorkflowTarget({
        manualWorkflowId: "discussion-to-writing3",
        planId: null,
        planWorkflowId: null,
        planSelectionSource: undefined,
        isPersisting: false,
      }),
    ).toEqual({
      kind: "workflow",
      workflowId: "discussion-to-writing3",
      expectedPlanId: null,
    });
  });
});
