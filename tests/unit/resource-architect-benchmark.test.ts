import assert from "node:assert/strict";
import test from "node:test";

import {
  createResourceArchitectBenchmarkFixtures,
  selectResourceArchitectBenchmarkFixtures,
  summarizeResourceArchitectBenchmark,
} from "../../scripts/benchmark-resource-architect-turn.js";

test("resource architect benchmark covers the five decision fixtures", () => {
  const fixtures = createResourceArchitectBenchmarkFixtures();

  assert.deepEqual(fixtures.map((fixture) => fixture.id), [
    "greeting",
    "clarification",
    "exact-id",
    "proposal",
    "document-grounded",
  ]);
  assert.equal(fixtures.find((fixture) => fixture.id === "proposal")?.operation, "proposal");
  assert.ok(fixtures.find((fixture) => fixture.id === "document-grounded")?.document);
});

test("resource architect benchmark can rerun one failed fixture", () => {
  assert.deepEqual(
    selectResourceArchitectBenchmarkFixtures("document-grounded").map((fixture) => fixture.id),
    ["document-grounded"],
  );
  assert.throws(
    () => selectResourceArchitectBenchmarkFixtures("missing-fixture"),
    /Unknown benchmark fixture/,
  );
});

test("resource architect benchmark reports median and p95 without hiding failures", () => {
  const report = summarizeResourceArchitectBenchmark({
    mode: "current",
    sourceRevision: "test-revision",
    repetitions: 3,
    samples: [
      { fixture: "greeting", repetition: 1, status: 200, httpDurationMs: 30, processSpawnMs: 3, firstProviderEventMs: 8 },
      { fixture: "greeting", repetition: 2, status: 200, httpDurationMs: 10, processSpawnMs: 1, firstProviderEventMs: 4 },
      { fixture: "greeting", repetition: 3, status: 500, httpDurationMs: 20, error: "failed" },
    ],
  });

  assert.equal(report.summary[0]?.httpDurationMs?.median, 20);
  assert.equal(report.summary[0]?.httpDurationMs?.p95, 30);
  assert.equal(report.summary[0]?.successes, 2);
  assert.equal(report.summary[0]?.failures, 1);
  assert.equal(report.summary[0]?.processSpawnMs?.median, 2);
  assert.equal(report.summary[0]?.firstProviderEventMs?.median, 6);
});

test("resource architect benchmark uses the midpoint median for two samples", () => {
  const report = summarizeResourceArchitectBenchmark({
    mode: "baseline",
    sourceRevision: "test-revision",
    repetitions: 2,
    samples: [
      { fixture: "greeting", repetition: 1, status: 200, httpDurationMs: 10 },
      { fixture: "greeting", repetition: 2, status: 200, httpDurationMs: 30 },
    ],
  });

  assert.equal(report.summary[0]?.httpDurationMs?.median, 20);
});
