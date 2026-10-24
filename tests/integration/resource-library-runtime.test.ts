import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deleteAgent } from "../../domains/agent-generator/delete-agent.js";
import { ResourceLibraryService } from "../../services/resource-library-service.js";
import type { ResourceSkillFiles } from "../../domains/resource-library/skill-files.js";

test("detach and Agent deletion retain the shared revision for the remaining Agent", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeAgent(fixture.repoRoot, "beta");
    writeSkill(fixture.repoRoot, "alpha", "Shared instructions");
    writeSkill(fixture.repoRoot, "beta", "Shared instructions");
    const service = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const initial = await service.getBrowserSnapshot();
    const skill = initial.skills.find((candidate) => candidate.slug === "research");
    assert.ok(skill);
    assert.equal(initial.agents.find((agent) => agent.id === "alpha")?.attachments[0]?.revisionId, skill.currentRevisionId);
    assert.equal(initial.agents.find((agent) => agent.id === "beta")?.attachments[0]?.revisionId, skill.currentRevisionId);

    await service.detachSkill({
      agentId: "alpha",
      alias: "research",
      expectedGeneration: initial.generation,
    });
    assert.equal(fs.existsSync(path.join(fixture.repoRoot, "agents", "alpha", "skills", "research")), false);
    assert.equal(
      fs.readFileSync(path.join(fixture.repoRoot, "agents", "beta", "skills", "research", "SKILL.md"), "utf8"),
      skillDocument("Shared instructions"),
    );

    await deleteAgent({ repoRoot: fixture.repoRoot, agentName: "alpha", deleteSkills: false });
    const restarted = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const snapshot = await restarted.getBrowserSnapshot();
    assert.ok(snapshot.skills.some((candidate) => candidate.id === skill.id));
    assert.equal(snapshot.agents.find((agent) => agent.id === "beta")?.attachments[0]?.revisionId, skill.currentRevisionId);
    assert.equal(snapshot.agents.some((agent) => agent.id === "alpha" && agent.attachments.length > 0), false);
  } finally {
    fixture.cleanup();
  }
});

test("revision selection projects exact bytes without moving other Agent pins", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeAgent(fixture.repoRoot, "beta");
    writeSkill(fixture.repoRoot, "alpha", "Original instructions");
    writeSkill(fixture.repoRoot, "beta", "Original instructions");
    const service = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const initial = await service.getBrowserSnapshot();
    const skill = initial.skills.find((candidate) => candidate.slug === "research");
    assert.ok(skill);
    const originalRevisionId = skill.currentRevisionId;
    const edited = await service.store.saveSkillRevision({
      skillId: skill.id,
      baseRevisionId: originalRevisionId,
      files: skillFiles("Updated instructions"),
      changeNote: "Update instructions",
      expectedGeneration: initial.generation,
    });

    await service.selectAgentSkillRevision({
      agentId: "alpha",
      skillId: skill.id,
      revisionId: edited.revision.id,
      expectedGeneration: initial.generation + 1,
    });

    assert.equal(
      fs.readFileSync(path.join(fixture.repoRoot, "agents", "alpha", "skills", "research", "SKILL.md"), "utf8"),
      skillDocument("Updated instructions"),
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.repoRoot, "agents", "beta", "skills", "research", "SKILL.md"), "utf8"),
      skillDocument("Original instructions"),
    );
    const snapshot = await service.getBrowserSnapshot();
    assert.equal(snapshot.agents.find((agent) => agent.id === "alpha")?.attachments[0]?.revisionId, edited.revision.id);
    assert.equal(snapshot.agents.find((agent) => agent.id === "beta")?.attachments[0]?.revisionId, originalRevisionId);
  } finally {
    fixture.cleanup();
  }
});

test("an admitted task retains its snapshot while the next task resolves the new revision", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeSkill(fixture.repoRoot, "alpha", "Original instructions");
    const scriptPath = path.join(fixture.repoRoot, "agents", "alpha", "skills", "research", "scripts", "run.mjs");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "old script\n");
    const service = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const initial = await service.getBrowserSnapshot();
    const skill = initial.skills.find((candidate) => candidate.slug === "research");
    assert.ok(skill);
    const admitted = await service.createTaskProjection({ scopeId: "task-1" });
    assert.equal(
      fs.readFileSync(path.join(admitted.rootPath, "agents", "alpha", "skills", "research", "scripts", "run.mjs"), "utf8"),
      "old script\n",
    );

    const editedFiles = new Map(skillFiles("Updated instructions"));
    editedFiles.set("scripts/run.mjs", {
      contents: Buffer.from("new script\n"),
      mode: 0o755,
      executable: true,
    });
    const edited = await service.store.saveSkillRevision({
      skillId: skill.id,
      baseRevisionId: skill.currentRevisionId,
      files: editedFiles,
      changeNote: "Update instructions",
      expectedGeneration: initial.generation,
    });
    await service.selectAgentSkillRevision({
      agentId: "alpha",
      skillId: skill.id,
      revisionId: edited.revision.id,
      expectedGeneration: initial.generation + 1,
    });

    const retry = await service.createTaskProjection({ scopeId: "task-1" });
    assert.equal(retry.rootPath, admitted.rootPath);
    assert.equal(
      fs.readFileSync(path.join(retry.rootPath, "agents", "alpha", "skills", "research", "scripts", "run.mjs"), "utf8"),
      "old script\n",
    );
    const subsequent = await service.createTaskProjection({ scopeId: "task-2" });
    assert.notEqual(subsequent.rootPath, admitted.rootPath);
    assert.equal(
      fs.readFileSync(path.join(subsequent.rootPath, "agents", "alpha", "skills", "research", "scripts", "run.mjs"), "utf8"),
      "new script\n",
    );

    const { loadAgent } = await import("../../parsers/load-agent.js");
    const { SkillLoaderService } = await import("../../services/skill-loader-service.js");
    const { createHash } = await import("node:crypto");
    const source = path.join(admitted.rootPath, "agents", "alpha", "skills", "research", "SKILL.md");
    const loadedAgent = loadAgent({
      name: "alpha",
      type: "agent",
      role: "test",
      agent_file: path.join(admitted.rootPath, "agents", "alpha", "alpha.md"),
    }, {
      team: { name: "test-team", description: "", version: "0.1.0" },
      workspace: { path: fixture.repoRoot, watch: false },
      levels: [],
      gates: [],
      agents: [],
    }, 0);
    assert.ok(loadedAgent);
    assert.equal(loadedAgent.skillsContent.includes(source), true);
    const loaded = await new SkillLoaderService({ repoRootPath: fixture.repoRoot }).execute(
      admitted.agentPaths.alpha ?? "missing-agent-path",
      {
        source,
        sha256: createHash("sha256").update(skillDocument("Original instructions")).digest("hex"),
      },
    );
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.content, skillDocument("Original instructions"));
  } finally {
    fixture.cleanup();
  }
});

test("detached task launch passes the immutable projection to the runner", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeSkill(fixture.repoRoot, "alpha", "Original instructions");
    const service = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const initial = await service.getBrowserSnapshot();
    const skill = initial.skills.find((candidate) => candidate.slug === "research");
    assert.ok(skill);
    const { FileSystemSessionStore } = await import("../../domains/sessions/session-store.js");
    const { launchSessionTask } = await import("../../services/task-service.js");
    const workspacePath = path.join(fixture.repoRoot, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const session = await sessionStore.createSession({ title: "Projected task" });
    const roots: string[] = [];
    const taskLauncher = {
      async startRun(request: import("../../domains/run/run-store.js").RunStartRequest) {
        roots.push(request.env?.TEAM_RUNTIME_REPO_ROOT ?? "missing-root");
        return { launched: true as const, pid: 0, cwd: request.cwd };
      },
    };
    const first = await launchSessionTask({
      sessionId: session.id,
      sessionStore,
      taskLauncher,
      repoRootPath: fixture.repoRoot,
      workspacePath,
      workflowId: "projected-workflow",
      briefMarkdown: "# Projected\n",
      resourceLibraryService: service,
    });
    assert.equal(first.ok, true);

    const edited = await service.store.saveSkillRevision({
      skillId: skill.id,
      baseRevisionId: skill.currentRevisionId,
      files: skillFiles("Updated instructions"),
      changeNote: "Update instructions",
      expectedGeneration: initial.generation,
    });
    await service.selectAgentSkillRevision({
      agentId: "alpha",
      skillId: skill.id,
      revisionId: edited.revision.id,
      expectedGeneration: initial.generation + 1,
    });
    const second = await launchSessionTask({
      sessionId: session.id,
      sessionStore,
      taskLauncher,
      repoRootPath: fixture.repoRoot,
      workspacePath,
      workflowId: "projected-workflow",
      briefMarkdown: "# Projected again\n",
      resourceLibraryService: service,
    });
    assert.equal(second.ok, true);
    assert.equal(roots.length, 2);
    const firstRoot = roots[0] ?? "missing-first";
    const secondRoot = roots[1] ?? "missing-second";
    assert.notEqual(firstRoot, secondRoot);
    assert.equal(
      fs.readFileSync(path.join(firstRoot, "agents", "alpha", "skills", "research", "SKILL.md"), "utf8"),
      skillDocument("Original instructions"),
    );
    assert.equal(
      fs.readFileSync(path.join(secondRoot, "agents", "alpha", "skills", "research", "SKILL.md"), "utf8"),
      skillDocument("Updated instructions"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("an admitted task survives Agent deletion and rejects corrupt retained supporting files", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeSkill(fixture.repoRoot, "alpha", "Original instructions");
    const script = path.join(fixture.repoRoot, "agents/alpha/skills/research/scripts/run.mjs");
    fs.mkdirSync(path.dirname(script));
    fs.writeFileSync(script, "original script\n");
    const service = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: fixture.repoRoot, rootPath: fixture.libraryRoot });
    const admitted = await service.createTaskProjection({ scopeId: "retained-task" });
    await service.deleteAgentPublication("alpha", () => deleteAgent({ repoRoot: fixture.repoRoot, agentName: "alpha", deleteSkills: false }));

    const retry = await service.createTaskProjection({ scopeId: "retained-task" });
    assert.equal(retry.rootPath, admitted.rootPath);
    assert.equal(fs.readFileSync(path.join(retry.rootPath, "agents/alpha/skills/research/SKILL.md"), "utf8"), skillDocument("Original instructions"));
    fs.writeFileSync(path.join(retry.rootPath, "agents/alpha/skills/research/scripts/run.mjs"), "corrupt script\n");
    await assert.rejects(service.createTaskProjection({ scopeId: "retained-task" }), /corrupt|digest/i);
  } finally { fixture.cleanup(); }
});

test("runtime snapshots retain Agent experience without exposing it as a reusable skill", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    const experience = path.join(fixture.repoRoot, "agents/alpha/experience");
    fs.mkdirSync(experience);
    fs.writeFileSync(path.join(experience, "session.md"), "Previously learned context\n");
    const service = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: fixture.repoRoot, rootPath: fixture.libraryRoot });

    const admitted = await service.createAgentProjection({ scopeId: "chat-with-experience", agentIds: ["alpha"] });

    assert.equal(fs.readFileSync(path.join(admitted.rootPath, "agents/alpha/experience/session.md"), "utf8"), "Previously learned context\n");
    assert.equal((await service.store.getSnapshot()).skills.length, 0);
  } finally { fixture.cleanup(); }
});

test("archiving hides new attachments without deleting retained history", async () => {
  const fixture = makeFixture();
  try {
    writeAgent(fixture.repoRoot, "alpha");
    writeAgent(fixture.repoRoot, "gamma");
    writeSkill(fixture.repoRoot, "alpha", "Shared instructions");
    const service = new ResourceLibraryService({ requireMigrationApproval: false,
      repoRootPath: fixture.repoRoot,
      rootPath: fixture.libraryRoot,
    });
    const initial = await service.getBrowserSnapshot();
    const skill = initial.skills.find((candidate) => candidate.slug === "research");
    assert.ok(skill);

    const archived = await service.store.setSkillArchived({
      skillId: skill.id,
      archived: true,
      expectedGeneration: initial.generation,
    });
    assert.equal(archived.skill.archived, true);
    await assert.rejects(
      service.attachSkill({
        agentId: "gamma",
        skillId: skill.id,
        revisionId: skill.currentRevisionId,
        alias: "research",
        expectedGeneration: initial.generation + 1,
      }),
      /Archived skills cannot be attached/,
    );
    assert.equal(snapshotAgentRevision(await service.getBrowserSnapshot(), "alpha"), skill.currentRevisionId);
    const files = await service.store.readSkillRevisionFiles(skill.id, skill.currentRevisionId);
    assert.equal(files.get("SKILL.md")?.toString("utf8"), skillDocument("Shared instructions"));
  } finally {
    fixture.cleanup();
  }
});

function snapshotAgentRevision(
  snapshot: Awaited<ReturnType<ResourceLibraryService["getBrowserSnapshot"]>>,
  agentId: string,
): string | undefined {
  return snapshot.agents.find((agent) => agent.id === agentId)?.attachments[0]?.revisionId;
}

function makeFixture(): { repoRoot: string; libraryRoot: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resource-library-runtime-"));
  const repoRoot = path.join(root, "project");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return {
    repoRoot,
    libraryRoot: path.join(root, "library"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAgent(repoRoot: string, agentName: string): void {
  const agentDir = path.join(repoRoot, "agents", agentName);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${agentName}.md`), `# ${agentName}\n`);
}

function writeSkill(repoRoot: string, agentName: string, instructions: string): void {
  const skillDir = path.join(repoRoot, "agents", agentName, "skills", "research");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillDocument(instructions));
}

function skillFiles(instructions: string): ResourceSkillFiles {
  return new Map([["SKILL.md", {
    contents: Buffer.from(skillDocument(instructions)),
    mode: 0o644,
    executable: false,
  }]]);
}

function skillDocument(instructions: string): string {
  return `---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# ${instructions}\n`;
}
