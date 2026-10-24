import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiRequestError,
  parseRunStartRequest,
} from "../../server/http.js";
import {
  parseScheduleCreateBody,
  parseSchedulePatchBody,
} from "../../server/routes/schedules.js";
import {
  parseResearchPlanApprovalBody,
  parseResearchPlanGenerationBody,
} from "../../services/deep-research-plan-service.js";
import {
  parseRunApplyBody,
  parseRunMessageBody,
  parseRunPlanBody,
  parseRunPlanWorkflowSelectionBody,
  parseRunStatusBody,
} from "../../services/run-orchestrator-service.js";
import {
  parseSessionAgentChatMessageBody,
  parseSessionCreateBody,
  parseSessionMessageBody,
  parseSessionTitleBody,
} from "../../services/session-service.js";
import { ServiceError } from "../../services/service-errors.js";
import { parseTaskCreateBody } from "../../services/task-service.js";

function assertServiceError(
  operation: () => unknown,
  message: string,
): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "bad_request");
    assert.equal(error.message, message);
    return true;
  });
}

function assertApiRequestError(
  operation: () => unknown,
  statusCode: number,
  message: string,
): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.message, message);
    return true;
  });
}

test("session parsers preserve permissive unknown-field and null handling", () => {
  assert.deepEqual(parseSessionCreateBody(null), {});
  assert.deepEqual(
    parseSessionCreateBody({ title: "Draft", ignored: "value" }),
    { title: "Draft" },
  );
  assert.deepEqual(parseSessionCreateBody({ ignored: true }), {
    title: undefined,
  });

  assert.deepEqual(
    parseSessionMessageBody({
      text: "  Hello  ",
      provider: null,
      model: "   ",
      ignored: true,
    }),
    { text: "Hello" },
  );
  assert.deepEqual(
    parseSessionAgentChatMessageBody({
      text: "Hello",
      agentNames: null,
    }),
    { text: "Hello", agentNames: [] },
  );

  assertServiceError(
    () => parseSessionTitleBody({ title: null, ignored: true }),
    "Field title is required and must be a string",
  );
  assertServiceError(
    () => parseSessionMessageBody({ provider: 42 }),
    "Field text is required and must be a string",
  );
  assertServiceError(
    () => parseSessionMessageBody({ text: "Hello", provider: 42 }),
    "Field provider must be a string",
  );
});

test("task and run-plan parsers preserve trimming, omission, and error precedence", () => {
  assert.deepEqual(
    parseTaskCreateBody({
      workflowId: "  workflow-one  ",
      brief: "",
      ignored: true,
    }),
    { workflowId: "workflow-one", brief: "" },
  );
  assertServiceError(
    () => parseTaskCreateBody({ workflowId: null, brief: 42 }),
    "Field workflowId is required and must be a non-empty string",
  );

  assert.deepEqual(
    parseRunPlanBody({
      sessionId: null,
      goal: null,
      workflowId: "  workflow-one  ",
      ignored: true,
    }),
    {
      goal: "",
      workflowId: "workflow-one",
    },
  );
  assertServiceError(
    () => parseRunPlanBody({ goal: 42 }),
    "Field goal must be a string",
  );

  assertServiceError(
    () => parseRunApplyBody({ plan: null }),
    "Field plan is required",
  );
  assertServiceError(
    () => parseRunStatusBody({ sessionId: null, taskId: null }),
    "Field sessionId is required",
  );
  assertServiceError(
    () =>
      parseRunPlanWorkflowSelectionBody({
        workflowId: "workflow-one",
        expectedPlanId: null,
      }),
    "Field expectedPlanId is required",
  );
  assertServiceError(
    () => parseRunMessageBody({ sessionId: null, text: null }),
    "Field sessionId is required",
  );
});

test("deep-research parsers preserve strict keys and validation order", () => {
  assert.deepEqual(
    parseResearchPlanGenerationBody({ expectedPlanId: "  plan-one  " }),
    { expectedPlanId: "plan-one" },
  );
  assertServiceError(
    () =>
      parseResearchPlanGenerationBody({
        expectedPlanId: "plan-one",
        ignored: true,
      }),
    "Request body must contain only expectedPlanId",
  );
  assertServiceError(
    () => parseResearchPlanGenerationBody({}),
    "Request body must contain only expectedPlanId",
  );
  assertServiceError(
    () =>
      parseResearchPlanApprovalBody({
        expectedPlanId: null,
        expectedResearchPlanHash: "not-a-hash",
      }),
    "Field expectedResearchPlanHash must be a SHA-256 hash",
  );
});

test("schedule parsers preserve strict objects, defaults, null clearing, and no coercion", () => {
  const input = {
    name: "  Morning report  ",
    kind: "workflow",
    target: "workflow-one",
    prompt: "Run the report.",
    cron: "0 9 * * *",
    timezone: "  America/Detroit  ",
    scheduleLabel: "  Every morning  ",
    overlap: "skip",
    notifyOnFailure: false,
  };

  assert.deepEqual(parseScheduleCreateBody(input), {
    name: "Morning report",
    kind: "workflow",
    target: "workflow-one",
    prompt: "Run the report.",
    cron: "0 9 * * *",
    timezone: "America/Detroit",
    scheduleLabel: "Every morning",
    overlap: "skip",
    notifyOnFailure: false,
  });
  // Clearing the retired field is allowed and drops it; setting it is not.
  assert.deepEqual(parseSchedulePatchBody({ modelOverride: null }), {
    modelOverride: undefined,
  });
  assertApiRequestError(
    () =>
      parseSchedulePatchBody({
        modelOverride: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    400,
    "Schedule field 'modelOverride' is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
  );

  assertApiRequestError(
    () => parseScheduleCreateBody({ ...input, ignored: true }),
    400,
    "Schedule contains unknown fields: ignored.",
  );
  assertApiRequestError(
    () => parseScheduleCreateBody({ ...input, notifyOnFailure: "false" }),
    400,
    "Schedule field 'notifyOnFailure' must be a boolean.",
  );
  assertApiRequestError(
    () => parseSchedulePatchBody({}),
    400,
    "Schedule patch must contain at least one field.",
  );
});

test("top-level run parser strips unknown fields but preserves cwd whitespace", () => {
  assert.deepEqual(
    parseRunStartRequest({
      cwd: "  /tmp/workspace  ",
      env: { MODE: "test" },
      ignored: true,
    }),
    {
      cwd: "  /tmp/workspace  ",
      env: { MODE: "test" },
    },
  );
  assertApiRequestError(
    () => parseRunStartRequest(null),
    400,
    "Request body must be a JSON object",
  );
  assertApiRequestError(
    () => parseRunStartRequest({ cwd: "/tmp", env: { COUNT: 1 } }),
    400,
    "Field env.COUNT must be a string",
  );
});

test("session message target accepts each dispatch branch and rejects malformed ones", () => {
  assert.deepEqual(
    parseSessionMessageBody({
      text: "Draft it",
      target: { kind: "agents", agentNames: ["  analyst  ", "writer", "analyst"] },
    }),
    {
      text: "Draft it",
      target: { kind: "agents", agentNames: ["analyst", "writer"] },
    },
  );
  assert.deepEqual(
    parseSessionMessageBody({
      text: "Run it",
      target: { kind: "team", teamId: "  problem-thinking-board  " },
    }),
    {
      text: "Run it",
      target: { kind: "team", teamId: "problem-thinking-board" },
    },
  );
  assert.deepEqual(
    parseSessionMessageBody({
      text: "Use this",
      target: {
        kind: "workflow",
        workflowId: "  discussion-to-writing3  ",
        expectedPlanId: null,
      },
    }),
    {
      text: "Use this",
      target: {
        kind: "workflow",
        workflowId: "discussion-to-writing3",
        expectedPlanId: null,
      },
    },
  );
  assert.deepEqual(
    parseSessionMessageBody({
      text: "Revise it",
      target: {
        kind: "workflow",
        workflowId: "discussion-to-writing3",
        expectedPlanId: "run-plan-7",
      },
    }),
    {
      text: "Revise it",
      target: {
        kind: "workflow",
        workflowId: "discussion-to-writing3",
        expectedPlanId: "run-plan-7",
      },
    },
  );

  // An untargeted body must stay byte-identical to the legacy shape, because
  // its fingerprint is compared against turns persisted before targets existed.
  assert.deepEqual(parseSessionMessageBody({ text: "Hello" }), { text: "Hello" });

  assertServiceError(
    () => parseSessionMessageBody({ text: "Hi", target: { kind: "everyone" } }),
    "Field target must name agents, team, or workflow",
  );
  assertServiceError(
    () => parseSessionMessageBody({ text: "Hi", target: { kind: "agents", agentNames: [] } }),
    "Field target.agentNames must name 1 to 8 agents",
  );
  assertServiceError(
    () =>
      parseSessionMessageBody({
        text: "Hi",
        target: {
          kind: "agents",
          agentNames: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        },
      }),
    "Field target.agentNames must name 1 to 8 agents",
  );
  assertServiceError(
    () => parseSessionMessageBody({ text: "Hi", target: { kind: "agents", agentNames: ["  "] } }),
    "Field target.agentNames must contain non-empty strings",
  );
  assertServiceError(
    () => parseSessionMessageBody({ text: "Hi", target: { kind: "team", teamId: "   " } }),
    "Field target.teamId must be a non-empty string",
  );
  assertServiceError(
    () =>
      parseSessionMessageBody({
        text: "Hi",
        target: { kind: "workflow", workflowId: "", expectedPlanId: null },
      }),
    "Field target.workflowId must be a non-empty string",
  );
  // Omitting the expectation is not the same as saying "there is no plan". A
  // missing field would let the server pick a plan on the caller's behalf.
  assertServiceError(
    () =>
      parseSessionMessageBody({
        text: "Hi",
        target: { kind: "workflow", workflowId: "discussion-to-writing3" },
      }),
    "Field target.expectedPlanId must be a plan id or null",
  );
  assertServiceError(
    () =>
      parseSessionMessageBody({
        text: "Hi",
        target: {
          kind: "workflow",
          workflowId: "discussion-to-writing3",
          expectedPlanId: "",
        },
      }),
    "Field target.expectedPlanId must be a plan id or null",
  );
  // A team id smuggled onto an agents target is a second addressee, not an
  // extra field to drop quietly.
  assertServiceError(
    () =>
      parseSessionMessageBody({
        text: "Hi",
        target: { kind: "agents", agentNames: ["analyst"], teamId: "board" },
      }),
    "Field target must not mix dispatch branches",
  );
});
