import assert from "node:assert/strict";
import test from "node:test";
import { parseResourceArchitectReview } from "../../domains/resource-architect/resource-architect-review-parser.js";
import {
  resourceArchitectFeedbackDiagnosticsSchema,
  resourceArchitectReviewWarnings,
  resourceArchitectReviewSchema,
  RESOURCE_ARCHITECT_REVIEW_OUTPUT_SCHEMA,
} from "../../contracts/schemas/resource-architect-review.js";

const pass = { verdict: "pass", findings: [] };
const finding = {
  severity: "high",
  location: "Missing Skills section",
  issue: 'The draft says "done" but omits {Skills}.',
  requestedChange: "Add the Skills table with every consuming Agent and sharing.",
};
const revision = { verdict: "revise", findings: [finding] };

for (const [name, source] of [
  ["raw JSON", JSON.stringify(revision)],
  ["a JSON fence", `\u0060\u0060\u0060json\n${JSON.stringify(revision)}\n\u0060\u0060\u0060`],
  ["prose around JSON", `Here is my review:\n${JSON.stringify(revision)}\nEnd of review.`],
  ["braces and escaped quotes in findings", JSON.stringify(revision)],
] as const) {
  test(`accepts ${name} without changing the critique`, () => {
    assert.deepEqual(parseResourceArchitectReview(source), { ok: true, review: revision });
  });
}

test("accepts a sound draft without inventing findings", () => {
  assert.deepEqual(parseResourceArchitectReview(JSON.stringify(pass)), { ok: true, review: pass });
});

for (const [name, source, kind] of [
  ["multiple review objects", `${JSON.stringify(pass)} ${JSON.stringify(revision)}`, "extraction"],
  ["truncated JSON", '{"verdict":"pass","findings":[]', "extraction"],
  ["missing JSON", "This looks good.", "extraction"],
  ["a JSON array wrapper", JSON.stringify([pass]), "schema"],
  ["a fenced JSON array wrapper", `Here is my review:\n\u0060\u0060\u0060json\n${JSON.stringify([pass])}\n\u0060\u0060\u0060`, "schema"],
  ["a truncated JSON array wrapper", `[${JSON.stringify(pass)}`, "schema"],
  ["input beyond the bound", " ".repeat(65_537), "extraction"],
  ["invalid JSON syntax", '{"verdict":"pass", "findings":[],}', "json"],
  ["a pass with criticism", JSON.stringify({ ...pass, findings: [finding] }), "schema"],
  ["a revision without findings", JSON.stringify({ verdict: "revise", findings: [] }), "schema"],
  ["too many findings", JSON.stringify({ verdict: "revise", findings: Array(6).fill(finding) }), "schema"],
  ["wrong field types", '{"verdict":"pass","findings":"none"}', "schema"],
  ["an empty correction", JSON.stringify({ verdict: "revise", findings: [{ ...finding, requestedChange: " " }] }), "schema"],
  ["unsupported control fields", JSON.stringify({ ...pass, proposalRequested: true }), "schema"],
] as const) {
  test(`rejects ${name} with a typed failure`, () => {
    const result = parseResourceArchitectReview(source);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.error.kind, kind);
  });
}

test("generates a provider schema from the same validated review contract", () => {
  assert.equal(resourceArchitectReviewSchema.safeParse(revision).success, true);
  assert.ok(RESOURCE_ARCHITECT_REVIEW_OUTPUT_SCHEMA);
  assert.equal(RESOURCE_ARCHITECT_REVIEW_OUTPUT_SCHEMA.type, "object");
  assert.doesNotMatch(JSON.stringify(RESOURCE_ARCHITECT_REVIEW_OUTPUT_SCHEMA), /"oneOf"/u);
  assert.match(JSON.stringify(RESOURCE_ARCHITECT_REVIEW_OUTPUT_SCHEMA), /requestedChange/u);
});

test("accepts content-free phase diagnostics and refuses private payloads", () => {
  const diagnostics = {
    reviewStatus: "completed",
    reviewerId: "reviewer-of-agent-architect",
    requestedReviewer: { provider: "codex", model: "review-model" },
    actualReviewer: { provider: "codex", model: "review-model" },
    defaultFallbackAttempted: false,
    phases: [{ phase: "review", provider: "codex", model: "review-model", durationMs: 12,
      startOffsetMs: 15, firstProviderEventMs: 1, firstTextMs: 2, outcome: "success" }],
  };
  assert.deepEqual(resourceArchitectFeedbackDiagnosticsSchema.parse(diagnostics), diagnostics);
  assert.equal(resourceArchitectFeedbackDiagnosticsSchema.safeParse({ ...diagnostics, draft: "private" }).success, false);
  assert.equal(resourceArchitectFeedbackDiagnosticsSchema.safeParse({ ...diagnostics, diagnosticCode: "raw error with secret" }).success, false);
  assert.equal(resourceArchitectFeedbackDiagnosticsSchema.safeParse({ ...diagnostics, phases: [{ ...diagnostics.phases[0], prompt: "private" }] }).success, false);
});

for (const [status, fallback, expected] of [
  ["disabled", false, ["Review disabled. Reviewer of Agent Architect was not used."]],
  ["not_reviewed", false, ["Not reviewed. Reviewer of Agent Architect could not complete review."]],
  ["completed", true, ["Reviewer of Agent Architect used the application default after its configured model was unavailable."]],
  ["completed", false, []],
  ["pending", false, []],
] as const) {
  test(`restores ${status} review disclosure with fallback ${fallback}`, () => {
    const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse({
      reviewStatus: status,
      reviewerId: "reviewer-of-agent-architect",
      defaultFallbackAttempted: fallback,
      phases: [],
    });
    assert.deepEqual(resourceArchitectReviewWarnings(diagnostics), expected);
  });
}

test("a fallback reviewer too small for the request is disclosed after the configured reviewer was asked", () => {
  const diagnostics = resourceArchitectFeedbackDiagnosticsSchema.parse({
    reviewStatus: "not_reviewed",
    reviewerId: "reviewer-of-agent-architect",
    failureReason: "context_budget_exceeded",
    failedPhase: "review",
    defaultFallbackAttempted: true,
    phases: [],
  });
  assert.deepEqual(resourceArchitectReviewWarnings(diagnostics), [
    "Not reviewed. The configured model for Reviewer of Agent Architect was unavailable, and the complete request would not fit the application default's context window, so the application default was not asked.",
  ]);
});
