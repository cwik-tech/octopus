import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workflow-api-contract-"));
}

function writeWorkflowRepo(repoRoot: string): string {
  fs.mkdirSync(path.join(repoRoot, "teams", "sample-team"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "workflows", "templates"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      "sample-team:",
      "  type: team",
      "  description: Sample team.",
      "  team_path: ./teams/sample-team",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams", "sample-team", "team.yaml"),
    [
      "team:",
      "  name: sample-team",
      "  description: Sample team.",
      "agents: []",
      "levels: []",
      "",
    ].join("\n"),
  );

  const registryPath = path.join(repoRoot, "workflows", "registry.yaml");
  fs.writeFileSync(
    registryPath,
    [
      "existing-workflow:",
      "  description: Existing workflow.",
      "  template_path: ./templates/existing.yaml",
      "  tags:",
      "    - saved",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "workflows", "templates", "existing.yaml"),
    workflowYaml("existing-workflow", "Existing workflow."),
  );
  return registryPath;
}

function workflowYaml(id: string, description: string): string {
  return [
    "workflow:",
    `  id: ${id}`,
    `  description: ${description}`,
    "  input:",
    "    artifact: incoming-request.md",
    "  steps:",
    "    - id: write",
    "      type: team",
    "      team: sample-team",
    "      input_artifact: incoming-brief.md",
    "      result_artifact: final-draft.md",
    "  output:",
    "    from_step: write",
    "    artifact: final-draft.md",
    "  on_blocked: stop",
    "  on_failed: stop",
    "",
  ].join("\n");
}

async function withWorkflowServer(
  fn: (base: string, repoRoot: string, registryPath: string) => Promise<void>,
): Promise<void> {
  const workspacePath = makeWorkspace();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-api-repo-"));
  const registryPath = writeWorkflowRepo(repoRoot);
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    repoRootPath: repoRoot,
    workflowsRegistryPath: registryPath,
  });

  try {
    await fn(server.url, repoRoot, registryPath);
  } finally {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("workflow API contract covers CRUD, validation, save, teams, and cancellation", async () => {
  await withWorkflowServer(async (base, _repoRoot, registryPath) => {
    const listResponse = await fetch(`${base}/workflows`);
    const listPayload = (await listResponse.json()) as {
      workflows: Array<{ id: string; description: string; tags?: string[] }>;
    };
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listPayload.workflows, [
      {
        id: "existing-workflow",
        description: "Existing workflow.",
        tags: ["saved"],
      },
    ]);

    const readResponse = await fetch(`${base}/workflows/existing-workflow`);
    const readPayload = (await readResponse.json()) as { yaml: string };
    assert.equal(readResponse.status, 200);
    assert.match(readPayload.yaml, /id: existing-workflow/);

    const updateResponse = await fetch(`${base}/workflows/existing-workflow`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        yaml: workflowYaml("renamed-workflow", "Renamed workflow."),
      }),
    });
    const updatePayload = (await updateResponse.json()) as {
      workflowId: string;
      warnings: string[];
    };
    assert.equal(updateResponse.status, 200);
    assert.equal(updatePayload.workflowId, "renamed-workflow");
    assert.deepEqual(updatePayload.warnings, []);

    const validateResponse = await fetch(`${base}/create/validate-yaml`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        yaml: workflowYaml("validated-workflow", "Validated workflow."),
      }),
    });
    const validatePayload = (await validateResponse.json()) as {
      valid: boolean;
      errors: string[];
    };
    assert.equal(validateResponse.status, 200);
    assert.equal(validatePayload.valid, true);
    assert.deepEqual(validatePayload.errors, []);

    const saveResponse = await fetch(`${base}/create/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "fresh-workflow",
        yaml: workflowYaml("fresh-workflow", "Fresh workflow."),
      }),
    });
    const savePayload = (await saveResponse.json()) as { workflowId: string };
    assert.equal(saveResponse.status, 201);
    assert.equal(savePayload.workflowId, "fresh-workflow");

    const teamsResponse = await fetch(`${base}/create/teams`);
    const teamsPayload = (await teamsResponse.json()) as {
      teams: Array<{ id: string }>;
    };
    assert.equal(teamsResponse.status, 200);
    assert.deepEqual(
      teamsPayload.teams.map((team) => team.id),
      ["sample-team"],
    );

    const cancelResponse = await fetch(`${base}/create/jobs/job-1/cancel`, {
      method: "POST",
    });
    const cancelPayload = (await cancelResponse.json()) as {
      cancelled: boolean;
      status: string;
    };
    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelPayload.cancelled, true);
    assert.equal(cancelPayload.status, "pending");

    const deleteResponse = await fetch(`${base}/workflows/renamed-workflow`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 204);
    assert.doesNotMatch(fs.readFileSync(registryPath, "utf8"), /renamed-workflow/);
  });
});

test("workflow API contract maps service validation errors to JSON responses", async () => {
  await withWorkflowServer(async (base) => {
    const response = await fetch(`${base}/create/validate-yaml`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yaml: 123 }),
    });
    const payload = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Field yaml is required and must be a string");
  });
});
