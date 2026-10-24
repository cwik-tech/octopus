import assert from "node:assert/strict";
import test from "node:test";

import {
  researchPlanApprovalRequestSchema,
  researchPlanGenerationRequestSchema,
} from "../../contracts/schemas/deep-research-requests.js";
import { runPlanWorkflowSelectionRequestSchema } from "../../contracts/schemas/run-plan-requests.js";
import { runStartRequestSchema } from "../../contracts/schemas/run-requests.js";
import {
  scheduleCreateRequestSchema,
  schedulePatchRequestSchema,
} from "../../contracts/schemas/scheduling-requests.js";
import {
  sessionAgentChatMessageRequestSchema,
  sessionCreateRequestSchema,
  sessionMessageRequestSchema,
  sessionTitleRequestSchema,
} from "../../contracts/schemas/session-requests.js";
import { taskCreateRequestSchema } from "../../contracts/schemas/task-requests.js";

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  return schema.parse(value);
}

function firstIssue(
  schema: {
    safeParse(value: unknown):
      | { success: true }
      | {
          success: false;
          error: { issues: Array<{ message: string }> };
        };
  },
  value: unknown,
): string {
  const result = schema.safeParse(value);
  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected schema failure");
  return result.error.issues[0]?.message ?? "";
}

test("session schemas preserve permissive create and normalized message semantics", () => {
  assert.deepEqual(parse(sessionCreateRequestSchema, null), {});
  assert.deepEqual(
    parse(sessionCreateRequestSchema, { ignored: true }),
    { title: undefined },
  );
  assert.equal(
    firstIssue(sessionCreateRequestSchema, { title: 42 }),
    "Field title must be a string",
  );
  assert.deepEqual(
    parse(sessionTitleRequestSchema, {
      title: "  Session title  ",
      ignored: true,
    }),
    { title: "Session title" },
  );

  assert.deepEqual(
    parse(sessionMessageRequestSchema, {
      text: "  Hello  ",
      provider: null,
      model: "   ",
      ignored: true,
    }),
    { text: "Hello" },
  );
  assert.deepEqual(
    parse(sessionAgentChatMessageRequestSchema, {
      text: "Hello",
      agentNames: [
        " one ",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
      ],
    }),
    {
      text: "Hello",
      agentNames: [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
      ],
    },
  );
  assert.equal(
    firstIssue(sessionAgentChatMessageRequestSchema, {
      text: " ",
      agentNames: 42,
    }),
    "Field text must not be empty",
  );
  assert.equal(
    firstIssue(sessionAgentChatMessageRequestSchema, {
      text: "Hello",
      agentNames: [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
      ],
    }),
    "Field agentNames exceeds 8 agents",
  );
});

test("task, run-plan, deep-research, and run schemas preserve exact outputs and precedence", () => {
  assert.deepEqual(
    parse(taskCreateRequestSchema, {
      workflowId: "  workflow-one  ",
      ignored: true,
    }),
    { workflowId: "workflow-one", brief: undefined },
  );
  assert.deepEqual(
    parse(runPlanWorkflowSelectionRequestSchema, {
      workflowId: "  workflow-one ",
      expectedPlanId: " plan-one ",
      ignored: true,
    }),
    {
      workflowId: "workflow-one",
      expectedPlanId: "plan-one",
    },
  );

  assert.equal(
    firstIssue(researchPlanGenerationRequestSchema, {}),
    "Request body must contain only expectedPlanId",
  );
  assert.equal(
    firstIssue(researchPlanApprovalRequestSchema, {
      expectedPlanId: null,
      expectedResearchPlanHash: "not-a-hash",
    }),
    "Field expectedResearchPlanHash must be a SHA-256 hash",
  );

  assert.deepEqual(
    parse(runStartRequestSchema, {
      cwd: "  /tmp/workspace  ",
      env: { MODE: "test" },
      ignored: true,
    }),
    {
      cwd: "  /tmp/workspace  ",
      env: { MODE: "test" },
    },
  );
  assert.deepEqual(parse(runStartRequestSchema, { cwd: "/tmp" }), {
    cwd: "/tmp",
  });
  assert.equal(
    firstIssue(runStartRequestSchema, {
      cwd: "/tmp",
      env: { COUNT: 1 },
    }),
    "Field env.COUNT must be a string",
  );
});

test("schedule schemas preserve staged validation and patch presence semantics", () => {
  const base = {
    name: " Morning report ",
    kind: "agent",
    target: " analyst ",
    prompt: " Write it ",
    cron: " 0 9 * * * ",
    timezone: " America/Detroit ",
    scheduleLabel: " Every morning ",
    overlap: "skip",
    notifyOnFailure: false,
  };

  // A schedule runs an Agent; it never chose the Agent's model. The field is
  // refused rather than accepted and ignored.
  assert.equal(
    firstIssue(scheduleCreateRequestSchema, {
      ...base,
      modelOverride: { provider: " openai ", model: " gpt-5 " },
    }),
    "Schedule field 'modelOverride' is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
  );
  assert.deepEqual(
    parse(scheduleCreateRequestSchema, {
      ...base,
      projectId: "11111111-1111-4111-8111-111111111111",
      projectContext: {
        version: 1,
        includeBrief: true,
        fileNames: [" source.md "],
      },
    }),
    {
      name: "Morning report",
      kind: "agent",
      target: "analyst",
      prompt: "Write it",
      cron: "0 9 * * *",
      timezone: "America/Detroit",
      scheduleLabel: "Every morning",
      overlap: "skip",
      notifyOnFailure: false,
      projectId: "11111111-1111-4111-8111-111111111111",
      projectContext: {
        version: 1,
        includeBrief: true,
        fileNames: ["source.md"],
      },
    },
  );
  assert.equal(
    firstIssue(scheduleCreateRequestSchema, {
      ...base,
      name: "",
      kind: "workflow",
      enabled: "true",
    }),
    "Schedule field 'enabled' must be a boolean.",
  );
  assert.equal(
    firstIssue(scheduleCreateRequestSchema, {
      ...base,
      extraTwo: true,
      extraOne: true,
    }),
    "Schedule contains unknown fields: extraTwo, extraOne.",
  );
  assert.deepEqual(
    parse(scheduleCreateRequestSchema, {
      ...base,
      modelOverride: undefined,
      enabled: undefined,
    }),
    {
      name: "Morning report",
      kind: "agent",
      target: "analyst",
      prompt: "Write it",
      cron: "0 9 * * *",
      timezone: "America/Detroit",
      scheduleLabel: "Every morning",
      overlap: "skip",
      notifyOnFailure: false,
    },
  );

  assert.equal(
    firstIssue(schedulePatchRequestSchema, {
      kind: "workflow",
      modelOverride: { provider: " openai ", model: " gpt-5 " },
    }),
    "Schedule field 'modelOverride' is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
  );
  assert.equal(
    firstIssue(schedulePatchRequestSchema, {
      name: undefined,
      kind: "invalid",
    }),
    "Schedule field 'name' must be a string.",
  );
  assert.equal(
    firstIssue(schedulePatchRequestSchema, {
      kind: "invalid",
      target: undefined,
    }),
    "Schedule field 'kind' must be 'agent' or 'workflow'.",
  );
  // Explicitly present-but-undefined is how a patch clears a field, and the
  // retired one has nothing to clear, so it passes through untouched.
  assert.deepEqual(
    parse(schedulePatchRequestSchema, { modelOverride: undefined }),
    { modelOverride: undefined },
  );
  assert.equal(
    firstIssue(schedulePatchRequestSchema, {
      modelOverride: { unexpected: true },
    }),
    "Schedule field 'modelOverride' is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
  );
});
