import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentPackageAddBody,
  parseCommitAgentBody,
  parseDeleteAgentBody,
  parseDraftAgentBody,
  parseListSkillsBody,
} from "../../services/agent-service.js";
import { ServiceError } from "../../services/service-errors.js";
import {
  parseResourceArchitectBuildBody,
  parseResourceArchitectTurnBody,
} from "../../services/resource-architect-service.js";
import {
  parseTeamBuilderAgentBody,
  parseTeamBuilderBody,
} from "../../services/team-builder-service.js";
import {
  parseGeneratorSaveBody,
  parseGeneratorTurnBody,
  parseGeneratorValidateYamlBody,
  parseWorkflowUpdateBody,
} from "../../services/workflow-service.js";

function assertServiceError(operation: () => unknown, message: string): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "bad_request");
    assert.equal(error.message, message);
    return true;
  });
}

test("team builder parsers preserve stripping, trimming, and nullable optionals", () => {
  assert.deepEqual(
    parseTeamBuilderBody({
      id: "  research-team  ",
      description: null,
      defaultProvider: null,
      ignored: true,
    }),
    {
      id: "research-team",
    },
  );
  assert.deepEqual(
    parseTeamBuilderAgentBody({
      agentName: "  researcher  ",
      role: null,
      ignored: true,
    }),
    {
      agentName: "researcher",
    },
  );
  // Any attempt to write a retired runtime setting is refused, whatever its
  // type: silently ignoring it would report success for a control that no
  // longer works.
  assertServiceError(
    () => parseTeamBuilderBody({ id: "sample", defaultProvider: 42 }),
    "Field defaultProvider is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
  );
  assertServiceError(
    () => parseTeamBuilderAgentBody({ agentName: "researcher", model: "model-one" }),
    "Field model is no longer supported. An agent runs with its own provider/model, or with the application default from Settings.",
  );
  // A grade on a roster write is the author's own input, not an echo of the
  // server's earlier output, so it is refused by name for the same reason.
  assertServiceError(
    () => parseTeamBuilderAgentBody({ agentName: "researcher", tier: "specialist" }),
    "Field tier is no longer supported. Remove it; a member's role describes what it does, and the agent's own file says what it runs on.",
  );
  assertServiceError(
    () => parseTeamBuilderAgentBody({ agentName: "researcher", tier: 2 }),
    "Field tier is no longer supported. Remove it; a member's role describes what it does, and the agent's own file says what it runs on.",
  );
  assertServiceError(
    () => parseTeamBuilderBody({ id: null, tags: null }),
    "Field id is required and must be a non-empty string",
  );
  assertServiceError(
    () => parseTeamBuilderBody({ id: "sample", tags: null }),
    "Field tags must be an array",
  );
});

test("agent parsers preserve defaults, ignored fields, and no coercion", () => {
  assert.deepEqual(
    parseDraftAgentBody({
      skillPaths: null,
      chatHistory: null,
      jobId: 42,
      provider: null,
      model: "   ",
      ignored: true,
    }),
    {
      skillPaths: [],
      chatHistory: [],
    },
  );
  assert.deepEqual(
    parseCommitAgentBody({
      approvedName: "  writer  ",
      personaMarkdown: " persona ",
      overwrite: "true",
      ignored: true,
    }),
    {
      approvedName: "writer",
      personaMarkdown: " persona ",
      skillPaths: [],
      overwrite: false,
    },
  );
  assert.deepEqual(parseDeleteAgentBody(null), { deleteSkills: false });
  assert.deepEqual(parseListSkillsBody({ path: "  /tmp/skills  ", ignored: 1 }), {
    path: "/tmp/skills",
  });
  assertServiceError(
    () => parseDraftAgentBody({ skillPaths: 7, chatHistory: "ignored" }),
    "Field skillPaths must be an array",
  );
  assertServiceError(
    () => parseDeleteAgentBody({ deleteSkills: "false" }),
    "Field deleteSkills must be a boolean",
  );
  assertServiceError(
    () =>
      parseAgentPackageAddBody({
        agentName: "writer",
        kind: "skill",
        files: [
          { relativePath: "one.md", contentBase64: "b25l" },
          { relativePath: null, contentBase64: "dHdv" },
        ],
      }),
    "Field files[1].relativePath is required and must be a non-empty string",
  );
});


test("resource architect parsers preserve uploaded-document ownership and reader selection", () => {
  assert.deepEqual(
    parseResourceArchitectTurnBody({
      history: [],
      currentPlan: null,
      draftId: "  resource-draft  ",
      documentReader: {
        provider: "  openai  ",
        model: "  gpt-document  ",
      },
      ignored: true,
    }),
    {
      operation: "conversation",
      history: [],
      currentPlan: null,
      draftId: "resource-draft",
      documentReader: {
        provider: "openai",
        model: "gpt-document",
      },
    },
  );
  assert.deepEqual(
    parseResourceArchitectBuildBody({
      planId: " plan-1 ",
      draftId: " draft-1 ",
    }),
    {
      planId: "plan-1",
      draftId: "draft-1",
    },
  );
  assertServiceError(
    () =>
      parseResourceArchitectTurnBody({
        history: [],
        currentPlan: {
          id: "plan-1",
          kind: "standalone_agents",
          intent: "preview_only",
          agents: [{ role: "Reviewer" }],
        },
      }),
    "Field currentPlan.agents[0].name must be a non-empty string",
  );
});

test("resource architect turn operations default safely and reject unknown values", () => {
  assert.equal(
    parseResourceArchitectTurnBody({ history: [], currentPlan: null }).operation,
    "conversation",
  );
  assert.equal(
    parseResourceArchitectTurnBody({
      operation: "proposal",
      history: [],
      currentPlan: null,
    }).operation,
    "proposal",
  );
  assertServiceError(
    () => parseResourceArchitectTurnBody({
      operation: "create_now",
      history: [],
      currentPlan: null,
    }),
    "Field operation must be conversation or proposal",
  );
  assertServiceError(
    () => parseResourceArchitectBuildBody({
      planId: "plan-1",
      operation: "proposal",
    }),
    "Field operation is not valid for resource builds",
  );
});

test("resource architect history keeps the newest complete turns within its input budget", () => {
  const parsed = parseResourceArchitectTurnBody({
    history: [
      { role: "user", text: `old-${"x".repeat(13_000)}` },
      { role: "assistant", text: `middle-${"y".repeat(13_000)}` },
      { role: "user", text: "newest-request" },
    ],
    currentPlan: null,
  });

  assert.deepEqual(parsed.history.map((turn) => turn.text), [
    `middle-${"y".repeat(13_000)}`,
    "newest-request",
  ]);
  assert.ok(
    parsed.history.reduce((total, turn) => total + turn.text.length, 0) <= 24_000,
  );
});

test("resource architect request parsing ignores authorization intent on legacy plans", () => {
  const parsed = parseResourceArchitectTurnBody({
    history: [],
    currentPlan: {
      id: "legacy-plan",
      kind: "standalone_agents",
      intent: "create_now",
      agents: [{
        name: "legacy-reviewer",
        role: "Reviewer",
        tier: "specialist",
        description: "Reviews legacy input.",
        rationale: "Compatibility coverage.",
      }],
    },
  });

  // The grade is read past rather than refused: `currentPlan` is the server's
  // own earlier output handed back as context, and a plan saved before the
  // field was retired would otherwise be unusable for a follow-up. It does not
  // survive into the parsed value, because nothing downstream authors one.
  assert.deepEqual(parsed.currentPlan, {
    id: "legacy-plan",
    kind: "standalone_agents",
    agents: [{
      name: "legacy-reviewer",
      role: "Reviewer",
      description: "Reviews legacy input.",
      rationale: "Compatibility coverage.",
    }],
  });
});


test("workflow parsers preserve permissive drafts, whitespace, and validation precedence", () => {
  // Whitespace and permissive drafts are still normalized, but the pair is
  // normalized as one value. This assertion used to accept a model on its own
  // and hand back a half pair; under the two-choice rule that half pair is
  // completed from the Architect's own configuration, so the turn runs a
  // combination nobody selected and records the provenance of the pair it did
  // not run.
  assert.deepEqual(
    parseGeneratorTurnBody({
      history: [],
      currentDraft: [],
      provider: "  provider-one  ",
      model: "  model-one  ",
      ignored: true,
    }),
    {
      history: [],
      currentDraft: null,
      provider: "provider-one",
      model: "model-one",
    },
  );
  for (const half of [
    { provider: null, model: "model-one" },
    { provider: "provider-one", model: null },
    { model: "model-one" },
    { provider: "provider-one" },
  ]) {
    assertServiceError(
      () => parseGeneratorTurnBody({ history: [], currentDraft: [], ...half }),
      "Fields provider and model are required together",
    );
  }
  assert.deepEqual(
    parseGeneratorSaveBody({
      yaml: "workflow: value\n",
      ignored: true,
    }),
    {
      yaml: "workflow: value\n",
    },
  );
  assert.deepEqual(
    parseGeneratorValidateYamlBody({ yaml: "", ignored: true }),
    { yaml: "" },
  );
  assert.deepEqual(
    parseWorkflowUpdateBody({ yaml: " workflow: value ", ignored: true }),
    { yaml: " workflow: value " },
  );
  assertServiceError(
    () => parseGeneratorTurnBody({ history: null, jobId: 42 }),
    "Field history is required and must be an array",
  );
  assertServiceError(
    () => parseGeneratorSaveBody({ draft: null, yaml: 42 }),
    "Field draft must be an object",
  );
  assertServiceError(
    () =>
      parseGeneratorSaveBody({
        yaml: "workflow: value\n",
        filename: null,
      }),
    "Field filename must be a string",
  );
});
