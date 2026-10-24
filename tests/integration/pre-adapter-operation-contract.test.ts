import test from "node:test";
import assert from "node:assert/strict";

import {
  getOperation,
  listOperations,
  operationCatalog,
} from "../../services/operation-catalog.js";
import { hasOperationHandler as hasExecutableOperationHandler } from "../../services/operation-registry.js";

test("pre-adapter operation catalog has stable unique operation ids", () => {
  const ids = operationCatalog.map((operation) => operation.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const operation of operationCatalog) {
    assert.match(operation.id, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
    assert.ok(operation.summary.length > 0);
    if ("http" in operation && operation.http) {
      assert.match(operation.http.path, /^\//);
    }
  }
});

test("pre-adapter operation catalog covers core CRUD surfaces", () => {
  const ids = new Set<string>(operationCatalog.map((operation) => operation.id));

  for (const id of [
    "workflows.list",
    "workflows.read",
    "workflows.update",
    "workflows.delete",
    "teamBuilder.teams.list",
    "teamBuilder.teams.create",
    "teamBuilder.teams.read",
    "teamBuilder.teams.update",
    "teamBuilder.teams.delete",
    "runOrchestrator.plan",
    "runOrchestrator.apply",
    "runOrchestrator.message",
    "runOrchestrator.status",
    "runOrchestrator.cancel",
    "agents.list",
    "agents.read",
    "agents.commit",
    "agents.delete",
    "sessions.list",
    "sessions.create",
    "sessions.read",
    "sessions.rename",
    "sessions.delete",
    "projects.list",
    "projects.create",
    "projects.read",
    "projects.update",
    "projects.delete",
    "projects.sessions.list",
    "projects.sessions.assign",
    "projects.sessions.remove",
    "projects.brief.read",
    "projects.brief.update",
    "projects.files.list",
    "projects.files.upload",
    "projects.files.read",
    "projects.files.delete",
    "projects.catalog.read",
    "projects.catalog.session.read",
    "projects.memory.list",
    "projects.memory.propose",
    "projects.memory.approve",
    "projects.memory.reject",
    "projects.export",
    "tasks.list",
    "tasks.create",
    "tasks.read",
    "tasks.delete",
  ]) {
    assert.ok(ids.has(id), `missing operation: ${id}`);
  }
});

test("pre-adapter operation catalog can be filtered and addressed by adapters", () => {
  const teamBuilderOperations = listOperations("teamBuilder");
  assert.deepEqual(
    teamBuilderOperations.map((operation) => operation.group),
    Array.from({ length: teamBuilderOperations.length }, () => "teamBuilder"),
  );

  assert.equal(
    getOperation("workflowGenerator.jobs.cancel").http?.path,
    "/create/jobs/{jobId}/cancel",
  );
});

test("pre-adapter operation registry exposes executable orchestrator handlers", () => {
  for (const id of [
    "runOrchestrator.plan",
    "runOrchestrator.apply",
    "runOrchestrator.message",
    "runOrchestrator.status",
    "runOrchestrator.cancel",
  ] as const) {
    assert.equal(hasExecutableOperationHandler(id), true, `missing handler: ${id}`);
  }
});
