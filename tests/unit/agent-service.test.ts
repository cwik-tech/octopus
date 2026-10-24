import test from "node:test";
import assert from "node:assert/strict";

import { ServiceError } from "../../services/service-errors.js";
import {
  parseAgentPackageImportBody,
  parseDraftAgentBody,
} from "../../services/agent-service.js";

test("agent service parses draft input for non-HTTP callers", () => {
  const body = parseDraftAgentBody({
    jobId: " job-1 ",
    skillPaths: [" /tmp/skill-a "],
    chatHistory: [{ role: "user", text: "Create a pricing agent." }],
    duplicatePolicy: "duplicate",
  });

  assert.deepEqual(body, {
    jobId: "job-1",
    skillPaths: ["/tmp/skill-a"],
    chatHistory: [{ role: "user", text: "Create a pricing agent." }],
    duplicatePolicy: "duplicate",
  });
});

test("agent service parses package import choices", () => {
  const body = parseAgentPackageImportBody({
    agentName: "pricing-agent",
    kind: "skill",
    files: [
      {
        relativePath: "pricing/SKILL.md",
        contentBase64: Buffer.from("# Pricing").toString("base64"),
      },
    ],
    choices: [
      {
        id: "pricing-skill",
        selected: true,
        action: "replace",
      },
    ],
  });

  assert.equal(body.agentName, "pricing-agent");
  assert.equal(body.preferredKind, "skill");
  assert.equal(body.files[0]?.relativePath, "pricing/SKILL.md");
  assert.deepEqual(body.choices, [
    { id: "pricing-skill", selected: true, action: "replace" },
  ]);
});

test("agent service exposes service validation errors", () => {
  assert.throws(
    () =>
      parseDraftAgentBody({
        chatHistory: [{ role: "system", text: "bad" }],
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "chatHistory[].role must be 'user' or 'assistant'",
  );
});
