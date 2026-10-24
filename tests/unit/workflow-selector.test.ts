import test from "node:test";
import assert from "node:assert/strict";

import { selectWorkflowForBrief } from "../../workflows/selector.js";
import type { WorkflowRegistryEntry } from "../../workflows/types.js";

// Preserve the dormant selector's behavior for a possible future offline or
// retrieval-shortlisting use. Product workflow selection must not call it.
function registry(
  entries: Array<Omit<WorkflowRegistryEntry, "template_path">>,
): Map<string, WorkflowRegistryEntry> {
  return new Map(
    entries.map((entry) => [
      entry.name,
      { ...entry, template_path: `/${entry.name}.yaml` },
    ]),
  );
}

test("workflow selector chooses a clear weighted metadata match", () => {
  const workflows = registry([
    {
      name: "discussion-to-writing",
      tags: ["discussion", "writing"],
      capabilities: ["brainstorm_then_write"],
    },
    {
      name: "venture-diligence",
      tags: ["venture", "diligence"],
      capabilities: ["investment_screening"],
    },
  ]);

  assert.equal(
    selectWorkflowForBrief(
      "Screen this venture investment and perform diligence.",
      workflows,
    )?.name,
    "venture-diligence",
  );
});

test("workflow selector refuses ambiguous matches", () => {
  const workflows = registry([
    { name: "market-analysis", tags: ["market", "analysis"] },
    { name: "market-research", tags: ["market", "research"] },
  ]);

  assert.equal(
    selectWorkflowForBrief(
      "Compare market analysis with market research.",
      workflows,
    ),
    null,
  );
});

test("workflow selector does not treat substrings as token matches", () => {
  const workflows = registry([
    {
      name: "people-operations",
      description: "Coordinate paralegal staffing.",
    },
    {
      name: "contract-review",
      description: "Perform legal contract review.",
      tags: ["legal"],
    },
  ]);

  assert.equal(
    selectWorkflowForBrief("Perform a legal review.", workflows)?.name,
    "contract-review",
  );
});

test("workflow selector rejects a single weak description token", () => {
  const workflows = registry([
    { name: "venture-diligence", description: "Founder screening." },
    { name: "discussion-to-writing", description: "Structured writing." },
  ]);

  assert.equal(selectWorkflowForBrief("Help with screening.", workflows), null);
});
