import assert from "node:assert/strict";
import test from "node:test";

import { shouldReturnCancelledResourceArchitectTurn } from "../../server/routes/resource-architect.js";

test("cancellation does not hide a proposal that crossed the durable commit boundary", () => {
  assert.equal(shouldReturnCancelledResourceArchitectTurn({
    cancelled: true,
    result: {
      operation: "proposal",
      outcome: {
        id: "committed-plan",
        kind: "standalone_agents",
        agents: [],
      },
    },
  }), false);
});

test("cancellation still wins before a plan is committed", () => {
  assert.equal(shouldReturnCancelledResourceArchitectTurn({
    cancelled: true,
    result: {
      operation: "conversation",
    },
  }), true);
  assert.equal(shouldReturnCancelledResourceArchitectTurn({
    cancelled: true,
    result: {
      operation: "proposal",
      outcome: { kind: "discussion" },
    },
  }), true);
});
