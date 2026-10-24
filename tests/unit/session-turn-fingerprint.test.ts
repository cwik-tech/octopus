import test from "node:test";
import assert from "node:assert/strict";

import { receptionistRequestFingerprint } from "../../services/session-service.js";
import type { SessionMessageTarget } from "../../domains/sessions/session-dispatch.js";

/**
 * The digest a turn posted before dispatch targets existed carries on disk.
 *
 * Derived independently of production code: the recursively key-sorted JSON
 * `{"model":null,"projectContext":null,"provider":null,"text":"Summarise the
 * quarterly report"}` hashed with SHA-256. Frozen as a literal because it is a
 * compatibility boundary — every turn already persisted was fingerprinted this
 * way, and `classifyReceptionistReplay` rejects a turn id whose stored digest
 * disagrees with the recomputed one.
 */
const LEGACY_UNTARGETED_DIGEST =
  "c066ad941609136dc77bb6382073b4a48b41b5c42e50c0ac1214bfe64b20f074";
const LEGACY_TEXT = "Summarise the quarterly report";

const AGENTS_TARGET: SessionMessageTarget = {
  kind: "agents",
  agentNames: ["analyst"],
};

test("an untargeted turn keeps the digest it was persisted with before targets existed", () => {
  assert.equal(
    receptionistRequestFingerprint({ text: LEGACY_TEXT }),
    LEGACY_UNTARGETED_DIGEST,
  );
});

test("a caller whose optional target is absent still gets the legacy digest", () => {
  // Exactly how the dispatch service builds this argument: the key is spread
  // only when a target exists, never set to `undefined`.
  const absentTarget: SessionMessageTarget | undefined = undefined;
  assert.equal(
    receptionistRequestFingerprint({
      text: LEGACY_TEXT,
      ...(absentTarget ? { target: absentTarget } : {}),
    }),
    LEGACY_UNTARGETED_DIGEST,
  );
});

test("an explicit target makes the same text a different logical request", () => {
  assert.notEqual(
    receptionistRequestFingerprint({ text: LEGACY_TEXT, target: AGENTS_TARGET }),
    LEGACY_UNTARGETED_DIGEST,
  );
});

test("two different explicit targets never share one digest", () => {
  const toAnalyst = receptionistRequestFingerprint({
    text: LEGACY_TEXT,
    target: AGENTS_TARGET,
  });
  const toWriter = receptionistRequestFingerprint({
    text: LEGACY_TEXT,
    target: { kind: "agents", agentNames: ["writer"] },
  });
  const toTeam = receptionistRequestFingerprint({
    text: LEGACY_TEXT,
    target: { kind: "team", teamId: "problem-thinking-board" },
  });

  assert.notEqual(toAnalyst, toWriter);
  assert.notEqual(toAnalyst, toTeam);
  assert.notEqual(toWriter, toTeam);
});

test("roster order is part of a request's identity", () => {
  assert.notEqual(
    receptionistRequestFingerprint({
      text: LEGACY_TEXT,
      target: { kind: "agents", agentNames: ["analyst", "writer"] },
    }),
    receptionistRequestFingerprint({
      text: LEGACY_TEXT,
      target: { kind: "agents", agentNames: ["writer", "analyst"] },
    }),
  );
});

test("the same explicit target hashes stably across calls", () => {
  assert.equal(
    receptionistRequestFingerprint({ text: LEGACY_TEXT, target: AGENTS_TARGET }),
    receptionistRequestFingerprint({
      text: LEGACY_TEXT,
      target: { kind: "agents", agentNames: ["analyst"] },
    }),
  );
});

test("a Workflow target's plan expectation is not part of its identity", () => {
  // `expectedPlanId` is a compare-and-set precondition, not a different
  // request. Two retries of one submission may legitimately carry different
  // expectations after the plan advances, and both are the same turn.
  assert.equal(
    receptionistRequestFingerprint({
      text: LEGACY_TEXT,
      target: {
        kind: "workflow",
        workflowId: "discussion-to-writing3",
        expectedPlanId: null,
      },
    }),
    receptionistRequestFingerprint({
      text: LEGACY_TEXT,
      target: {
        kind: "workflow",
        workflowId: "discussion-to-writing3",
        expectedPlanId: "run-plan-9",
      },
    }),
  );
});
