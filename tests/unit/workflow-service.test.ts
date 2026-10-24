import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ServiceError } from "../../services/service-errors.js";
import {
  deleteWorkflowById,
  listWorkflowEntries,
  readWorkflowYaml,
  saveGeneratedWorkflow,
  updateWorkflowYaml,
  validateWorkflowYaml,
} from "../../services/workflow-service.js";
import { parseWorkflowRegistry } from "../../workflows/loader.js";
import { withFileMutationLock } from "../../core/file-mutation.js";

function withTempRepo(fn: (repoRoot: string) => void | Promise<void>): Promise<void> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-service-"));
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
}

function writeWorkflowRepo(repoRoot: string): {
  registryPath: string;
  templatePath: string;
} {
  const workflowsDir = path.join(repoRoot, "workflows");
  const templatesDir = path.join(workflowsDir, "templates");
  const teamDir = path.join(repoRoot, "teams", "sample-team");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.mkdirSync(teamDir, { recursive: true });

  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    `sample-team:
  type: team
  description: Sample team.
  team_path: ./teams/sample-team
`,
  );
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    `team:
  name: sample-team
  description: Sample team.
  version: "0.1.0"

agents: []
levels: []
`,
  );

  const registryPath = path.join(workflowsDir, "registry.yaml");
  const templatePath = path.join(templatesDir, "existing.yaml");
  fs.writeFileSync(
    registryPath,
    `existing-workflow:
  description: Existing workflow.
  template_path: ./templates/existing.yaml
  tags:
    - saved
  capabilities:
    - write
`,
  );
  fs.writeFileSync(
    templatePath,
    `workflow:
  id: existing-workflow
  description: Existing workflow.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`,
  );

  return { registryPath, templatePath };
}

test("workflow service lists and reads workflow YAML through the registry", async () => {
  await withTempRepo(async (repoRoot) => {
    const { registryPath } = writeWorkflowRepo(repoRoot);

    const workflows = listWorkflowEntries(registryPath);
    const detail = await readWorkflowYaml({
      registryPath,
      workflowId: "existing-workflow",
    });

    assert.deepEqual(workflows, [
      {
        id: "existing-workflow",
        description: "Existing workflow.",
        tags: ["saved"],
        capabilities: ["write"],
      },
    ]);
    assert.match(detail.yaml, /id: existing-workflow/);
    assert.deepEqual(detail.stages, [
      {
        id: "write",
        team: "sample-team",
        inputArtifact: "incoming-brief.md",
        resultArtifact: "final-draft.md",
      },
    ]);
  });
});

test("workflow detail projects configured discussion rounds for the run workspace", async () => {
  await withTempRepo(async (repoRoot) => {
    const { registryPath, templatePath } = writeWorkflowRepo(repoRoot);
    fs.writeFileSync(
      templatePath,
      `workflow:
  id: existing-workflow
  input:
    artifact: incoming-request.md
  steps:
    - id: discuss
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: discussion.md
      runtime_overrides:
        levels:
          board:
            discussion:
              participants:
                - contrarian
                - pragmatist
              min_rounds: 2
              max_rounds: 3
  output:
    from_step: discuss
    artifact: discussion.md
`,
    );

    const detail = await readWorkflowYaml({
      registryPath,
      workflowId: "existing-workflow",
    });

    assert.deepEqual(detail.stages[0]?.discussions, [
      {
        levelId: "board",
        participants: ["contrarian", "pragmatist"],
        minRounds: 2,
        maxRounds: 3,
      },
    ]);
  });
});

test("workflow service validates and updates an existing workflow", async () => {
  await withTempRepo(async (repoRoot) => {
    const { registryPath, templatePath } = writeWorkflowRepo(repoRoot);

    const result = await updateWorkflowYaml({
      repoRootPath: repoRoot,
      registryPath,
      workflowId: "existing-workflow",
      yaml: `workflow:
  id: renamed-workflow
  description: Renamed workflow.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`,
    });

    assert.equal(result.workflowId, "renamed-workflow");
    assert.equal(result.yamlPath, templatePath);
    assert.match(fs.readFileSync(templatePath, "utf8"), /id: renamed-workflow/);
    assert.match(fs.readFileSync(registryPath, "utf8"), /^renamed-workflow:/m);
  });
});

test("workflow service returns typed validation and missing-workflow errors", async () => {
  await withTempRepo(async (repoRoot) => {
    const { registryPath } = writeWorkflowRepo(repoRoot);

    const validation = validateWorkflowYaml({
      repoRootPath: repoRoot,
      yaml: `workflow:
  id: invalid-workflow
  description: Invalid workflow.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: missing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`,
    });

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /missing-team/);

    await assert.rejects(
      () =>
        deleteWorkflowById({
          registryPath,
          workflowId: "missing-workflow",
        }),
      (error) =>
        error instanceof ServiceError &&
        error.code === "not_found" &&
        /missing-workflow/.test(error.message),
    );
  });
});

test("workflow service saves generated workflow output with validation", async () => {
  await withTempRepo(async (repoRoot) => {
    writeWorkflowRepo(repoRoot);

    const result = await saveGeneratedWorkflow({
      repoRootPath: repoRoot,
      body: {
        filename: "fresh workflow",
        yaml: `workflow:
  id: fresh-workflow
  description: Fresh workflow.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`,
      },
    });

    assert.equal(result.workflowId, "fresh-workflow");
    assert.equal(result.filename, "fresh-workflow.yaml");
    assert.equal(fs.existsSync(result.yamlPath), true);
  });
});

test("workflow service honors a custom registry and rejects non-idempotent collisions", async () => {
  await withTempRepo(async (repoRoot) => {
    writeWorkflowRepo(repoRoot);
    const customRegistry = path.join(repoRoot, "custom-workflows", "registry.yaml");
    fs.mkdirSync(path.dirname(customRegistry), { recursive: true });
    fs.writeFileSync(customRegistry, "");
    const yaml = `workflow:
  id: collision-safe
  description: Original workflow.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`;

    const first = await saveGeneratedWorkflow({
      repoRootPath: repoRoot,
      workflowsRegistryPath: customRegistry,
      body: { yaml },
    });
    const retry = await saveGeneratedWorkflow({
      repoRootPath: repoRoot,
      workflowsRegistryPath: customRegistry,
      body: { yaml },
    });

    assert.equal(first.registryPath, customRegistry);
    assert.equal(retry.yamlPath, first.yamlPath);
    assert.equal(path.dirname(first.yamlPath), path.join(path.dirname(customRegistry), "user-generated"));
    assert.equal(parseWorkflowRegistry(customRegistry).entries.length, 1);
    fs.writeFileSync(customRegistry, "");
    await saveGeneratedWorkflow({
      repoRootPath: repoRoot,
      workflowsRegistryPath: customRegistry,
      body: { yaml },
    });
    assert.equal(parseWorkflowRegistry(customRegistry).entries.length, 1);
    const original = fs.readFileSync(first.yamlPath, "utf8");

    await assert.rejects(
      () =>
        saveGeneratedWorkflow({
          repoRootPath: repoRoot,
          workflowsRegistryPath: customRegistry,
          body: { yaml: yaml.replace("Original workflow.", "Different workflow.") },
        }),
      (error) =>
        error instanceof ServiceError &&
        error.code === "conflict" &&
        /already exists/.test(error.message),
    );
    assert.equal(fs.readFileSync(first.yamlPath, "utf8"), original);
  });
});

test("workflow service preserves concurrent registry additions and rejects racing collisions", async () => {
  await withTempRepo(async (repoRoot) => {
    writeWorkflowRepo(repoRoot);
    const registryPath = path.join(repoRoot, "workflows", "registry.yaml");
    fs.writeFileSync(registryPath, "");
    const yamlFor = (id: string, description: string) => `workflow:
  id: ${id}
  description: ${description}
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`;

    await Promise.all([
      saveGeneratedWorkflow({
        repoRootPath: repoRoot,
        workflowsRegistryPath: registryPath,
        body: { yaml: yamlFor("concurrent-one", "First workflow.") },
      }),
      saveGeneratedWorkflow({
        repoRootPath: repoRoot,
        workflowsRegistryPath: registryPath,
        body: { yaml: yamlFor("concurrent-two", "Second workflow.") },
      }),
    ]);
    assert.deepEqual(
      parseWorkflowRegistry(registryPath).entries.map((entry) => entry.name).sort(),
      ["concurrent-one", "concurrent-two"],
    );

    const collisionResults = await Promise.allSettled([
      saveGeneratedWorkflow({
        repoRootPath: repoRoot,
        workflowsRegistryPath: registryPath,
        body: { yaml: yamlFor("racing-id", "Winning candidate one.") },
      }),
      saveGeneratedWorkflow({
        repoRootPath: repoRoot,
        workflowsRegistryPath: registryPath,
        body: { yaml: yamlFor("racing-id", "Winning candidate two.") },
      }),
    ]);
    assert.equal(
      collisionResults.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = collisionResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(
      rejected?.reason instanceof ServiceError &&
      rejected.reason.code === "conflict",
    );
    assert.equal(
      parseWorkflowRegistry(registryPath).entries.filter(
        (entry) => entry.name === "racing-id",
      ).length,
      1,
    );
  });
});

test("workflow save cancellation stops before registry mutation and retry repairs the orphan", async () => {
  await withTempRepo(async (repoRoot) => {
    writeWorkflowRepo(repoRoot);
    const registryPath = path.join(repoRoot, "workflows", "registry.yaml");
    fs.writeFileSync(registryPath, "");
    let releaseRegistry!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const blocker = withFileMutationLock(registryPath, async () => {
      markLocked();
      await new Promise<void>((resolve) => {
        releaseRegistry = resolve;
      });
    });
    await locked;
    const controller = new AbortController();
    const yaml = `workflow:
  id: cancelled-save
  description: Cancelled registry write.
  input:
    artifact: incoming-request.md
  steps:
    - id: write
      type: team
      team: sample-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_blocked: stop
  on_failed: stop
`;
    const saving = saveGeneratedWorkflow({
      repoRootPath: repoRoot,
      workflowsRegistryPath: registryPath,
      body: { yaml },
      signal: controller.signal,
    });
    const orphanPath = path.join(
      path.dirname(registryPath),
      "user-generated",
      "cancelled-save.yaml",
    );
    for (let attempt = 0; attempt < 100 && !fs.existsSync(orphanPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(fs.existsSync(orphanPath), true);
    controller.abort();
    releaseRegistry();
    await blocker;
    await assert.rejects(saving, /aborted/i);
    assert.deepEqual(parseWorkflowRegistry(registryPath).entries, []);

    await saveGeneratedWorkflow({
      repoRootPath: repoRoot,
      workflowsRegistryPath: registryPath,
      body: { yaml },
    });
    assert.deepEqual(
      parseWorkflowRegistry(registryPath).entries.map((entry) => entry.name),
      ["cancelled-save"],
    );
  });
});
