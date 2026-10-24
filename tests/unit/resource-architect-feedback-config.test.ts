import assert from "node:assert/strict";
import test from "node:test";
import { parseResourceArchitectFeedbackConfig } from "../../domains/resource-architect/resource-architect-feedback-config.js";

for (const [name, environment, enabled] of [
  ["unset", {}, true],
  ["true", { PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "true" }, true],
  ["false", { PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" }, false],
] as const) {
  test(`review is ${enabled ? "enabled" : "disabled"} when the setting is ${name}`, () => {
    assert.deepEqual(parseResourceArchitectFeedbackConfig(environment), { reviewEnabled: enabled });
  });
}

for (const value of ["", "TRUE", "0", "yes", true, false, 1, null]) {
  test(`rejects invalid review setting ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => parseResourceArchitectFeedbackConfig({ PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: value }),
      /PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED/u,
    );
  });
}
