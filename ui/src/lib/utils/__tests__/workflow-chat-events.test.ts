import { describe, expect, it } from "vitest";

import type { RunEvent } from "@/components/run/stage-renderers";
import {
  buildWorkflowChatMessages,
  findPendingWorkflowAgents,
  stripArtifactFrontmatter,
  type WorkflowTaskEventGroup,
} from "@/lib/utils/workflow-chat-events";

function event(
  id: string,
  type: RunEvent["type"],
  ts: number,
  overrides: Partial<RunEvent> = {},
): RunEvent {
  return { id, type, ts, ...overrides };
}

function group(
  taskId: string,
  taskRunId: string,
  events: RunEvent[],
  taskActive?: boolean,
): WorkflowTaskEventGroup {
  return { taskActive, taskId, taskRunId, events };
}

describe("workflow chat event projection", () => {
  it("keeps a child with incomplete artifacts visible until the workflow outcome arrives", () => {
    const pending = findPendingWorkflowAgents([{
      ...group("manual-task", "root", [
        event("start", "agent.start", 100, { agentName: "youtube-extractor", runId: "child" }),
        event("end", "agent.end", 200, { agentName: "youtube-extractor", runId: "child" }),
        event("incomplete", "run.incomplete", 250, { runId: "child" }),
        event("failed", "run.failed", 300, { runId: "root" }),
      ], false),
      taskStatus: "error",
    }], { retainUntilOutcome: true });

    expect(pending).toEqual([expect.objectContaining({ name: "youtube-extractor", activity: "finalizing-workflow" })]);
  });

  it.each(["awaiting_input", "awaiting_model_choice"] as const)("does not label a workflow waiting for %s as finishing", (taskStatus) => {
    const pending = findPendingWorkflowAgents([{
      ...group("manual-task", "root", [
        event("start", "agent.start", 100, { agentName: "youtube-extractor", runId: "child" }),
        event("end", "agent.end", 200, { agentName: "youtube-extractor", runId: "child" }),
      ], false),
      taskStatus,
    }], { retainUntilOutcome: true });

    expect(pending).toEqual([]);
  });

  it("keeps the completed workflow worker visible while the task outcome is loading", () => {
    const pending = findPendingWorkflowAgents([
      group("manual-task", "root", [
        event("start", "agent.start", 100, { agentName: "youtube-extractor", runId: "child" }),
        event("end", "agent.end", 200, { agentName: "youtube-extractor", runId: "child" }),
        event("failed", "run.failed", 300, { runId: "root" }),
      ], false),
    ], { retainUntilOutcome: true });
    expect(pending).toEqual([expect.objectContaining({ name: "youtube-extractor", activity: "finalizing-workflow", taskId: "manual-task", startedAt: 100 })]);
  });

  it("preserves coordinator selection activity on a pending Team agent", () => {
    const pending = findPendingWorkflowAgents([
      group("task", "root", [
        event("start", "agent.start", 1, {
          agentActivity: "selecting-team-members",
          agentId: "coordinator",
          agentName: "Coordinator",
        }),
      ]),
    ]);

    expect(pending).toEqual([
      expect.objectContaining({ activity: "selecting-team-members" }),
    ]);
  });

  it("projects valid discussion messages from every task in timestamp order", () => {
    const messages = buildWorkflowChatMessages([
      group("task-a", "run-a", [
        event("a2", "discussion.message", 200, {
          agentName: "Contrarian",
          content: "Second response",
        }),
      ]),
      group("task-b", "run-b", [
        event("b0", "agent.start", 50, {
          agentName: "Analyst",
          model: "gpt-5.4",
          provider: "openai",
        }),
        event("b1", "discussion.message", 100, {
          agentId: "analyst-id",
          agentName: "Analyst",
          content: "First response",
          messageType: "position",
          round: 1,
        }),
        event("ignored", "agent.end", 300, { agentName: "Analyst" }),
      ]),
    ]);

    expect(messages.map((message) => message.text)).toEqual([
      "First response",
      "Second response",
    ]);
    expect(messages[0]).toMatchObject({
      id: "workflow:task-b:b1",
      speaker: { id: "analyst-id", name: "Analyst", type: "agent" },
      workflow: {
        messageType: "position",
        model: "gpt-5.4",
        provider: "openai",
        round: 1,
        taskId: "task-b",
      },
    });
  });

  it("removes artifact frontmatter before a workflow message reaches chat", () => {
    const [message] = buildWorkflowChatMessages([
      group("task", "run", [
        event("brief", "discussion.message", 1, {
          agentName: "Problem Decomposer",
          content: [
            "---",
            'artifact_type: "brief"',
            'session_id: "previous-session"',
            "---",
            "# Routing Brief",
            "",
            "Evaluate the request.",
          ].join("\n"),
          messageType: "framing",
          round: 1,
        }),
      ]),
    ]);

    expect(message?.text).toBe("# Routing Brief\n\nEvaluate the request.");
    expect(message?.text).not.toContain("previous-session");
  });

  it("removes an internal run identifier from a visible agent response", () => {
    const [message] = buildWorkflowChatMessages([
      group("task", "root-run-id", [
        event("position", "discussion.message", 1, {
          agentName: "Market Analyst",
          content: [
            "The market is large enough to justify validation.",
            "",
            "**Session ID:** child-run-id",
          ].join("\n"),
          messageType: "position",
          round: 1,
          runId: "child-run-id",
        }),
      ]),
    ]);

    expect(message?.text).toBe(
      "The market is large enough to justify validation.",
    );
    expect(message?.text).not.toContain("child-run-id");
  });

  it("hides backend-only uploaded file context from framing messages", () => {
    const backendFramingContent = [
      "---",
      'artifact_type: "brief"',
      "---",
      "Evaluate the pitch deck as a venture-capital deal screen.",
      "",
      "# Task Brief",
      "",
      "## User Brief",
      "",
      "USER: discuss this deck",
      "",
      "## Uploaded File Context",
      "",
      "### DemoCo_-_Pitch_Deck.pdf",
      "",
      "- Parse status: parsed",
      "",
      "---",
      'source: "DemoCo_-_Pitch_Deck.pdf"',
      "pages: 13",
      "---",
      "",
      "# DemoCo_-_Pitch_Deck.pdf",
      "",
      "## Page 1",
      "",
      "Spraying-as-a-Service for Prefabricators",
    ].join("\n");
    const messages = buildWorkflowChatMessages([
      group("task", "run", [
        event("brief", "discussion.message", 1, {
          agentName: "Deal Evaluator",
          content: backendFramingContent,
          messageType: "framing",
          round: 1,
        }),
        event("analysis", "discussion.message", 2, {
          agentName: "Market Analyst",
          content: "## Uploaded File Context\n\nThis heading is part of the analysis.",
          messageType: "position",
          round: 1,
        }),
      ]),
    ]);

    expect(backendFramingContent).toContain('source: "DemoCo_-_Pitch_Deck.pdf"');
    expect(messages.map((message) => message.text)).toEqual([
      [
        "Evaluate the pitch deck as a venture-capital deal screen.",
        "",
        "# Task Brief",
        "",
        "## User Brief",
        "",
        "USER: discuss this deck",
      ].join("\n"),
      "## Uploaded File Context\n\nThis heading is part of the analysis.",
    ]);
  });

  it("keeps runtime provider metadata scoped to its workflow task", () => {
    const messages = buildWorkflowChatMessages([
      group("openai-task", "openai-run", [
        event("openai-start", "agent.start", 1, {
          agentName: "Analyst",
          provider: "openai",
        }),
        event("openai-message", "discussion.message", 2, {
          agentName: "Analyst",
          content: "OpenAI response",
        }),
      ]),
      group("anthropic-task", "anthropic-run", [
        event("anthropic-start", "agent.start", 3, {
          agentName: "Analyst",
          provider: "anthropic",
        }),
        event("anthropic-message", "discussion.message", 4, {
          agentName: "Analyst",
          content: "Anthropic response",
        }),
      ]),
    ]);

    expect(messages.map((message) => message.workflow.provider)).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("removes an empty artifact frontmatter block", () => {
    expect(stripArtifactFrontmatter("---\n---\nBody")).toBe("Body");
  });

  it("filters messages without an agent or non-empty response", () => {
    const messages = buildWorkflowChatMessages([
      group("task", "run", [
        event("system", "discussion.message", 1, { content: "System note" }),
        event("empty", "discussion.message", 2, {
          agentName: "Analyst",
          content: "   ",
        }),
      ]),
    ]);

    expect(messages).toEqual([]);
  });

  it("labels each attempt with the model that attempt ran on", () => {
    // The same Agent can speak twice in one task on different models — a
    // user-approved retry on the app default is exactly that. Joining by task
    // and agent name and keeping the newest value relabels the first reply
    // with the second attempt's model, which is a false record of what ran.
    const messages = buildWorkflowChatMessages([
      group("task", "root", [
        event("start-1", "agent.start", 1, {
          dispatchId: "dispatch-1",
          agentName: "Reviewer",
          model: "claude-opus-4-6",
          provider: "anthropic",
        }),
        event("say-1", "team.message", 2, {
          dispatchId: "dispatch-1",
          messageId: "m1",
          agentName: "Reviewer",
          content: "First answer",
        }),
        event("start-2", "agent.start", 3, {
          dispatchId: "dispatch-2",
          agentName: "Reviewer",
          model: "gpt-5.4-mini",
          provider: "connection:openai",
        }),
        event("say-2", "team.message", 4, {
          dispatchId: "dispatch-2",
          messageId: "m2",
          agentName: "Reviewer",
          content: "Second answer",
        }),
      ]),
    ]);

    expect(messages.map((message) => message.workflow.model)).toEqual([
      "claude-opus-4-6",
      "gpt-5.4-mini",
    ]);
    expect(messages.map((message) => message.workflow.provider)).toEqual([
      "anthropic",
      "connection:openai",
    ]);
  });

  it("reports no model for a dispatch that recorded none", () => {
    // Falling through to the agent-wide value here is how a second attempt's
    // model ends up on a message from a different attempt. A message whose own
    // dispatch recorded nothing has to say nothing.
    const messages = buildWorkflowChatMessages([
      group("task", "root", [
        event("start-1", "agent.start", 1, {
          dispatchId: "dispatch-1",
          agentName: "Reviewer",
          model: "claude-opus-4-6",
          provider: "anthropic",
        }),
        event("say-2", "team.message", 2, {
          dispatchId: "dispatch-2",
          messageId: "m2",
          agentName: "Reviewer",
          content: "Answer from an attempt with no recorded model",
        }),
      ]),
    ]);

    expect(messages[0]?.workflow.model).toBeUndefined();
    expect(messages[0]?.workflow.provider).toBeUndefined();
  });

  it("still labels a message from a run recorded before dispatch ids existed", () => {
    const messages = buildWorkflowChatMessages([
      group("task", "root", [
        event("start", "agent.start", 1, {
          agentName: "Reviewer",
          model: "claude-opus-4-6",
          provider: "anthropic",
        }),
        event("say", "team.message", 2, {
          messageId: "m1",
          agentName: "Reviewer",
          content: "Answer",
        }),
      ]),
    ]);

    expect(messages[0]?.workflow).toMatchObject({
      model: "claude-opus-4-6",
      provider: "anthropic",
    });
  });

  it("keeps repeated starts pending until matching completions arrive", () => {
    const pending = findPendingWorkflowAgents([
      group("task", "root", [
        event("start-1", "agent.start", 1, {
          runId: "child",
          stageName: "discussion",
          agentName: "Reviewer",
          model: "claude-sonnet-4-5",
          provider: "anthropic",
        }),
        event("start-2", "agent.start", 2, {
          runId: "child",
          stageName: "discussion",
          agentName: "Reviewer",
        }),
        event("end-2", "agent.end", 3, {
          runId: "child",
          stageName: "discussion",
          agentName: "Reviewer",
        }),
      ]),
    ]);

    expect(pending.map((agent) => agent.name)).toEqual(["Reviewer"]);
    expect(pending[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });
  });

  it("shows one pending Team agent after an input pause ends its first dispatch", () => {
    const pending = findPendingWorkflowAgents([
      group("task", "root", [
        event("first-start", "agent.start", 1, {
          runId: "child",
          stageName: "setup",
          agentName: "Furniture Designer",
          dispatchId: "first-dispatch",
        }),
        // The runtime's awaiting-input end has no level or stage fields.
        event("first-end", "agent.end", 2, {
          runId: "child",
          agentName: "Furniture Designer",
          dispatchId: "first-dispatch",
        }),
        event("resumed-start", "agent.start", 3, {
          runId: "child",
          stageName: "setup",
          agentName: "Furniture Designer",
          dispatchId: "resumed-dispatch",
        }),
      ], true),
    ]);

    expect(pending.map((agent) => agent.id)).toEqual(["task:resumed-start"]);
  });

  it("clears pending agents on failure, response, or root task termination", () => {
    const common = {
      runId: "root",
      stageName: "discussion",
      agentName: "Reviewer",
    };

    expect(findPendingWorkflowAgents([
      group("failed", "root", [
        event("start", "agent.start", 1, common),
        event("fail", "agent.fail", 2, common),
      ]),
      group("responded", "root-2", [
        event("start", "agent.start", 1, { ...common, runId: "root-2" }),
        event("message", "discussion.message", 2, {
          ...common,
          runId: "root-2",
          content: "Done",
        }),
      ]),
      group("terminal", "root-3", [
        event("start", "agent.start", 1, { ...common, runId: "child" }),
        event("done", "run.completed", 2, { runId: "root-3" }),
      ]),
    ])).toEqual([]);
  });

  it("keeps simultaneous agents from separate nested runs visible", () => {
    const pending = findPendingWorkflowAgents([
      group("task", "root", [
        event("one", "agent.start", 1, {
          runId: "child-a",
          agentName: "Researcher",
        }),
        event("two", "agent.start", 2, {
          runId: "child-b",
          agentName: "Critic",
        }),
      ]),
    ]);

    expect(pending.map((agent) => agent.name)).toEqual([
      "Researcher",
      "Critic",
    ]);
  });

  it("clears only the matching nested run when that run terminates", () => {
    const pending = findPendingWorkflowAgents([
      group("task", "root", [
        event("one", "agent.start", 1, {
          runId: "child-a",
          agentName: "Researcher",
        }),
        event("two", "agent.start", 2, {
          runId: "child-b",
          agentName: "Critic",
        }),
        event("child-done", "run.failed", 3, { runId: "child-a" }),
      ]),
    ]);

    expect(pending.map((agent) => agent.name)).toEqual(["Critic"]);
  });

  it("clears pending agents when the authoritative task state is no longer active", () => {
    const pending = findPendingWorkflowAgents([
      group("task", "root", [
        event("start", "agent.start", 1, {
          runId: "child",
          agentName: "Domain Researcher",
        }),
      ], false),
    ]);

    expect(pending).toEqual([]);
  });
  it("projects a durable Team message from any engine mode", () => {
    const messages = buildWorkflowChatMessages([
      group("task", "run", [
        event("chain-one", "team.message", 100, {
          agentName: "line-one",
          content: "Phased rollout recommended.",
          messageId: "run#call#1#line-one",
          messageType: "position",
        }),
        event("chain-two", "team.message", 200, {
          agentName: "line-two",
          content: "Supplier contingency added.",
          messageId: "run#call#1#line-two",
          messageType: "position",
        }),
      ]),
    ]);

    expect(messages.map((message) => message.speaker?.name)).toEqual([
      "line-one",
      "line-two",
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      "Phased rollout recommended.",
      "Supplier contingency added.",
    ]);
  });

  it("shows one bubble when a durable message is delivered twice", () => {
    const messages = buildWorkflowChatMessages([
      group("task", "run", [
        event("snapshot", "team.message", 100, {
          agentName: "line-one",
          content: "Phased rollout recommended.",
          messageId: "run#call#1#line-one",
        }),
        event("stream", "team.message", 100, {
          agentName: "line-one",
          content: "Phased rollout recommended.",
          messageId: "run#call#1#line-one",
        }),
      ]),
    ]);

    expect(messages).toHaveLength(1);
  });

  it("keeps legacy discussion messages rendering beside Team messages", () => {
    const messages = buildWorkflowChatMessages([
      group("task", "run", [
        event("legacy", "discussion.message", 100, {
          agentName: "Contrarian",
          content: "The proposal needs stronger evidence.",
        }),
        event("current", "team.message", 200, {
          agentName: "line-one",
          content: "Phased rollout recommended.",
          messageId: "run#call#1#line-one",
        }),
      ]),
    ]);

    expect(messages.map((message) => message.speaker?.name)).toEqual([
      "Contrarian",
      "line-one",
    ]);
  });

  it("stops showing an agent as pending once its durable Team message arrives", () => {
    const common = { agentId: "line-one", agentName: "line-one", runId: "run" };

    expect(findPendingWorkflowAgents([
      group("task", "run", [
        event("start", "agent.start", 1, common),
        event("message", "team.message", 2, {
          ...common,
          content: "Phased rollout recommended.",
          messageId: "run#call#1#line-one",
        }),
      ]),
    ])).toEqual([]);
  });

  it("shows a safe Team startup failure without exposing the raw error", () => {
    const rawError = [
      "Host provider 'claude' is not supported.",
      "Child stderr: token=secret-value",
      "Assignment: /Users/example/private/run",
    ].join("\n");
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("failed", "run.failed", 1, {
          errorMessage: rawError,
          runId: "team-run",
        }),
      ],
    };

    const messages = buildWorkflowChatMessages([teamChatGroup]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      speaker: {
        id: "team-runtime",
        name: "Team runtime",
        type: "assistant",
      },
      text:
        "The Team could not start. Its configuration or provider setup needs attention before you try again.",
      workflow: { messageType: "error" },
    });
    expect(messages[0]?.text).not.toContain("secret-value");
    expect(messages[0]?.text).not.toContain("/Users/example/private/run");
  });

  it("reports a Team that published a durable message as stopped rather than never started", () => {
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("answer", "team.message", 1, {
          agentName: "Analyst",
          content: "The first finding survived.",
          messageId: "team-run#analyst#1",
          runId: "team-run",
        }),
        event("failed", "run.failed", 2, { runId: "team-run" }),
      ],
    };

    expect(
      buildWorkflowChatMessages([teamChatGroup]).map((message) => message.text),
    ).toEqual([
      "The first finding survived.",
      "The Team stopped before it could complete this response. Check the run details before you try again.",
    ]);
  });

  it("shows a safe status when the root Team run becomes blocked", () => {
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("blocked", "run.blocked", 1, {
          errorMessage: "Sensitive provider details",
          runId: "team-run",
        }),
      ],
    };

    expect(buildWorkflowChatMessages([teamChatGroup])).toMatchObject([
      {
        text:
          "The Team is blocked and could not complete this response. Resolve the blocked run before you try again.",
        workflow: { messageType: "error" },
      },
    ]);
  });

  it("says a review ran out of rounds, and that a new run is the way on", () => {
    // "Resolve the blocked run before you try again" describes something the
    // user can do. A review that used up its rounds is not that: nothing is
    // waiting for them, and the only thing that moves it on is a new run. The
    // raw error stays unusable here, so this is carried as a checked cause.
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("blocked", "run.blocked", 1, {
          errorMessage:
            "Child stage blocked after 1/1 review iterations. Assignment: /Users/example/private/run",
          blockedCause: "review_exhausted",
          runId: "team-run",
        }),
      ],
    };

    const [message] = buildWorkflowChatMessages([teamChatGroup]);

    expect(message?.text).toBe(
      "The reviewer did not approve this within the rounds the Team allows, " +
        "so nothing was published. Nothing is waiting for you — start a new run to try again.",
    );
    expect(message?.text).not.toContain("/Users/example/private/run");
  });

  // A provider that ran out is why the review never got anywhere, so it is
  // still said first.
  it("keeps the provider failure in front of the review outcome", () => {
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("agent-failed", "agent.fail", 1, {
          agentName: "Clause Checker",
          providerFailureKind: "usage_limit",
          runId: "child-run",
        }),
        event("blocked", "run.blocked", 2, {
          blockedCause: "review_exhausted",
          runId: "team-run",
        }),
      ],
    };

    const [message] = buildWorkflowChatMessages([teamChatGroup]);

    expect(message?.text).toBe(
      "You've hit your provider usage limit. Try again after it resets. " +
        "The reviewer did not approve this within the rounds the Team allows, " +
        "so nothing was published. Nothing is waiting for you — start a new run to try again.",
    );
  });

  it("names the provider failure that blocked the run without echoing the raw error", () => {
    // The session this came from: a Codex quota exhausted until a stated reset.
    // The chat said only that the Team was blocked, which told the operator
    // nothing they could act on, and the raw error stays unusable here because
    // it carries the child's stderr and its assignment path.
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("agent-failed", "agent.fail", 1, {
          agentName: "Youtube Extractor",
          errorMessage:
            "Parent worker turn failed.\nChild stderr: token=secret-value\nAssignment: /Users/example/private/run",
          providerFailureKind: "usage_limit",
          runId: "child-run",
        }),
        event("blocked", "run.blocked", 2, { runId: "team-run" }),
      ],
    };

    const [message] = buildWorkflowChatMessages([teamChatGroup]);

    expect(message?.text).toBe(
      "You've hit your provider usage limit. Try again after it resets. " +
        "The Team is blocked and could not complete this response. " +
        "Resolve the blocked run before you try again.",
    );
    expect(message?.text).not.toContain("secret-value");
    expect(message?.text).not.toContain("/Users/example/private/run");
  });

  it("keeps the bare status when no agent recorded a provider failure kind", () => {
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("agent-failed", "agent.fail", 1, {
          agentName: "Youtube Extractor",
          errorMessage: "Child stderr: token=secret-value",
          runId: "child-run",
        }),
        event("blocked", "run.blocked", 2, { runId: "team-run" }),
      ],
    };

    expect(buildWorkflowChatMessages([teamChatGroup])[0]?.text).toBe(
      "The Team is blocked and could not complete this response. Resolve the blocked run before you try again.",
    );
  });

  it("does not show workflow failures or child-run failures in Team chat", () => {
    const workflowGroup = group("workflow-task", "workflow-run", [
      event("workflow-failed", "run.failed", 1, { runId: "workflow-run" }),
    ]);
    const teamChatGroup: WorkflowTaskEventGroup & {
      targetKind: "team-chat";
    } = {
      taskActive: false,
      taskId: "team-task",
      taskRunId: "team-run",
      targetKind: "team-chat",
      events: [
        event("child-failed", "run.failed", 2, { runId: "child-run" }),
      ],
    };

    expect(buildWorkflowChatMessages([workflowGroup, teamChatGroup])).toEqual(
      [],
    );
  });
});
