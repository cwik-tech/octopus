/**
 * What a build reports about a team it started but never published.
 *
 * A Team shell exists from the first moment of the build and is not a team
 * anybody can use: it has no roster, it cannot satisfy its own completion gate,
 * and it is deliberately hidden from every catalog until publication. The job
 * receipt is what the card reads, so a receipt that says "created" and selects
 * that shell tells the user their team is ready and offers to open something
 * that will fail the moment they run it.
 *
 * The shell's identity is still recorded — retry and discard both need to know
 * which shell this build made — but identity is not an outcome.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  PersistedResourceArchitectPlan,
} from "../../contracts/resource-architect-persisted.js";
import type { ResourceBuildJobSnapshot } from "../../contracts/resource-architect.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import {
  createResourceBuildSnapshot,
  reconcileInterruptedResourceBuilds,
  runResourceBuild,
} from "../../services/resource-architect-service.js";
import { isTeamBuilding, listPublishedTeams } from "../../domains/agent-generator/team-manager.js";

const PLAN_ID = "plan-shell";
const TEAM_ID = "shell-team";

function teamPlan(): Extract<PersistedResourceArchitectPlan, { kind: "team" }> {
  return {
    id: PLAN_ID,
    kind: "team",
    team: {
      teamId: TEAM_ID,
      description: "Never finished.",
      tags: [],
      existingAgents: [
        { name: "alpha", role: "Writer", rationale: "Available." },
        { name: "beta", role: "Checker", rationale: "Available." },
      ],
      newAgents: [],
      questionsResolved: [],
      shape: {
        kind: "chain",
        rationale: "Sequential.",
        depth: "quick",
        order: ["alpha", "beta"],
      },
    },
  };
}

function makeRepo(agents: readonly string[]): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "incomplete-shell-"));
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  for (const name of agents) {
    const agentDir = path.join(repoRoot, "agents", name);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${name}.\ntier: strategic\n---\n\n# ${name}\n`,
    );
  }
  return repoRoot;
}

/** A store that announces each durable job write, so nothing waits on a clock. */
class ObservedStore extends ResourceArchitectStore {
  private readonly watchers = new Set<(job: ResourceBuildJobSnapshot) => void>();

  override async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    await super.saveJob(job);
    for (const watcher of [...this.watchers]) watcher(structuredClone(job));
  }

  /** Resolves the first time a written job satisfies `matches`. */
  whenJob(
    matches: (job: ResourceBuildJobSnapshot) => boolean,
  ): Promise<ResourceBuildJobSnapshot> {
    return new Promise<ResourceBuildJobSnapshot>((resolve) => {
      const watcher = (job: ResourceBuildJobSnapshot): void => {
        if (!matches(job)) return;
        this.watchers.delete(watcher);
        resolve(job);
      };
      this.watchers.add(watcher);
    });
  }
}

test("a build cancelled after its shell exists does not report the shell as created", async () => {
  const repoRoot = makeRepo(["alpha", "beta"]);
  const workspacePath = path.join(repoRoot, "workspace");
  try {
    const store = new ObservedStore(workspacePath);
    const plan = teamPlan();
    await store.savePlan(plan);
    const job = createResourceBuildSnapshot({ plan, jobId: "job-cancelled" });
    const controller = new AbortController();
    // Cancelled the moment the shell is recorded, which is the window this is
    // about: the team exists, and nothing has been added to it.
    const shellRecorded = store.whenJob((written) =>
      written.events.some((event) => event.type === "team_created"),
    );
    void shellRecorded.then(() => controller.abort());

    await runResourceBuild({
      repoRoot,
      plan,
      job,
      store,
      signal: controller.signal,
    });

    const saved = await store.getJob("job-cancelled");
    assert.ok(saved, "the build must leave a record");
    assert.equal(saved.status, "cancelled", JSON.stringify(saved));
    // The outcome the card reads, stated rather than merely not claimed: an
    // item left at "generating" describes a build that is still going.
    assert.equal(saved.items[0]?.status, "cancelled", JSON.stringify(saved.items));
    assert.equal(saved.selectedResource, null, JSON.stringify(saved.selectedResource));
    // Its identity is kept, because retry and discard both need to know which
    // shell this build made.
    assert.deepEqual(saved.items[0]?.resource, { kind: "team", id: TEAM_ID });

    // And the shell itself is still unpublished and out of every catalog.
    assert.equal(isTeamBuilding(repoRoot, TEAM_ID), true);
    assert.deepEqual(listPublishedTeams(repoRoot).map((team) => team.id), []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a build interrupted after its shell exists recovers without claiming a team", async () => {
  const repoRoot = makeRepo(["alpha", "beta"]);
  const workspacePath = path.join(repoRoot, "workspace");
  try {
    const store = new ObservedStore(workspacePath);
    const plan = teamPlan();
    await store.savePlan(plan);
    const job = createResourceBuildSnapshot({ plan, jobId: "job-interrupted" });
    const controller = new AbortController();
    const shellRecorded = store.whenJob((written) =>
      written.events.some((event) => event.type === "team_created"),
    );
    void shellRecorded.then(() => controller.abort());
    await runResourceBuild({ repoRoot, plan, job, store, signal: controller.signal });

    // What the disk looked like when the API stopped: the shell exists and the
    // receipt still says the build is running.
    const interrupted = await store.getJob("job-interrupted");
    assert.ok(interrupted);
    await store.saveJob({
      ...interrupted,
      status: "running",
      items: interrupted.items.map((item) => ({ ...item, status: "generating" as const })),
      selectedResource: null,
    });

    // A second process over the same files.
    const cold = new ResourceArchitectStore(workspacePath);
    const [recovered] = await reconcileInterruptedResourceBuilds({
      repoRoot,
      store: cold,
      isActive: () => false,
    });

    assert.ok(recovered);
    assert.equal(recovered.status, "interrupted", JSON.stringify(recovered));
    assert.equal(recovered.items[0]?.status, "interrupted", JSON.stringify(recovered.items));
    assert.equal(recovered.selectedResource, null, JSON.stringify(recovered.selectedResource));
    assert.deepEqual(recovered.items[0]?.resource, { kind: "team", id: TEAM_ID });
    assert.equal(isTeamBuilding(repoRoot, TEAM_ID), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
