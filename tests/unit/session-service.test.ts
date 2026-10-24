import { whenDefined } from '../../core/optional-properties.js'
import test from "node:test";
import assert from "node:assert/strict";

import { ServiceError } from "../../services/service-errors.js";
import {
  buildChatMessage,
  parseSessionAgentChatMessageBody,
  parseSessionCreateBody,
  parseSessionMessageBody,
  parseSessionTitleBody,
  shouldPreserveApprovedDeepResearchPlanForStart,
  shouldPreserveReadyPlanForStart,
} from "../../services/session-service.js";
import { approveResearchPlan, hashUnapprovedResearchPlan } from "../../domains/deep-research/deep-research-approval.js";
import { makePlan, TEST_TIME } from "./deep-research-fixtures.js";
import type { RunPlan } from "../../contracts/run-plan.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

test("session service parses create, title, and message bodies", () => {
  assert.deepEqual(parseSessionCreateBody(null), {});
  assert.deepEqual(parseSessionCreateBody({ title: "Draft" }), {
    title: "Draft",
  });
  assert.deepEqual(parseSessionTitleBody({ title: " Renamed " }), {
    title: "Renamed",
  });
  assert.deepEqual(parseSessionMessageBody({ text: " Hello " }), {
    text: "Hello",
  });
  assert.deepEqual(
    parseSessionAgentChatMessageBody({
      text: " Hello ",
      agentNames: [" analyst ", "writer", "analyst"],
      provider: " deepseek ",
      model: " deepseek-v4-flash ",
    }),
    {
      text: "Hello",
      agentNames: ["analyst", "writer"],
      provider: "deepseek",
      model: "deepseek-v4-flash",
    },
  );
});

test("session message bodies accept only an explicit safe project context selection", () => {
  const projectContext = {
    projectId: PROJECT_ID,
    includeBrief: true,
    fileNames: ["brief.md", "metrics.csv"],
  };

  assert.deepEqual(
    parseSessionMessageBody({ text: "Use these references", projectContext }),
    { text: "Use these references", projectContext },
  );
  assert.deepEqual(
    parseSessionAgentChatMessageBody({
      text: "Review these references",
      agentNames: ["analyst"],
      projectContext,
    }),
    {
      text: "Review these references",
      agentNames: ["analyst"],
      projectContext,
    },
  );
  assert.throws(
    () =>
      parseSessionMessageBody({
        text: "Use this",
        projectContext: {
          ...projectContext,
          fileNames: ["../secret.md"],
        },
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field projectContext.fileNames contains an invalid filename",
  );
});

test("session service exposes service validation errors", () => {
  assert.throws(
    () => parseSessionTitleBody({ title: "" }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field title must not be empty",
  );

  assert.throws(
    () => parseSessionMessageBody({ text: "" }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field text must not be empty",
  );

  assert.throws(
    () => parseSessionAgentChatMessageBody({ text: "hi", agentNames: "agent" }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field agentNames must be an array",
  );
});

test("session service bounds provider and model identifiers", () => {
  assert.deepEqual(
    parseSessionMessageBody({
      text: "Hello",
      provider: "p".repeat(128),
      model: "m".repeat(128),
    }),
    {
      text: "Hello",
      provider: "p".repeat(128),
      model: "m".repeat(128),
    },
  );
  assert.throws(
    () =>
      parseSessionMessageBody({
        text: "Hello",
        provider: "p".repeat(129),
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field provider exceeds 128 characters",
  );
  assert.throws(
    () =>
      parseSessionAgentChatMessageBody({
        text: "Hello",
        agentNames: ["analyst"],
        model: "m".repeat(129),
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field model exceeds 128 characters",
  );
});

test("session service builds persisted chat message shape", () => {
  const message = buildChatMessage("assistant", "Ready.", {
    speaker: {
      type: "agent",
      id: "analyst",
      name: "Analyst",
    },
    turnId: "turn-1",
  });

  assert.equal(message.role, "assistant");
  assert.equal(message.text, "Ready.");
  assert.equal(message.speaker?.id, "analyst");
  assert.equal(message.turnId, "turn-1");
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(message.createdAt));
});

test("chat Start preserves the exact approved Deep Research plan", () => {
  const researchPlan = approveResearchPlan(makePlan(), TEST_TIME);
  const runPlan: RunPlan = {
    id: "run-plan-one",
    goal: "Research acquisition economics",
    summary: "Ready",
    status: "ready",
    selectedWorkflow: {
      id: "deep-research-report",
      rationale: "Deep research requested.",
      confidence: "high",
    },
    deepResearchIntakeComplete: true,
    researchPlan,
    researchPlanProposalHash: hashUnapprovedResearchPlan(researchPlan),
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: TEST_TIME,
  };

  assert.equal(shouldPreserveApprovedDeepResearchPlanForStart(runPlan, {
    launchIntent: "start",
    workflowId: "deep-research-report",
  }), true);
  assert.equal(shouldPreserveApprovedDeepResearchPlanForStart(runPlan, {
    launchIntent: "none",
    workflowId: "deep-research-report",
  }), false);
  assert.equal(shouldPreserveApprovedDeepResearchPlanForStart({
    ...runPlan,
    researchPlan: { ...researchPlan, request: { ...researchPlan.request, audience: "Changed" } },
  }, {
    launchIntent: "start",
    workflowId: "deep-research-report",
  }), false);
  const {
    researchPlanProposalHash: _proposalHash,
    ...runPlanWithoutProposalHash
  } = runPlan
  assert.equal(shouldPreserveApprovedDeepResearchPlanForStart({
    ...runPlanWithoutProposalHash,
  }, {
    launchIntent: "start",
    workflowId: "deep-research-report",
  }), false);
});

/**
 * A start instruction must not rebuild the plan it confirms: "go for it" as
 * the goal would erase the ready plan's brief and selection. Preservation is
 * gated on readiness and on the same workflow — anything else replans.
 */
test("chat Start preserves any ready plan for the workflow it names", () => {
  const runPlan: RunPlan = {
    id: "run-plan-two",
    goal: "Write a launch announcement",
    summary: "Ready",
    status: "ready",
    selectedWorkflow: {
      id: "wf-1",
      rationale: "Selected earlier.",
      confidence: "high",
      selectionSource: "user",
    },
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: TEST_TIME,
  };

  assert.equal(shouldPreserveReadyPlanForStart(runPlan, {
    launchIntent: "start",
    workflowId: "wf-1",
  }), true);
  assert.equal(shouldPreserveReadyPlanForStart(runPlan, {
    launchIntent: "start",
    workflowId: "wf-2",
  }), false, "a start naming another workflow replans");
  assert.equal(shouldPreserveReadyPlanForStart(runPlan, {
    launchIntent: "none",
    workflowId: "wf-1",
  }), false, "an ordinary turn does not trigger preservation");
  assert.equal(shouldPreserveReadyPlanForStart({ ...runPlan, status: "needs_input" }, {
    launchIntent: "start",
    workflowId: "wf-1",
  }), false, "a plan that is not ready still needs the details it asks for");
  const { selectedWorkflow: _dropped, ...unselectedPlan } = runPlan;
  assert.equal(shouldPreserveReadyPlanForStart(unselectedPlan, {
    launchIntent: "start",
    workflowId: "wf-1",
  }), false, "a plan with no selection has nothing to preserve for a start");
});
