import test from "node:test";
import assert from "node:assert/strict";

import { ServiceError } from "../../services/service-errors.js";
import {
  parseTeamBuilderAgentBody,
  parseTeamBuilderBody,
  readTeamBuilderTeamDetail,
} from "../../services/team-builder-service.js";

test("team-builder service parses team upsert input for non-HTTP callers", () => {
  const body = parseTeamBuilderBody({
    id: " sample-team ",
    description: " Sample team. ",
    tags: [" draft ", "", "public"],
  });

  assert.deepEqual(body, {
    id: "sample-team",
    description: "Sample team.",
    tags: ["draft", "public"],
  });
});

test("team-builder service parses roster-agent input for non-HTTP callers", () => {
  assert.deepEqual(
    parseTeamBuilderAgentBody({
      agentName: " alpha ",
      role: " Analyst ",
    }),
    {
      agentName: "alpha",
      role: "Analyst",
    },
  );
});

test("team-builder service refuses a roster write that names a grade", () => {
  // The same refusal the HTTP route gives, reached without HTTP: a caller that
  // sends a grade is told which field to remove rather than getting a success
  // for a setting that decides nothing.
  assert.throws(
    () => parseTeamBuilderAgentBody({ agentName: "alpha", tier: "strategic" }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      /Field tier is no longer supported/.test(error.message),
  );
});

test("team-builder service exposes typed validation errors", () => {
  assert.throws(
    () => parseTeamBuilderBody({ id: "sample", tags: "public" }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      error.message === "Field tags must be an array",
  );

  // A retired runtime setting must be refused, not quietly accepted.
  assert.throws(
    () =>
      parseTeamBuilderBody({
        id: "sample",
        models: { execution: { model: "gpt-5.4-mini" } },
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      /Field models is no longer supported/.test(error.message),
  );

  assert.throws(
    () =>
      parseTeamBuilderAgentBody({
        agentName: "alpha",
        provider: "anthropic",
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      /Field provider is no longer supported/.test(error.message),
  );
});

test("team-builder service maps manager failures to service errors", () => {
  assert.throws(
    () =>
      readTeamBuilderTeamDetail({
        repoRootPath: "/tmp/missing-team-builder-repo",
        teamId: "missing-team",
      }),
    (error) =>
      error instanceof ServiceError &&
      error.code === "bad_request" &&
      /Team not found: missing-team/.test(error.message),
  );
});
