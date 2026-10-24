import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  toRunEvent,
  toSnapshotRunEvent,
} from "@/components/run/tasks/task-run-model";
import { useTaskRunStore } from "@/components/run/tasks/use-task-run-store";
import type { EngineEventEnvelope } from "@/lib/models/runtime-model";
import { findPendingWorkflowAgents } from "@/lib/utils/workflow-chat-events";

function agentStartEnvelope(overrides: Partial<EngineEventEnvelope> = {}): EngineEventEnvelope {
  return {
    schema_version: 1,
    timestamp: "2026-08-06T13:50:16.196Z",
    tenant_id: "local",
    category: "agent",
    type: "agent.start",
    run_id: "child-run",
    root_run_id: "root-run",
    team: "venture-capital-team",
    level_id: "deliberation",
    stage_type: "discussion",
    payload: {
      agent_name: "vc-founder-assessor",
      model: "gpt-5.4-mini",
      provider: "codex",
      round: 1,
    },
    ...overrides,
  };
}

describe("useTaskRunStore", () => {
  it("keeps one pending agent when SSE replays the snapshot envelope under another cursor ID", () => {
    const { result } = renderHook(() => useTaskRunStore());
    const source = agentStartEnvelope();

    act(() => {
      result.current.replaceTaskEvents({
        task: [toSnapshotRunEvent(source, 12)],
      });
      result.current.appendTaskEvent(
        "task",
        toRunEvent("13", structuredClone(source)),
      );
    });

    expect(result.current.taskEvents.task).toHaveLength(1);
    expect(findPendingWorkflowAgents([{
      taskActive: true,
      taskId: "task",
      taskRunId: "root-run",
      events: result.current.taskEvents.task ?? [],
    }]).map((agent) => agent.name)).toEqual(["vc-founder-assessor"]);
  });

  it("keeps the same agent's distinct discussion-round events", () => {
    const { result } = renderHook(() => useTaskRunStore());
    const firstRound = agentStartEnvelope();
    const secondRound = agentStartEnvelope({
      timestamp: "2026-08-06T13:53:49.973Z",
      payload: {
        ...firstRound.payload,
        round: 2,
      },
    });

    act(() => {
      result.current.appendTaskEvent("task", toRunEvent("12", firstRound));
      result.current.appendTaskEvent("task", toRunEvent("13", secondRound));
    });

    expect(result.current.taskEvents.task).toHaveLength(2);
  });
});
