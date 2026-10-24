import test from "node:test";
import assert from "node:assert/strict";

import { projectResultReferences } from "../../domains/sessions/result-reference-projection.js";
import type { ChatMessage, SessionTask } from "../../contracts/sessions.js";

/**
 * A chat-only Team is the case this exists for. It reaches `done` having
 * published no artifact and no delivery card, so every reader that looked for
 * one found nothing and reported that the run produced nothing.
 */

const SESSION = "session-1";

function task(overrides: Partial<SessionTask> & { id: string }): SessionTask {
  return {
    sessionId: SESSION,
    runId: `run-${overrides.id}`,
    workflowId: "discussion-to-writing3",
    brief: "Decompose the launch decision.",
    status: "done",
    createdAt: "2026-09-09T09:00:00.000Z",
    completedAt: "2026-09-09T10:00:00.000Z",
    cwd: "/tmp/run",
    ...overrides,
  };
}

function deliveryMessage(taskId: string, path: string): ChatMessage {
  return {
    id: `delivery-${taskId}`,
    role: "assistant",
    text: "Done.",
    createdAt: "2026-09-09T10:00:01.000Z",
    delivery: {
      taskId,
      artifacts: [{ runId: `run-${taskId}`, path, role: "final" }],
    },
  };
}

test("a chat-only Team points at its run, not at an invented artifact", () => {
  const [reference] = projectResultReferences({
    sessionId: SESSION,
    tasks: [
      task({
        id: "task-1",
        teamId: "problem-thinking-board",
        workflowId: "chat-team-problem-thinking-board",
      }),
    ],
    messages: [],
  });

  assert.ok(reference);
  assert.deepEqual(reference.producer, {
    kind: "team",
    id: "problem-thinking-board",
    label: "problem-thinking-board",
  });
  assert.deepEqual(reference.source, {
    kind: "run-summary",
    runId: "run-task-1",
  });
  assert.equal(reference.artifacts, undefined);
});

test("an artifact-producing Workflow points at its primary artifact", () => {
  const [reference] = projectResultReferences({
    sessionId: SESSION,
    tasks: [task({ id: "task-1" })],
    messages: [deliveryMessage("task-1", "output/final-draft.md")],
  });

  assert.ok(reference);
  assert.equal(reference.producer.kind, "workflow");
  assert.deepEqual(reference.source, {
    kind: "artifact",
    runId: "run-task-1",
    path: "output/final-draft.md",
  });
  assert.equal(reference.artifacts?.length, 1);
});

test("a run that has not finished implies no result", () => {
  assert.deepEqual(
    projectResultReferences({
      sessionId: SESSION,
      tasks: [task({ id: "task-1", status: "running" })],
      messages: [],
    }),
    [],
  );
});

test("a failed run is not offered as continuation", () => {
  assert.deepEqual(
    projectResultReferences({
      sessionId: SESSION,
      tasks: [task({ id: "task-1", status: "failed" })],
      messages: [],
    }),
    [],
  );
});

test("each direct Agent reply is its own result", () => {
  const references = projectResultReferences({
    sessionId: SESSION,
    tasks: [],
    messages: [
      {
        id: "turn-1:assistant:0",
        role: "assistant",
        text: "The market is consolidating.",
        createdAt: "2026-09-09T11:00:00.000Z",
        speaker: { type: "agent", id: "analyst", name: "analyst" },
      },
      {
        id: "turn-2:assistant:0",
        role: "assistant",
        text: "And here is why.",
        createdAt: "2026-09-09T11:05:00.000Z",
        speaker: { type: "agent", id: "analyst", name: "analyst" },
      },
    ],
  });

  assert.equal(references.length, 2, "one agent answering twice made two results");
  assert.deepEqual(references[0]?.source, {
    kind: "chat-message",
    messageId: "turn-1:assistant:0",
  });
});

test("a user message and a speakerless reply imply nothing", () => {
  assert.deepEqual(
    projectResultReferences({
      sessionId: SESSION,
      tasks: [],
      messages: [
        {
          id: "turn-1:user",
          role: "user",
          text: "Hello",
          createdAt: "2026-09-09T11:00:00.000Z",
        },
        {
          id: "legacy-reply",
          role: "assistant",
          text: "An old line with no producer.",
          createdAt: "2026-09-09T11:00:01.000Z",
        },
      ],
    }),
    [],
  );
});

test("re-deriving yields the same ids, so nothing is published twice", () => {
  const input = {
    sessionId: SESSION,
    tasks: [task({ id: "task-1", executionAttemptId: "attempt-1" })],
    messages: [deliveryMessage("task-1", "output/final-draft.md")],
  };

  assert.deepEqual(
    projectResultReferences(input).map((reference) => reference.id),
    projectResultReferences(input).map((reference) => reference.id),
  );
});

test("a second execution attempt of one task is a different result", () => {
  const first = projectResultReferences({
    sessionId: SESSION,
    tasks: [task({ id: "task-1", teamId: "board", executionAttemptId: "attempt-1" })],
    messages: [],
  });
  const second = projectResultReferences({
    sessionId: SESSION,
    tasks: [task({ id: "task-1", teamId: "board", executionAttemptId: "attempt-2" })],
    messages: [],
  });

  assert.notEqual(first[0]?.id, second[0]?.id);
});

/**
 * A run-summary pointer is the chat-only Team's shape. Used as a fallback for
 * any delivery-less run it becomes permanent: the id is final, so the pass
 * that runs after the delivery is published skips it, and the reference points
 * at Team messages a Workflow never wrote.
 */
test("a finished Workflow with no delivery yet implies no result", () => {
  assert.deepEqual(
    projectResultReferences({
      sessionId: SESSION,
      tasks: [task({ id: "task-1" })],
      messages: [],
    }),
    [],
  );
});

test("the same Workflow becomes a result once its delivery is published", () => {
  const [reference] = projectResultReferences({
    sessionId: SESSION,
    tasks: [task({ id: "task-1" })],
    messages: [deliveryMessage("task-1", "output/final-draft.md")],
  });

  assert.ok(reference);
  assert.equal(reference.source.kind, "artifact");
});

test("a reference records the task and attempt it can be re-verified against", () => {
  const [reference] = projectResultReferences({
    sessionId: SESSION,
    tasks: [
      task({ id: "task-1", teamId: "board", executionAttemptId: "attempt-1" }),
    ],
    messages: [],
  });

  assert.equal(reference?.producerTaskId, "task-1");
  assert.equal(reference?.executionAttemptId, "attempt-1");
});

/**
 * Two replies from one Agent were two choices reading "Analyst result", told
 * apart only by a timestamp rounded to the minute. The question each answered
 * and the opening of each answer are what differ.
 */
test("an Agent result carries the question it answered", () => {
  const references = projectResultReferences({
    sessionId: SESSION,
    tasks: [],
    messages: [
      {
        id: "turn-1:user",
        role: "user",
        text: "What is the market doing?",
        createdAt: "2026-09-09T11:00:00.000Z",
        turnId: "turn-1",
      },
      {
        id: "turn-1:assistant:0",
        role: "assistant",
        text: "It is consolidating around three players.",
        createdAt: "2026-09-09T11:00:01.000Z",
        turnId: "turn-1",
        speaker: { type: "agent", id: "analyst", name: "analyst" },
      },
    ],
  });

  assert.equal(references[0]?.brief, "What is the market doing?");
  assert.equal(
    references[0]?.excerpt,
    "It is consolidating around three players.",
  );
});

test("two replies in the same minute are distinguishable", () => {
  const references = projectResultReferences({
    sessionId: SESSION,
    tasks: [],
    messages: [
      {
        id: "turn-1:user",
        role: "user",
        text: "What is the market doing?",
        createdAt: "2026-09-09T11:00:00.000Z",
        turnId: "turn-1",
      },
      {
        id: "turn-1:assistant:0",
        role: "assistant",
        text: "It is consolidating.",
        createdAt: "2026-09-09T11:00:01.000Z",
        turnId: "turn-1",
        speaker: { type: "agent", id: "analyst", name: "analyst" },
      },
      {
        id: "turn-2:user",
        role: "user",
        text: "And the regulatory picture?",
        createdAt: "2026-09-09T11:00:20.000Z",
        turnId: "turn-2",
      },
      {
        id: "turn-2:assistant:0",
        role: "assistant",
        text: "Two reviews are pending.",
        createdAt: "2026-09-09T11:00:30.000Z",
        turnId: "turn-2",
        speaker: { type: "agent", id: "analyst", name: "analyst" },
      },
    ],
  });

  assert.equal(references.length, 2);
  assert.notEqual(references[0]?.brief, references[1]?.brief);
  assert.notEqual(references[0]?.excerpt, references[1]?.excerpt);
});

test("a reply written before turns were recorded still finds its question", () => {
  const references = projectResultReferences({
    sessionId: SESSION,
    tasks: [],
    messages: [
      {
        id: "legacy-user",
        role: "user",
        text: "An older question.",
        createdAt: "2026-09-09T11:00:00.000Z",
      },
      {
        id: "legacy-reply",
        role: "assistant",
        text: "An older answer.",
        createdAt: "2026-09-09T11:00:01.000Z",
        speaker: { type: "agent", id: "analyst", name: "analyst" },
      },
    ],
  });

  assert.equal(references[0]?.brief, "An older question.");
});
