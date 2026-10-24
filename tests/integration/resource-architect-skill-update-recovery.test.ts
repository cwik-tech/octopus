/**
 * Durable publication of a skill update, and what a retry makes of what it
 * finds.
 *
 * One operation writes several files and there is no filesystem transaction
 * spanning them, so an attempt can stop with some published and the rest not.
 * What makes that recoverable is evidence: the manifest records the state each
 * file was in when the update was authorized and the exact bytes staged to
 * replace it, so a later attempt can tell its own half-finished work from
 * somebody else's edit. Everything below is that distinction.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ResourceLibraryService } from "../../services/resource-library-service.js";

import type { ResourceUpdateOperation } from "../../contracts/resource-architect.js";
import { computeAgentRevision } from "../../domains/agent-generator/agent-revision.js";
import { withAgentNameMutationLock } from "../../domains/agent-generator/agent-name-reservation.js";
import { digestResourceUpdateOperation } from "../../domains/resource-architect/resource-update-operation-digest.js";
import {
  AgentRevisionConflictError,
  applyAgentSkillUpdate,
  SkillUpdateEvidenceError,
  type SkillUpdatePersistenceBoundary,
} from "../../services/skill-update-operation.js";

const AGENT_ID = "michigan-contract-lawyer";
const PLAN_ID = "plan-00000000";
const FIRST_SKILL = "termination-clause-review";
const SECOND_SKILL = "indemnity-clause-review";
const UNRELATED_SKILL = "governing-law-review";

function generated(name: string, marker = "published"): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  Walk a contract draft through the ${name} procedure clause by clause.`,
    `  Use when a draft reaches ${name} and the reviewer needs the checklist.`,
    "---",
    "",
    `# ${name}`,
    "",
    `Marker: ${marker}.`,
    "",
  ].join("\n");
}

interface ProviderHarness {
  url: string;
  generationCount(): number;
  close(): Promise<void>;
}

async function startProvider(): Promise<ProviderHarness> {
  let generationCount = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      generationCount += 1;
      const asked = (body.messages ?? [])
        .filter((message) => message.role !== "system")
        .map((message) => message.content)
        .join("\n");
      const name = asked.match(/Skill folder name:\s*`([^`]+)`/)?.[1] ?? FIRST_SKILL;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content: JSON.stringify({ name, body: generated(name) }) } }],
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    generationCount: () => generationCount,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function existingSkill(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  The ${name} procedure as it stands today. Use when a draft reaches the`,
    `  ${name} step.`,
    "---",
    "",
    `# ${name}`,
    "",
    "Marker: original.",
    "",
  ].join("\n");
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-update-recovery-"));
  const teamDir = path.join(repoRoot, "teams", "workflow-architect");
  const architectDir = path.join(repoRoot, "agents", "workflow-architect");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(architectDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      "  name: workflow-architect",
      "agents:",
      "  - name: workflow-architect",
      "    agent_file: ../../agents/workflow-architect/workflow-architect.md",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(architectDir, "workflow-architect.md"),
    // The architect runs with its own agent file's pair.
    "---\nprovider: openai\nmodel: local-test-model\n---\n\n" + ("Author skills.\n"),
  );

  const agentDir = path.join(repoRoot, "agents", AGENT_ID);
  fs.mkdirSync(path.join(agentDir, "experience"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, `${AGENT_ID}.md`),
    `---\nname: ${AGENT_ID}\ndescription: Reviews contracts.\ntier: strategic\n---\n\n# ${AGENT_ID}\n`,
  );
  fs.writeFileSync(path.join(agentDir, "experience", "session-1.md"), "Learned something.\n");
  fs.writeFileSync(path.join(agentDir, ".create-orchestrator"), "seed-orchestrator\n");
  for (const name of [SECOND_SKILL, UNRELATED_SKILL]) {
    fs.mkdirSync(path.join(agentDir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "skills", name, "SKILL.md"), existingSkill(name));
  }
  // A reference file the skill under update owns. Only its SKILL.md was named.
  fs.mkdirSync(path.join(agentDir, "skills", SECOND_SKILL, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "skills", SECOND_SKILL, "references", "caps.md"),
    "Negotiated liability caps by counterparty.\n",
  );
  return repoRoot;
}

function skillPath(repoRoot: string, name: string): string {
  return path.join(repoRoot, "agents", AGENT_ID, "skills", name, "SKILL.md");
}

/** The staged document one skill owns inside the plan's transaction folder. */
function stagedPath(repoRoot: string, skillName: string, operationIndex = 0): string {
  return path.join(
    path.dirname(manifestPath(repoRoot, operationIndex)),
    `${operationIndex}-staged`,
    "skills",
    skillName,
    "SKILL.md",
  );
}

/**
 * Answers the first authoring call, refuses the second, and answers every call
 * after that. Each document it authors names the call that produced it, so a
 * published file shows which call its bytes came from.
 */
async function startFailingSecondProvider(): Promise<ProviderHarness> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      calls += 1;
      if (calls === 2) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("the author is unavailable");
        return;
      }
      const asked = (body.messages ?? [])
        .filter((message) => message.role !== "system")
        .map((message) => message.content)
        .join("\n");
      const name = asked.match(/Skill folder name:\s*`([^`]+)`/)?.[1] ?? FIRST_SKILL;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{
            message: {
              content: JSON.stringify({ name, body: generated(name, `call ${calls}`) }),
            },
          }],
        }),
      );
    })().catch(() => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("harness failure");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    generationCount: () => calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function manifestPath(repoRoot: string, operationIndex = 0): string {
  const planDirectory = path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    "skills",
  );
  const digests = fs.existsSync(planDirectory) ? fs.readdirSync(planDirectory) : [];
  assert.equal(digests.length, 1, `expected one plan directory, found ${digests.join(", ")}`);
  return path.join(planDirectory, digests[0]!, `${operationIndex}.json`);
}

function twoSkillOperation(
  expectedRevision: string,
): Extract<ResourceUpdateOperation, { kind: "update_agent_skills" }> {
  return {
    kind: "update_agent_skills",
    target: { kind: "agent", id: AGENT_ID },
    expectedRevision,
    skillUpdates: [
      { action: "create", name: FIRST_SKILL, instruction: "Author the termination review." },
      { action: "update", name: SECOND_SKILL, instruction: "Require a liability cap check." },
    ],
  };
}

interface Harness {
  repoRoot: string;
  provider: ProviderHarness;
}

async function withHarness(run: (context: Harness) => Promise<void>): Promise<void> {
  const repoRoot = makeRepo();
  const provider = await startProvider();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    await run({ repoRoot, provider });
  } finally {
    await provider.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function apply(
  repoRoot: string,
  operation: Extract<ResourceUpdateOperation, { kind: "update_agent_skills" }>,
  options: {
    jobId?: string;
    onPersistenceBoundary?: (
      boundary: SkillUpdatePersistenceBoundary,
    ) => void | Promise<void>;
  } = {},
) {
  return applyAgentSkillUpdate({
    repoRoot,
    planId: PLAN_ID,
    jobId: options.jobId ?? "job-1",
    operationIndex: 0,
    operation,
    ...(options.onPersistenceBoundary
      ? { onPersistenceBoundary: options.onPersistenceBoundary }
      : {}),
  });
}

test("a first attempt publishes exactly the named skills and nothing else", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const agentDir = path.join(repoRoot, "agents", AGENT_ID);
    const personaBefore = fs.readFileSync(path.join(agentDir, `${AGENT_ID}.md`), "utf8");
    const markerBefore = fs.readFileSync(path.join(agentDir, ".create-orchestrator"), "utf8");
    const experienceBefore = fs.readFileSync(
      path.join(agentDir, "experience", "session-1.md"),
      "utf8",
    );
    const unrelatedBefore = fs.readFileSync(skillPath(repoRoot, UNRELATED_SKILL), "utf8");
    const supportBefore = fs.readFileSync(
      path.join(agentDir, "skills", SECOND_SKILL, "references", "caps.md"),
      "utf8",
    );
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));

    const result = await apply(repoRoot, operation);

    assert.deepEqual(result.publishedSkills, [FIRST_SKILL, SECOND_SKILL]);
    assert.equal(result.alreadyApplied, false);
    assert.equal(fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"), generated(FIRST_SKILL));
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      generated(SECOND_SKILL),
    );
    assert.equal(fs.readFileSync(path.join(agentDir, `${AGENT_ID}.md`), "utf8"), personaBefore);
    assert.equal(
      fs.readFileSync(path.join(agentDir, ".create-orchestrator"), "utf8"),
      markerBefore,
    );
    assert.equal(
      fs.readFileSync(path.join(agentDir, "experience", "session-1.md"), "utf8"),
      experienceBefore,
    );
    assert.equal(fs.readFileSync(skillPath(repoRoot, UNRELATED_SKILL), "utf8"), unrelatedBefore);
    assert.equal(
      fs.readFileSync(
        path.join(agentDir, "skills", SECOND_SKILL, "references", "caps.md"),
        "utf8",
      ),
      supportBefore,
      "an update writes the skill's SKILL.md and leaves the rest of its folder alone",
    );
    assert.equal(result.revision, computeAgentRevision(repoRoot, AGENT_ID));
    assert.equal(provider.generationCount(), 2, "one authoring call per requested skill");
  });
});

test("a generated skill update publishes a retained Library revision before returning success", async () => {
  await withHarness(async ({ repoRoot }) => {
    const library = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: repoRoot, rootPath: path.join(repoRoot, ".test-library") });
    await library.initialize();
    const before = await library.store.getSnapshot();
    const attachment = before.agents.find((agent) => agent.id === AGENT_ID)?.attachments.find((pin) => pin.alias === SECOND_SKILL);
    assert.ok(attachment);
    await applyAgentSkillUpdate({ repoRoot, planId: PLAN_ID, jobId: "library-update", operationIndex: 0,
      operation: twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID)), resourcePublisher: library,
    });
    const after = await library.store.getSnapshot();
    const pin = after.agents.find((agent) => agent.id === AGENT_ID)?.attachments.find((candidate) => candidate.alias === SECOND_SKILL);
    assert.ok(pin);
    assert.notEqual(pin.revisionId, attachment.revisionId);
    const saved = await library.store.readSkillRevisionFiles(pin.skillId, pin.revisionId);
    assert.equal(saved.get("SKILL.md")?.toString(), generated(SECOND_SKILL));
    const original = await library.store.readSkillRevisionFiles(attachment.skillId, attachment.revisionId);
    assert.notEqual(original.get("SKILL.md")?.toString(), generated(SECOND_SKILL));
  });
});

test("an Agent that changed before generation makes no provider call and no write", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const operation = twoSkillOperation(`sha256:${"0".repeat(64)}`);
    const unrelatedBefore = fs.readFileSync(skillPath(repoRoot, UNRELATED_SKILL), "utf8");
    const secondBefore = fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8");

    await assert.rejects(apply(repoRoot, operation), AgentRevisionConflictError);

    assert.equal(provider.generationCount(), 0);
    assert.equal(fs.existsSync(skillPath(repoRoot, FIRST_SKILL)), false);
    assert.equal(fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"), secondBefore);
    assert.equal(fs.readFileSync(skillPath(repoRoot, UNRELATED_SKILL), "utf8"), unrelatedBefore);
  });
});

test("an Agent that changes during generation is never written to", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));

    await assert.rejects(
      apply(repoRoot, operation, {
        onPersistenceBoundary: (boundary) => {
          if (boundary !== "after_skills_staged") return;
          // Somebody else edits the Agent while the author is working.
          fs.writeFileSync(
            skillPath(repoRoot, UNRELATED_SKILL),
            `${existingSkill(UNRELATED_SKILL)}\nEdited by someone else.\n`,
          );
        },
      }),
      AgentRevisionConflictError,
    );

    assert.ok(provider.generationCount() > 0, "generation had already happened");
    assert.equal(
      fs.existsSync(skillPath(repoRoot, FIRST_SKILL)),
      false,
      "a conflict discovered under the lock writes nothing to the Agent",
    );
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      existingSkill(SECOND_SKILL),
    );
  });
});

test("a crash after the first of two files is published finishes on retry", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    let publications = 0;

    await assert.rejects(
      apply(repoRoot, operation, {
        onPersistenceBoundary: (boundary) => {
          if (boundary !== "after_skill_file_published") return;
          publications += 1;
          if (publications === 1) throw new Error("process exited mid-publication");
        },
      }),
      /process exited mid-publication/,
    );

    // Exactly one file landed; the other is still as it was.
    assert.equal(fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"), generated(FIRST_SKILL));
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      existingSkill(SECOND_SKILL),
    );
    const generationsBefore = provider.generationCount();

    // The retry is a different build of the same stored plan.
    const result = await apply(repoRoot, operation, { jobId: "job-2" });

    assert.equal(result.alreadyApplied, false);
    assert.deepEqual(result.publishedSkills, [SECOND_SKILL], "only the unfinished file is written");
    assert.equal(fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"), generated(FIRST_SKILL));
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      generated(SECOND_SKILL),
    );
    assert.equal(
      provider.generationCount(),
      generationsBefore,
      "staged work is reused, never authored a second time",
    );
    assert.equal(result.revision, computeAgentRevision(repoRoot, AGENT_ID));
  });
});

/**
 * Correction: durable evidence belongs to the plan, the operation, and the
 * Agent. A retry is a new build of the same stored plan, so it carries a new
 * job id — refusing to recover on that basis would strand the operation's own
 * half-finished work forever.
 */
test("a retry under a new job id recovers the same operation's evidence", async () => {
  await withHarness(async ({ repoRoot }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    await apply(repoRoot, operation, { jobId: "job-1" });
    const revisionAfterFirst = computeAgentRevision(repoRoot, AGENT_ID);

    const result = await apply(repoRoot, operation, { jobId: "a-completely-different-job" });

    assert.equal(result.alreadyApplied, true);
    assert.deepEqual(result.publishedSkills, []);
    assert.equal(computeAgentRevision(repoRoot, AGENT_ID), revisionAfterFirst);
  });
});

test("an Agent already carrying the intended result is not written again", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    await apply(repoRoot, operation);
    const generationsAfterFirst = provider.generationCount();
    const publishedAt = fs.statSync(skillPath(repoRoot, FIRST_SKILL)).mtimeMs;

    const result = await apply(repoRoot, operation);

    assert.equal(result.alreadyApplied, true);
    assert.equal(provider.generationCount(), generationsAfterFirst, "nothing is authored again");
    assert.equal(
      fs.statSync(skillPath(repoRoot, FIRST_SKILL)).mtimeMs,
      publishedAt,
      "an already-applied update rewrites no file",
    );
  });
});

test("target content the evidence does not describe is a conflict and stays untouched", async () => {
  await withHarness(async ({ repoRoot }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    let publications = 0;
    await assert.rejects(
      apply(repoRoot, operation, {
        onPersistenceBoundary: (boundary) => {
          if (boundary !== "after_skill_file_published") return;
          publications += 1;
          if (publications === 1) throw new Error("process exited mid-publication");
        },
      }),
      /process exited mid-publication/,
    );
    // Somebody edits the file this operation had already published.
    const tampered = `${generated(FIRST_SKILL)}\nEdited by hand.\n`;
    fs.writeFileSync(skillPath(repoRoot, FIRST_SKILL), tampered);

    await assert.rejects(apply(repoRoot, operation), AgentRevisionConflictError);

    assert.equal(fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"), tampered);
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      existingSkill(SECOND_SKILL),
    );
  });
});

test("a manifest that is malformed or describes another operation fails closed", async () => {
  const cases: Array<[string, (manifest: Record<string, unknown>) => unknown]> = [
    ["not JSON at all", () => "{ this is not json"],
    ["another plan", (manifest) => ({ ...manifest, planId: "some-other-plan" })],
    ["another operation index", (manifest) => ({ ...manifest, operationIndex: 7 })],
    ["another Agent", (manifest) => ({
      ...manifest,
      target: { kind: "agent", id: "someone-else" },
    })],
    ["another revision", (manifest) => ({
      ...manifest,
      expectedRevision: `sha256:${"9".repeat(64)}`,
    })],
    ["a different set of skills", (manifest) => ({
      ...manifest,
      skills: [{ action: "create", name: "unrelated-skill" }],
    })],
    ["no version", (manifest) => ({ ...manifest, version: undefined })],
  ];

  for (const [description, corrupt] of cases) {
    await withHarness(async ({ repoRoot }) => {
      const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
      await apply(repoRoot, operation);
      const file = manifestPath(repoRoot);
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const corrupted = corrupt(manifest);
      fs.writeFileSync(
        file,
        typeof corrupted === "string" ? corrupted : JSON.stringify(corrupted),
      );
      const publishedBefore = fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8");

      await assert.rejects(
        apply(repoRoot, operation),
        SkillUpdateEvidenceError,
        `expected ${description} to fail closed`,
      );

      assert.equal(
        fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"),
        publishedBefore,
        `expected ${description} to leave the Agent untouched`,
      );
    });
  }
});

test("the manifest binds everything a later attempt has to check", async () => {
  await withHarness(async ({ repoRoot }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));

    await apply(repoRoot, operation, { jobId: "job-1" });

    const manifest = JSON.parse(fs.readFileSync(manifestPath(repoRoot), "utf8")) as {
      version: number;
      planId: string;
      originJobId: string;
      operationIndex: number;
      target: { kind: string; id: string };
      expectedRevision: string;
      intendedRevision: string;
      state: string;
      publishedSkills: string[];
      skills: Array<{
        action: string;
        name: string;
        filePath: string;
        priorHash: string | null;
        stagedHash: string;
      }>;
    };

    assert.equal(manifest.version, 1);
    assert.equal(manifest.planId, PLAN_ID);
    assert.equal(manifest.originJobId, "job-1");
    assert.equal(manifest.operationIndex, 0);
    assert.deepEqual(manifest.target, { kind: "agent", id: AGENT_ID });
    assert.equal(manifest.expectedRevision, operation.expectedRevision);
    assert.equal(manifest.intendedRevision, computeAgentRevision(repoRoot, AGENT_ID));
    assert.equal(manifest.state, "published");
    assert.deepEqual(manifest.publishedSkills, [FIRST_SKILL, SECOND_SKILL]);
    assert.deepEqual(
      manifest.skills.map((skill) => [skill.action, skill.name, skill.filePath]),
      [
        ["create", FIRST_SKILL, `skills/${FIRST_SKILL}/SKILL.md`],
        ["update", SECOND_SKILL, `skills/${SECOND_SKILL}/SKILL.md`],
      ],
    );
    assert.equal(
      manifest.skills[0]!.priorHash,
      null,
      "a created skill had no prior file, and the evidence has to say so",
    );
    assert.match(manifest.skills[1]!.priorHash ?? "", /^sha256:[0-9a-f]{64}$/);
    for (const skill of manifest.skills) {
      assert.match(skill.stagedHash, /^sha256:[0-9a-f]{64}$/);
    }
  });
});

/**
 * Evidence belongs to the exact operation, not to a shape that resembles it.
 * Two proposals can name the same Agent, the same revision, and the same skill
 * names while asking for different documents; reusing bytes authored under one
 * instruction to satisfy the other would publish work nobody approved.
 */
test("evidence for one instruction does not authorize a different instruction", async () => {
  await withHarness(async ({ repoRoot }) => {
    const expectedRevision = computeAgentRevision(repoRoot, AGENT_ID);
    const first = twoSkillOperation(expectedRevision);
    let publications = 0;
    await assert.rejects(
      apply(repoRoot, first, {
        onPersistenceBoundary: (boundary) => {
          if (boundary !== "after_skill_file_published") return;
          publications += 1;
          if (publications === 1) throw new Error("process exited mid-publication");
        },
      }),
      /process exited mid-publication/,
    );
    const publishedBefore = fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8");
    const secondBefore = fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8");

    const reworded = {
      ...first,
      skillUpdates: first.skillUpdates.map((update, index) =>
        index === 0 ? { ...update, instruction: "Something else entirely." } : update
      ),
    };

    await assert.rejects(apply(repoRoot, reworded), SkillUpdateEvidenceError);

    assert.equal(fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"), publishedBefore);
    assert.equal(fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"), secondBefore);
  });
});

/**
 * A recorded hash is not protection unless it is checked against the file it
 * describes. Staged bytes that went missing or were altered cannot be
 * published, and the operation must not quietly author replacements for them
 * either: the intended result is already recorded, and different bytes would
 * not produce it.
 */
test("staged evidence that is missing or altered fails closed", async () => {
  for (const damage of ["remove", "alter"] as const) {
    await withHarness(async ({ repoRoot }) => {
      const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
      let publications = 0;
      await assert.rejects(
        apply(repoRoot, operation, {
          onPersistenceBoundary: (boundary) => {
            if (boundary !== "after_skill_file_published") return;
            publications += 1;
            if (publications === 1) throw new Error("process exited mid-publication");
          },
        }),
        /process exited mid-publication/,
      );
      const secondBefore = fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8");
      const stagedRemaining = stagedPath(repoRoot, SECOND_SKILL);
      if (damage === "remove") fs.rmSync(stagedRemaining, { force: true });
      else fs.writeFileSync(stagedRemaining, `${generated(SECOND_SKILL)}\nTampered.\n`);

      await assert.rejects(
        apply(repoRoot, operation),
        SkillUpdateEvidenceError,
        `expected staged evidence that was ${damage}d to fail closed`,
      );

      assert.equal(
        fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
        secondBefore,
        `expected no further write after staged evidence was ${damage}d`,
      );
    });
  }
});

/**
 * One operation is one authorized change. A skill the author could not write
 * means the change the user approved cannot be made, so neither file is
 * published — publishing the half that happened to succeed would apply an
 * update nobody reviewed.
 */
test("a skill that cannot be authored leaves every named file untouched", async () => {
  const repoRoot = makeRepo();
  const provider = await startFailingSecondProvider();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    const secondBefore = fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8");

    await assert.rejects(apply(repoRoot, operation));

    assert.equal(
      fs.existsSync(skillPath(repoRoot, FIRST_SKILL)),
      false,
      "the skill that was authored successfully is not published on its own",
    );
    assert.equal(fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"), secondBefore);

    // The skill authored before the failure is durable evidence: its receipt
    // entry and the hash of its staged bytes were written before the second
    // provider call, so the failure cannot take them away.
    const stagedFirst = fs.readFileSync(stagedPath(repoRoot, FIRST_SKILL));
    assert.equal(stagedFirst.toString("utf8"), generated(FIRST_SKILL, "call 1"));
    const receipt = z.object({
      skills: z.array(z.object({ name: z.string(), stagedHash: z.string() })),
      publishedSkills: z.array(z.string()),
    }).parse(JSON.parse(fs.readFileSync(manifestPath(repoRoot), "utf8")));
    assert.deepEqual(
      receipt.skills.map((entry) => [entry.name, entry.stagedHash]),
      [[FIRST_SKILL, `sha256:${createHash("sha256").update(stagedFirst).digest("hex")}`]],
    );
    assert.deepEqual(receipt.publishedSkills, []);

    // A retry authors only the skill that failed, then publishes both.
    const result = await apply(repoRoot, operation, { jobId: "job-2" });

    assert.equal(provider.generationCount(), 3, "the retry makes exactly one provider call");
    assert.deepEqual(result.publishedSkills, [FIRST_SKILL, SECOND_SKILL]);
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"),
      generated(FIRST_SKILL, "call 1"),
      "the first skill is published from the bytes staged before the failure",
    );
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      generated(SECOND_SKILL, "call 3"),
    );
  } finally {
    await provider.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * A staged file the receipt never recorded vouches for nothing. The reported
 * failure left twelve of them; a retry authors those skills again instead of
 * publishing bytes no receipt entry describes.
 */
test("a retry authors a skill whose staged file the receipt never recorded", async () => {
  const repoRoot = makeRepo();
  const provider = await startFailingSecondProvider();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    await assert.rejects(apply(repoRoot, operation));
    // Bytes where the failed skill would be staged, with no receipt entry.
    const orphan = stagedPath(repoRoot, SECOND_SKILL);
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, generated(SECOND_SKILL, "orphan"));

    const result = await apply(repoRoot, operation, { jobId: "job-2" });

    assert.equal(provider.generationCount(), 3, "the retry authors the unrecorded skill");
    assert.deepEqual(result.publishedSkills, [FIRST_SKILL, SECOND_SKILL]);
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      generated(SECOND_SKILL, "call 3"),
    );
  } finally {
    await provider.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * A receipt that claims completion has to be able to back the claim up.
 *
 * `intendedRevision` alone is a number that happens to match; on its own it
 * can say "already applied" about a package where nothing was applied at all.
 * A receipt naming that revision must also record the full operation it
 * describes and the state of everything it did not touch, or it is not
 * evidence of anything.
 */
test("a receipt claiming completion without the evidence to support it fails closed", async () => {
  await withHarness(async ({ repoRoot }) => {
    const expectedRevision = computeAgentRevision(repoRoot, AGENT_ID);
    const operation = twoSkillOperation(expectedRevision);
    const planDirectory = path.join(
      repoRoot,
      ".create-orchestrator",
      "resource-updates",
      "skills",
      createHash("sha256").update(PLAN_ID, "utf8").digest("hex"),
    );
    fs.mkdirSync(planDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(planDirectory, "0.json"),
      `${JSON.stringify({
        version: 1,
        kind: "update_agent_skills",
        planId: PLAN_ID,
        originJobId: "job-1",
        operationIndex: 0,
        target: { kind: "agent", id: AGENT_ID },
        expectedRevision,
        operationDigest: digestResourceUpdateOperation(operation),
        unnamedDigest: null,
        // The Agent's current revision, so an unguarded early return would
        // report an update that never happened as already applied.
        intendedRevision: expectedRevision,
        skills: [],
        publishedSkills: [],
        state: "published",
      })}\n`,
    );

    await assert.rejects(apply(repoRoot, operation), SkillUpdateEvidenceError);

    assert.equal(
      fs.existsSync(skillPath(repoRoot, FIRST_SKILL)),
      false,
      "a false completion must not be reported as one, and must write nothing",
    );
  });
});

/**
 * Publication runs under the Agent's own mutation lock — the same one Agent
 * creation and package publication take. Supplementary protection rather than
 * a race proof: a wrongly keyed lock would let a concurrent Agent publish slip
 * between the revision recheck and the skill writes, and this shows the two
 * are serialized by observing that publication finishes only after the holder
 * lets go.
 */
test("publication waits for whoever else holds the Agent's lock", async () => {
  await withHarness(async ({ repoRoot }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    const order: string[] = [];
    let releaseLock!: () => void;
    let announceHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      announceHeld = resolve;
    });
    const holder = withAgentNameMutationLock(repoRoot, AGENT_ID, async () => {
      announceHeld();
      await held;
      order.push("lock-released");
    });
    await acquired;

    const pending = apply(repoRoot, operation, {
      onPersistenceBoundary: (boundary) => {
        if (boundary === "after_skills_staged") releaseLock();
        if (boundary === "after_skill_file_published") order.push("published");
      },
    });
    await pending;
    await holder;

    assert.equal(order[0], "lock-released", `expected the lock first: ${order.join(", ")}`);
    assert.deepEqual(order, ["lock-released", "published", "published"]);
  });
});

/**
 * A complete-looking receipt is still only a claim.
 *
 * A corrupted manifest can name every requested skill, invent staged hashes
 * and an unnamed digest, and set `intendedRevision` to the Agent's untouched
 * revision. Trusting that number alone reports an update that never happened
 * as already applied, and the user is told their skills changed when nothing
 * on disk did.
 */
test("a complete-looking receipt whose evidence does not match the Agent fails closed", async () => {
  await withHarness(async ({ repoRoot }) => {
    const expectedRevision = computeAgentRevision(repoRoot, AGENT_ID);
    const operation = twoSkillOperation(expectedRevision);
    const planDirectory = path.join(
      repoRoot,
      ".create-orchestrator",
      "resource-updates",
      "skills",
      createHash("sha256").update(PLAN_ID, "utf8").digest("hex"),
    );
    fs.mkdirSync(planDirectory, { recursive: true });
    const invented = `sha256:${"7".repeat(64)}`;
    fs.writeFileSync(
      path.join(planDirectory, "0.json"),
      `${JSON.stringify({
        version: 1,
        kind: "update_agent_skills",
        planId: PLAN_ID,
        originJobId: "job-1",
        operationIndex: 0,
        target: { kind: "agent", id: AGENT_ID },
        expectedRevision,
        operationDigest: digestResourceUpdateOperation(operation),
        unnamedDigest: invented,
        // The Agent's own current revision, so an early return that trusts it
        // reports a finished update over a package nothing touched.
        intendedRevision: expectedRevision,
        skills: [
          {
            action: "create",
            name: FIRST_SKILL,
            filePath: `skills/${FIRST_SKILL}/SKILL.md`,
            priorHash: null,
            stagedHash: invented,
          },
          {
            action: "update",
            name: SECOND_SKILL,
            filePath: `skills/${SECOND_SKILL}/SKILL.md`,
            priorHash: invented,
            stagedHash: invented,
          },
        ],
        publishedSkills: [FIRST_SKILL, SECOND_SKILL],
        state: "published",
      })}\n`,
    );

    await assert.rejects(apply(repoRoot, operation), SkillUpdateEvidenceError);

    assert.equal(
      fs.existsSync(skillPath(repoRoot, FIRST_SKILL)),
      false,
      "a receipt that cannot back its claim publishes nothing",
    );
    assert.equal(
      fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
      existingSkill(SECOND_SKILL),
    );
  });
});

/**
 * The action a persisted plan carries is checked against the Agent, not taken
 * on trust.
 *
 * The proposal boundary already refused a `create` onto an occupied name and
 * an `update` of a skill that is not there. A plan file that reached the disk
 * some other way carries no such guarantee, and executing it would overwrite a
 * skill the user never offered to replace.
 */
test("an action that contradicts the Agent is refused before any provider call", async () => {
  for (
    const [description, skillUpdates] of [
      ["a create onto a skill that already exists", [{
        action: "create" as const,
        name: SECOND_SKILL,
        instruction: "Author it.",
      }]],
      ["an update of a skill that is not there", [{
        action: "update" as const,
        name: FIRST_SKILL,
        instruction: "Rewrite it.",
      }]],
    ] as const
  ) {
    await withHarness(async ({ repoRoot, provider }) => {
      const before = fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8");

      await assert.rejects(
        apply(repoRoot, {
          kind: "update_agent_skills",
          target: { kind: "agent", id: AGENT_ID },
          expectedRevision: computeAgentRevision(repoRoot, AGENT_ID),
          skillUpdates: [...skillUpdates],
        }),
        `expected ${description} to be refused`,
      );

      assert.equal(provider.generationCount(), 0, `expected ${description} to author nothing`);
      assert.equal(fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"), before);
      assert.equal(fs.existsSync(skillPath(repoRoot, FIRST_SKILL)), false);
    });
  }
});

/**
 * Somebody else finishing the same work is a success, not a conflict.
 *
 * The lock is where the write happens, so its recheck is the one that decides.
 * If the Agent reaches this operation's intended result while it was
 * authoring, there is nothing left to write and nothing to complain about.
 *
 * The evidence check on that branch mirrors the unlocked one, and is defence
 * in depth rather than a proved rule: this attempt recomputes what it left
 * alone from the state it observed, so no deterministic case in this suite can
 * reach the locked branch with evidence that does not match. It is kept
 * because the cost is one comparison and the failure it would catch is a
 * silently false completion at the write boundary.
 */
test("an operation whose result appears while it is authoring reports it applied", async () => {
  await withHarness(async ({ repoRoot }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    await apply(repoRoot, operation, { jobId: "job-1" });
    const published = {
      first: fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"),
      second: fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"),
    };

    // Back to where the proposal was authorized, so the first recheck lets the
    // attempt through and it starts authoring again.
    fs.rmSync(path.dirname(skillPath(repoRoot, FIRST_SKILL)), { recursive: true, force: true });
    fs.writeFileSync(skillPath(repoRoot, SECOND_SKILL), existingSkill(SECOND_SKILL));

    const result = await apply(repoRoot, operation, {
      jobId: "job-2",
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_skills_staged") return;
        fs.mkdirSync(path.dirname(skillPath(repoRoot, FIRST_SKILL)), { recursive: true });
        fs.writeFileSync(skillPath(repoRoot, FIRST_SKILL), published.first);
        fs.writeFileSync(skillPath(repoRoot, SECOND_SKILL), published.second);
      },
    });

    assert.equal(result.alreadyApplied, true);
    assert.deepEqual(result.publishedSkills, []);
    assert.equal(fs.readFileSync(skillPath(repoRoot, FIRST_SKILL), "utf8"), published.first);
    assert.equal(fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"), published.second);
  });
});

/**
 * Staged evidence must be the file the receipt describes, not a link to bytes
 * that happen to match.
 *
 * A hash says what the content is; it does not say the operation still owns
 * the file that holds it. A link points somewhere this operation never wrote,
 * and whatever is there can change between the check and the publication.
 */
test("staged evidence replaced by a symbolic link fails closed", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const operation = twoSkillOperation(computeAgentRevision(repoRoot, AGENT_ID));
    let publications = 0;
    await assert.rejects(
      apply(repoRoot, operation, {
        onPersistenceBoundary: (boundary) => {
          if (boundary !== "after_skill_file_published") return;
          publications += 1;
          if (publications === 1) throw new Error("process exited mid-publication");
        },
      }),
      /process exited mid-publication/,
    );
    const secondBefore = fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8");
    const staged = stagedPath(repoRoot, SECOND_SKILL);
    const elsewhere = path.join(repoRoot, "elsewhere-SKILL.md");
    fs.writeFileSync(elsewhere, fs.readFileSync(staged));
    fs.rmSync(staged, { force: true });
    fs.symlinkSync(elsewhere, staged);
    const generationsBefore = provider.generationCount();

    await assert.rejects(apply(repoRoot, operation), SkillUpdateEvidenceError);

    assert.equal(fs.readFileSync(skillPath(repoRoot, SECOND_SKILL), "utf8"), secondBefore);
    assert.equal(
      provider.generationCount(),
      generationsBefore,
      "a refused operation authors nothing",
    );
  });
});
