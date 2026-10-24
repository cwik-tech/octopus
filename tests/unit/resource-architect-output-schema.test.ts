import assert from "node:assert/strict";
import test from "node:test";

import { RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA } from "../../domains/resource-architect/resource-architect-output-schema.js";

/**
 * Codex rejects a structured-output schema at the API boundary, not at parse
 * time, and the Resource Architect turns that rejection into a fallback
 * discussion — so a malformed schema costs a plan and a build job while
 * looking like an ordinary reply. This walks the shipped schema under the
 * rules Codex enforces so the cost lands here instead.
 *
 * Two rules, both observed from real `invalid_json_schema` responses:
 * a node that constrains a value with `const` or `enum` must still say what
 * `type` that value is, and every declared property of an object must appear
 * in `required`. Optional fields survive as an explicit null variant rather
 * than by omission from `required`.
 */
function collectCodexStrictSchemaViolations(
  schema: Readonly<Record<string, unknown>>,
): string[] {
  const violations: string[] = [];

  const walk = (node: unknown, context: readonly string[]): void => {
    if (!isRecord(node)) return;
    const at = `context=(${context.map((part) => `'${part}'`).join(", ")})`;

    if (("const" in node || "enum" in node) && !("type" in node)) {
      violations.push(`In ${at}, schema must have a 'type' key.`);
    }

    if (node.type === "object") {
      if (node.additionalProperties !== false) {
        violations.push(`In ${at}, object schema must set additionalProperties to false.`);
      }
      const properties = isRecord(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required)
        ? node.required.filter((entry): entry is string => typeof entry === "string")
        : [];
      for (const name of Object.keys(properties)) {
        if (!required.includes(name)) {
          violations.push(`In ${at}, property '${name}' must appear in 'required'.`);
        }
      }
    }

    if (isRecord(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        walk(child, [...context, "properties", name]);
      }
    }
    walk(node.items, [...context, "items"]);
    for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, index) => {
        walk(branch, [...context, keyword, String(index)]);
      });
    }
  };

  walk(schema, []);
  return violations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("the shipped Resource Architect proposal schema satisfies Codex strict-schema rules", () => {
  const violations = collectCodexStrictSchemaViolations(
    RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
  );

  assert.deepEqual(
    violations,
    [],
    `Codex would reject this schema with invalid_json_schema:\n${violations.join("\n")}`,
  );
});

test("the strict-schema check names a discriminator that omits its type", () => {
  const violations = collectCodexStrictSchemaViolations({
    type: "object",
    properties: { kind: { const: "discussion" } },
    required: ["kind"],
    additionalProperties: false,
  });

  assert.deepEqual(violations, [
    "In context=('properties', 'kind'), schema must have a 'type' key.",
  ]);
});

test("the strict-schema check names a property missing from required", () => {
  const violations = collectCodexStrictSchemaViolations({
    type: "object",
    properties: {
      present: { type: "string" },
      omitted: { type: "string" },
    },
    required: ["present"],
    additionalProperties: false,
  });

  assert.deepEqual(violations, [
    "In context=(), property 'omitted' must appear in 'required'.",
  ]);
});

/**
 * The one object branch whose discriminator is `kind`, or `null`.
 *
 * A flattened walk of the whole schema cannot answer a question about one
 * operation: `skillUpdates` appearing *somewhere* says nothing about whether
 * the `update_agent_skills` branch is the place it appears. The branch is
 * located first, and everything is then asserted against that object alone.
 */
function findOperationBranch(
  node: unknown,
  kind: string,
): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  if (isRecord(node.properties)) {
    const discriminator = node.properties.kind;
    if (isRecord(discriminator) && discriminator.const === kind) return node;
    for (const child of Object.values(node.properties)) {
      const found = findOperationBranch(child, kind);
      if (found) return found;
    }
  }
  const inItems = findOperationBranch(node.items, kind);
  if (inItems) return inItems;
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const found = findOperationBranch(branch, kind);
      if (found) return found;
    }
  }
  return null;
}

function propertyNames(node: Record<string, unknown>): string[] {
  return isRecord(node.properties) ? Object.keys(node.properties).sort() : [];
}

function requiredNames(node: Record<string, unknown>): string[] {
  return Array.isArray(node.required)
    ? node.required.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

test("the schema still offers the Team addition operation", () => {
  assert.ok(
    findOperationBranch(RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA, "add_team_agents"),
    "expected an add_team_agents operation branch",
  );
});

test("the skill update operation declares exactly the fields it owns", () => {
  const branch = findOperationBranch(
    RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
    "update_agent_skills",
  );

  assert.ok(branch, "expected an update_agent_skills operation branch");
  assert.deepEqual(propertyNames(branch), ["kind", "skillUpdates", "target"]);
  assert.deepEqual(requiredNames(branch), ["kind", "skillUpdates", "target"]);
  assert.equal(branch.additionalProperties, false);
});

/**
 * The prompt carries no source revision, so a revision the model returned
 * would be one it invented. Offering the field on the operation invites
 * exactly that.
 */
test("the skill update operation never offers the model a revision to fill in", () => {
  const branch = findOperationBranch(
    RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
    "update_agent_skills",
  );

  assert.ok(branch);
  assert.equal(propertyNames(branch).includes("expectedRevision"), false);
});

test("the skill update operation targets an Agent and nothing else", () => {
  const branch = findOperationBranch(
    RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
    "update_agent_skills",
  );

  assert.ok(branch);
  const target = isRecord(branch.properties) ? branch.properties.target : null;
  assert.ok(isRecord(target), "the operation must declare a target");
  const targetKind = isRecord(target.properties) ? target.properties.kind : null;
  assert.ok(isRecord(targetKind));
  assert.equal(targetKind.const, "agent");
  assert.deepEqual(propertyNames(target), ["id", "kind"]);
});

test("every skill action in the operation carries an action, a name, and an instruction", () => {
  const branch = findOperationBranch(
    RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA,
    "update_agent_skills",
  );

  assert.ok(branch);
  const skillUpdates = isRecord(branch.properties) ? branch.properties.skillUpdates : null;
  assert.ok(isRecord(skillUpdates), "the operation must declare skillUpdates");
  assert.equal(skillUpdates.type, "array");
  assert.equal(skillUpdates.minItems, 1, "an operation with no skill action is not an operation");
  const item = skillUpdates.items;
  assert.ok(isRecord(item), "skillUpdates must declare its item shape");
  assert.deepEqual(propertyNames(item), ["action", "instruction", "name"]);
  assert.deepEqual(requiredNames(item), ["action", "instruction", "name"]);
  assert.equal(item.additionalProperties, false);
  const action = isRecord(item.properties) ? item.properties.action : null;
  assert.ok(isRecord(action));
  assert.deepEqual(action.enum, ["create", "update"]);
});

/**
 * The item schema for the new Agents one branch proposes.
 *
 * Three shapes propose a new Agent: a standalone proposal, a new Team, and a
 * Team update that creates Agents. Each is asked for by name so a summary
 * declared on one branch cannot stand in for the others.
 */
function newAgentItemSchema(
  kind: "standalone_agents" | "team" | "add_team_agents",
): Record<string, unknown> {
  const branch = findOperationBranch(RESOURCE_ARCHITECT_PROPOSAL_OUTPUT_SCHEMA, kind);
  assert.ok(branch, `expected a ${kind} branch`);
  const properties = isRecord(branch.properties) ? branch.properties : {};
  const list = kind === "standalone_agents"
    ? properties.agents
    : kind === "team"
      ? isRecord(properties.team) && isRecord(properties.team.properties)
        ? properties.team.properties.newAgents
        : undefined
      : properties.newAgentsToCreate;
  assert.ok(isRecord(list) && isRecord(list.items), `expected ${kind} to declare its new Agents`);
  return list.items;
}

test("every new-Agent shape requires a card summary of at most 240 characters beside its build brief", () => {
  for (const kind of ["standalone_agents", "team", "add_team_agents"] as const) {
    const item = newAgentItemSchema(kind);
    const properties = isRecord(item.properties) ? item.properties : {};

    assert.deepEqual(
      properties.summary,
      { type: "string", minLength: 1, maxLength: 240 },
      `${kind} does not bound the card summary`,
    );
    assert.ok(requiredNames(item).includes("summary"), `${kind} does not require a summary`);
    // The build brief stays required and unbounded: it is the generator's input.
    assert.deepEqual(properties.description, { type: "string", minLength: 1 }, kind);
    assert.ok(requiredNames(item).includes("description"), `${kind} dropped the build brief`);
  }
});
