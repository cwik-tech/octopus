/**
 * One number decides how long a planned Agent's card summary may be.
 *
 * The provider schema, the proposal parser and the response contract the model
 * reads all enforce or state that limit. If any of them restated the number,
 * changing it in one place would leave the model told one limit, the schema
 * enforcing another and the parser refusing a third, and every proposal in the
 * gap would spend its one repair attempt on a rule nobody agreed on.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { MAX_PLANNED_AGENT_SUMMARY_LENGTH } from "../../domains/agent-generator/planned-agent-rules.js";

const PROPOSAL_BOUNDARIES = [
  "domains/resource-architect/resource-architect-output-schema.ts",
  "domains/resource-architect/resource-architect-proposal-parser.ts",
  "domains/resource-architect/resource-architect-llm.ts",
];

test("a planned Agent summary may be at most 240 characters", () => {
  assert.equal(MAX_PLANNED_AGENT_SUMMARY_LENGTH, 240);
});

test("every proposal boundary takes the summary limit from the shared rule", () => {
  for (const relativePath of PROPOSAL_BOUNDARIES) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.match(
      source,
      /import\s*\{[^}]*\bMAX_PLANNED_AGENT_SUMMARY_LENGTH\b[^}]*\}\s*from\s*["'][./]*(?:agent-generator\/)?planned-agent-rules\.js["']/u,
      `${relativePath} does not import the shared summary limit`,
    );
    assert.doesNotMatch(
      source,
      /\b240\b/u,
      `${relativePath} restates the summary limit instead of importing it`,
    );
  }
});
