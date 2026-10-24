/**
 * What a Team run event tells the UI about the model an agent was admitted on.
 *
 * Decoded from the run's own `agent.start` payload, which is written before
 * the provider is called, so the disclosure is available while the agent is
 * still working. Validated rather than asserted: a partially readable record
 * would let the run claim something it never recorded.
 */
import { describe, expect, it } from "vitest";

import type { EngineEventEnvelope } from "@contracts/runtime-events";
import { toRunEvent } from "../task-run-model";

function startEnvelope(
  payload: Record<string, unknown>,
): EngineEventEnvelope {
  return {
    schema_version: 1,
    timestamp: "2026-09-05T10:00:00.000Z",
    tenant_id: "local",
    category: "agent",
    type: "agent.start",
    run_id: "run-1",
    payload: {
      agent_name: "reviewer",
      provider: "connection:abc",
      model: "gpt-5.4-mini",
      ...payload,
    },
  };
}

describe("task run model selection", () => {
  it("carries the recorded selection through to the UI event", () => {
    const event = toRunEvent(
      "event-1",
      startEnvelope({
        model_selection: {
          provider: "connection:abc",
          model: "gpt-5.4-mini",
          source: "app-default",
          reason: "agent-default",
          caller: "agent",
        },
      }),
    );

    expect(event.modelSelection).toEqual({
      provider: "connection:abc",
      model: "gpt-5.4-mini",
      source: "app-default",
      reason: "agent-default",
      caller: "agent",
    });
  });

  it("reports no selection for a run recorded before provenance existed", () => {
    const event = toRunEvent(
      "event-1",
      startEnvelope({}),
    );

    expect(event.modelSelection).toBeUndefined();
  });

  it("refuses a selection it cannot fully read", () => {
    const event = toRunEvent(
      "event-1",
      startEnvelope({
        model_selection: { provider: "connection:abc", source: "app-default" },
      }),
    );

    expect(event.modelSelection).toBeUndefined();
  });

  it("refuses a selection whose displaced pair is present but unreadable", () => {
    // Both halves invalid is the case a symmetry check alone lets through. The
    // record would then render as an approved retry that displaced nothing,
    // which is a claim no execution made.
    const event = toRunEvent(
      "event-1",
      startEnvelope({
        model_selection: {
          provider: "connection:abc",
          model: "gpt-5.6-sol",
          source: "app-default",
          reason: "user-approved-retry",
          caller: "agent",
          requestedProvider: 42,
          requestedModel: null,
        },
      }),
    );

    expect(event.modelSelection).toBeUndefined();
  });
});

// ── The host's own disclosure ───────────────────────────────────────────────

function hostStartEnvelope(
  payload: Record<string, unknown>,
): EngineEventEnvelope {
  return {
    schema_version: 1,
    timestamp: "2026-09-05T10:00:00.000Z",
    tenant_id: "local",
    category: "runtime",
    type: "host.agent_start",
    run_id: "run-1",
    payload: {
      coordinator: "reviewer",
      host_provider: "lm-studio",
      host_model: "loopback-b",
      ...payload,
    },
  };
}

describe("host model selection", () => {
  it("carries the host's recorded selection through to the UI event", () => {
    // A host lifecycle event names its field `host_model_selection`, because a
    // host record is about the process rather than about one agent's turn. It
    // is the same validated record, and it is the only disclosure a run with no
    // coordinator produces at all.
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({
        host_model_selection: {
          provider: "lm-studio",
          model: "loopback-b",
          source: "app-default",
          reason: "agent-default",
          caller: "agent",
        },
      }),
    );

    expect(event.modelSelection).toEqual({
      provider: "lm-studio",
      model: "loopback-b",
      source: "app-default",
      reason: "agent-default",
      caller: "agent",
    });
  });

  it("carries the host turn's own identity, so one attempt is one attempt", () => {
    // Without this the UI has no way to tell two events about one host turn
    // from two turns, and every replay of a run's history would look like more
    // work than actually happened.
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({ coordinator_run_id: 3 }),
    );

    expect(event.coordinatorRunId).toBe(3);
  });

  it("names the coordinator whose turn the host was running", () => {
    // A host event identifies its coordinator in `coordinator`; only an agent
    // event uses `agent_name`. Without this every host disclosure is attributed
    // to the run rather than to the coordinator that actually inherited the
    // default, which is the one thing a person needs it to say.
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({ coordinator: "auditor" }),
    );

    expect(event.agentName).toBe("auditor");
  });

  it("speaks for the run itself when a host turn has no coordinator", () => {
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({ coordinator: null }),
    );

    expect(event.agentName).toBeUndefined();
  });

  it("carries the host process's own identity", () => {
    // The turn counter restarts at 0 in every host process, so it alone cannot
    // tell a turn before a crash from the first turn after one.
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({ host_instance_id: "process-a" }),
    );

    expect(event.hostInstanceId).toBe("process-a");
  });

  it("refuses a host record it cannot read whole", () => {
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({
        host_model_selection: { provider: "lm-studio", model: "loopback-b" },
      }),
    );

    expect(event.modelSelection).toBeUndefined();
  });

  it("prefers an agent's own record where an event carries both", () => {
    // A host event about a coordinator turn can carry both. The agent record
    // describes the turn; the host record describes the process it ran in.
    const event = toRunEvent(
      "event-1",
      hostStartEnvelope({
        model_selection: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          source: "agent",
          reason: "explicit-agent-choice",
          caller: "agent",
        },
        host_model_selection: {
          provider: "lm-studio",
          model: "loopback-b",
          source: "app-default",
          reason: "agent-default",
          caller: "agent",
        },
      }),
    );

    expect(event.modelSelection?.model).toBe("claude-haiku-4-5");
  });
});
