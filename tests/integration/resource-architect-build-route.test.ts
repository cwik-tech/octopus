/**
 * What the build endpoint owns, and what it must give back when it fails.
 *
 * Starting a build takes two things before any work happens: a claim on the
 * plan, so two requests cannot apply it at once, and an entry in the job
 * registry, so the same job id cannot run twice. If anything between taking
 * them and launching the build fails, both have to go back — otherwise the
 * plan can never be applied again and the job id is permanently in use, with
 * no build running to release either.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ResourceArchitectPlan,
  ResourceBuildJobSnapshot,
} from "../../contracts/resource-architect.js";
import {
  CreateJobRegistry,
  type CreateJobStartResult,
} from "../../server/create-job-registry.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { handleResourceArchitectRoutes } from "../../server/routes/resource-architect.js";
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from "../../domains/provider/default-model-selection.js";

const PLAN_ID = "route-plan";
const JOB_ID = "route-job";

/** A store whose first job write fails, exactly once. */
class FailFirstSaveStore extends ResourceArchitectStore {
  private failed = false;
  saves = 0;
  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    this.saves += 1;
    if (!this.failed) {
      this.failed = true;
      throw new Error("job store is unavailable");
    }
    await super.saveJob(job);
  }
}

/**
 * A store whose first job write blocks the registry's state file, then fails.
 *
 * The build never launches, so the cleanup that follows is the only thing that
 * will ever finish the registry entry — and it runs while the registry cannot
 * persist anything, which is the case under test.
 */
class BlockRegistryStateStore extends ResourceArchitectStore {
  private failed = false;
  constructor(private readonly statePath: string) {
    super();
  }
  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      fs.rmSync(this.statePath, { force: true });
      fs.mkdirSync(this.statePath, { recursive: true });
      throw new Error("job store is unavailable");
    }
    await super.saveJob(job);
  }
}

/** A registry whose first `start` fails the way a state write can. */
class FailFirstStartRegistry extends CreateJobRegistry {
  private failed = false;
  override start(jobId: string): CreateJobStartResult {
    if (!this.failed) {
      this.failed = true;
      throw new Error("create job state could not be persisted");
    }
    return super.start(jobId);
  }
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "build-route-"));
  const teamDir = path.join(repoRoot, "teams", "resource-architect");
  const agentDir = path.join(repoRoot, "agents", "resource-architect");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      "  name: resource-architect",
      "agents:",
      "  - name: resource-architect",
      "    agent_file: ../../agents/resource-architect/resource-architect.md",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(agentDir, "resource-architect.md"),
    // The architect runs with its own agent file's pair.
    "---\nprovider: openai\nmodel: local-test-model\n---\n\n" + ("Design one workflow from the brief.\n"),
  );
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return repoRoot;
}

/**
 * An update plan whose Team is not registered.
 *
 * The build that follows a successful start therefore fails on its own
 * evidence, with no provider call, so this case observes the endpoint rather
 * than a generation.
 */
function makePlan(): ResourceArchitectPlan {
  return {
    id: PLAN_ID,
    kind: "resource_updates",
    operations: [{
      kind: "add_team_agents",
      target: { kind: "team", id: "a-team-that-is-not-registered" },
      expectedRevision:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      libraryAgentsToAdd: [],
      newAgentsToCreate: [],
    }],
  };
}

interface RouteHarness {
  url: string;
  registry: CreateJobRegistry;
  store: ResourceArchitectStore;
  repoRoot: string;
  close(): Promise<void>;
}

async function startRoute(options: {
  store: ResourceArchitectStore;
  registry: CreateJobRegistry;
}): Promise<RouteHarness> {
  const repoRoot = makeRepo();
  await options.store.savePlan(makePlan());
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleResourceArchitectRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: repoRoot,
        createJobRegistry: options.registry,
        resourceArchitectStore: options.store,
        isAbortLike: () => false,
      },
    }).then(
      (handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end();
      },
      (error: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    registry: options.registry,
    store: options.store,
    repoRoot,
    close: () =>
      new Promise<void>((resolve, reject) => {
        options.registry.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }).finally(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }),
  };
}

/** Posts one build request and reads its body exactly once. */
async function startBuildRequest(
  url: string,
  modelChoice: { provider: string; model: string } | undefined = undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/create/resource-architect/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId: PLAN_ID, jobId: JOB_ID, ...modelChoice }),
  });
  const parsed: unknown = await response.json();
  assert.ok(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    "the endpoint answered with a JSON object",
  );
  return { status: response.status, body: { ...parsed } };
}

/** One string field of a response body, without assuming it is there. */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

test("an unresolved inherited model starts no build, and an explicit choice can recover", async () => {
  const previousDefault = getRuntimeDefaultModelState();
  const harness = await startRoute({ store: new ResourceArchitectStore(), registry: new CreateJobRegistry() });
  try {
    setRuntimeDefaultModelState({ status: "unset" });
    fs.writeFileSync(path.join(harness.repoRoot, "agents/resource-architect/resource-architect.md"), "Design a team.\n");
    const refused = await startBuildRequest(harness.url);
    assert.notEqual(refused.status, 202, "no job should be admitted without a runnable authoring pair");
    assert.equal(await harness.store.getPlanAdmission(PLAN_ID), null);
    assert.equal(harness.registry.isActive(JOB_ID), false);

    const chosen = await startBuildRequest(harness.url, { provider: "openai", model: "chosen-model" });
    assert.equal(chosen.status, 202, JSON.stringify(chosen.body));
    const replayed = await startBuildRequest(harness.url);
    assert.equal(replayed.status, 202, "an existing receipt does not need a new model selection");
  } finally {
    setRuntimeDefaultModelState(previousDefault);
    await harness.close();
  }
});

test("a build whose first job write fails can be started again", async () => {
  const harness = await startRoute({
    store: new FailFirstSaveStore(),
    registry: new CreateJobRegistry(),
  });
  try {
    const failed = await startBuildRequest(harness.url);

    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.match(
      stringField(failed.body, "error"),
      /job store is unavailable/u,
      "the failure the caller sees is the one that happened",
    );
    // No build is running under this job id: the entry was given back with the
    // response, not left behind for a build that never started.
    assert.equal(harness.registry.isActive(JOB_ID), false);

    // The same plan and the same job id are free again.
    const retried = await startBuildRequest(harness.url);

    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(stringField(retried.body, "jobId"), JOB_ID);
  } finally {
    await harness.close();
  }
});

test("a build whose registry entry cannot be recorded can be started again", async () => {
  const harness = await startRoute({
    store: new ResourceArchitectStore(),
    registry: new FailFirstStartRegistry(),
  });
  try {
    const failed = await startBuildRequest(harness.url);

    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.match(
      stringField(failed.body, "error"),
      /create job state could not be persisted/u,
      "the failure the caller sees is the one that happened",
    );
    assert.equal(harness.registry.isActive(JOB_ID), false);

    const retried = await startBuildRequest(harness.url);

    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(stringField(retried.body, "jobId"), JOB_ID);
  } finally {
    await harness.close();
  }
});

test("a job the registry cannot record as finished is still finished", async () => {
  const registryWorkspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "build-route-registry-"),
  );
  const statePath = path.join(registryWorkspace, "create-jobs", "state.json");
  const registry = new CreateJobRegistry({ workspacePath: registryWorkspace });
  const harness = await startRoute({
    store: new BlockRegistryStateStore(statePath),
    registry,
  });
  try {
    const failed = await startBuildRequest(harness.url);

    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.match(stringField(failed.body, "error"), /job store is unavailable/u);
    assert.equal(
      fs.statSync(statePath).isDirectory(),
      true,
      "fixture check: the registry could not persist while it was being finished",
    );
    // The build is over and no build is running under this id. A registry that
    // put the entry back because it could not write the file would leave a job
    // nothing can finish and nothing can retry.
    assert.equal(registry.isActive(JOB_ID), false);

    // With the state file writable again, the same plan and job id start.
    fs.rmSync(statePath, { recursive: true, force: true });
    const retried = await startBuildRequest(harness.url);

    assert.equal(retried.status, 202, JSON.stringify(retried.body));
    assert.equal(stringField(retried.body, "jobId"), JOB_ID);
  } finally {
    await harness.close();
    fs.rmSync(registryWorkspace, { recursive: true, force: true });
  }
});
