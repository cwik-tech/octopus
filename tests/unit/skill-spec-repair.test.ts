/**
 * One bounded correction round for the skills an Agent draft carried.
 *
 * The provider is a real loopback HTTP server because half of what this
 * boundary owes is the conversation: the repair has to be told which document
 * failed and exactly what was wrong with it, and it is allowed one attempt per
 * skill. A replaced function could observe neither.
 *
 * What a rewritten body cannot fix is not sent at all. A folder name the
 * specification rejects, and two skills claiming one folder, are decided by
 * fields outside the document, so asking a model to rewrite the document would
 * spend a call to arrive at the same failure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { GeneratedSkill } from "../../contracts/agent-generator.js";
import { repairGeneratedSkills } from "../../domains/agent-generator/skill-spec-repair.js";
import {
  findSkillBatchViolations,
  SkillSpecViolationError,
  type SkillPublicationSource,
} from "../../domains/agent-generator/skill-spec-validation.js";

const SKILL_NAME = "counterparty-screening";
const OTHER_SKILL = "wallet-custody-audit";

/** A description that names a subject and never says when to use the skill. */
function missingActivationClause(name = SKILL_NAME): string {
  return [
    "---",
    `name: ${name}`,
    `description: Guidance on ${name.replace(/-/g, " ")}.`,
    "---",
    "",
    "# Screening",
    "",
    "1. Check the counterparty.",
    "",
  ].join("\n");
}

function conforming(name = SKILL_NAME): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  Walk a counterparty through the ${name.replace(/-/g, " ")} checks.`,
    "  Use when onboarding a new counterparty or reviewing a suspicious",
    "  transfer request.",
    "---",
    "",
    "# Screening",
    "",
    "1. Check the counterparty.",
    "",
  ].join("\n");
}

/** The violations the publication boundary would raise for these skills. */
function violationsFor(skills: readonly GeneratedSkill[]) {
  const sources: SkillPublicationSource[] = skills.map((skill) => ({
    origin: "generated",
    folderName: skill.name,
    source: skill.body,
    skillPath: `skills/${skill.name || "(unnamed)"}/SKILL.md`,
  }));
  return findSkillBatchViolations(sources);
}

interface ProviderHarness {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

async function startProvider(replies: readonly string[]): Promise<ProviderHarness> {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      calls.push(Buffer.concat(chunks).toString("utf8"));
      const content = replies[Math.min(calls.length - 1, replies.length - 1)] ?? "{}";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content } }],
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
    calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function reply(body: string, name = SKILL_NAME): string {
  return JSON.stringify({ name, body });
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-spec-repair-"));
  const teamDir = path.join(repoRoot, "teams", "workflow-architect");
  const agentDir = path.join(repoRoot, "agents", "workflow-architect");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
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
  // The architect's own file names the pair it runs with; the team declares
  // no model at all.
  fs.writeFileSync(
    path.join(agentDir, "workflow-architect.md"),
    ["---", "provider: openai", "model: local-test-model", "---", "", "Author skills.", ""].join("\n"),
  );
  return repoRoot;
}

async function withHarness(
  replies: readonly string[],
  run: (context: { repoRoot: string; provider: ProviderHarness }) => Promise<void>,
): Promise<void> {
  const repoRoot = makeRepo();
  const provider = await startProvider(replies);
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    await run({ repoRoot, provider });
  } finally {
    await provider.close();
    restoreEnv("OPENAI_API_KEY", previousKey);
    restoreEnv("WORKFLOW_GENERATOR_OPENAI_API_URL", previousUrl);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test("the repair is given the document that failed and the exact problem with it", async () => {
  const skills: GeneratedSkill[] = [{ name: SKILL_NAME, body: missingActivationClause() }];
  await withHarness([reply(conforming())], async ({ repoRoot, provider }) => {
    await repairGeneratedSkills({
      repoRoot,
      skills,
      violations: violationsFor(skills),
      provider: "openai",
      model: "local-test-model",
    });

    assert.equal(provider.calls.length, 1);
    const request = provider.calls[0] ?? "";
    assert.ok(
      request.includes(JSON.stringify(missingActivationClause()).slice(1, -1)),
      "the repair must carry the SKILL.md that failed",
    );
    assert.ok(
      request.includes("says what the skill is about but not when to use it"),
      "the repair must carry the violation it has to fix",
    );
    assert.ok(request.includes(SKILL_NAME), "the repair must name the skill folder");
  });
});

test("only the skill that broke the specification is rewritten", async () => {
  const skills: GeneratedSkill[] = [
    { name: OTHER_SKILL, body: conforming(OTHER_SKILL) },
    { name: SKILL_NAME, body: missingActivationClause() },
  ];
  await withHarness([reply(conforming())], async ({ repoRoot, provider }) => {
    const result = await repairGeneratedSkills({
      repoRoot,
      skills,
      violations: violationsFor(skills),
      provider: "openai",
      model: "local-test-model",
    });

    assert.equal(provider.calls.length, 1);
    assert.deepEqual(result.repairedSkillNames, [SKILL_NAME]);
    assert.deepEqual(result.skills, [
      { name: OTHER_SKILL, body: conforming(OTHER_SKILL) },
      { name: SKILL_NAME, body: conforming() },
    ]);
    assert.deepEqual(violationsFor(result.skills), []);
  });
});

test("a repair that answers for a different skill is refused", async () => {
  const skills: GeneratedSkill[] = [{ name: SKILL_NAME, body: missingActivationClause() }];
  await withHarness(
    [reply(conforming("some-other-skill"), "some-other-skill")],
    async ({ repoRoot, provider }) => {
      await assert.rejects(
        repairGeneratedSkills({
          repoRoot,
          skills,
          violations: violationsFor(skills),
          provider: "openai",
          model: "local-test-model",
        }),
        (error: unknown) =>
          error instanceof Error && /some-other-skill/.test(error.message),
      );

      assert.equal(provider.calls.length, 1);
    },
  );
});

test("a document that still breaks the specification after one repair ends the build", async () => {
  const skills: GeneratedSkill[] = [{ name: SKILL_NAME, body: missingActivationClause() }];
  await withHarness(
    [reply(missingActivationClause())],
    async ({ repoRoot, provider }) => {
      await assert.rejects(
        repairGeneratedSkills({
          repoRoot,
          skills,
          violations: violationsFor(skills),
          provider: "openai",
          model: "local-test-model",
        }),
        (error: unknown) =>
          error instanceof Error &&
          /says what the skill is about but not when to use it/.test(error.message),
      );

      assert.equal(
        provider.calls.length,
        1,
        "one repair per skill, never a second round",
      );
    },
  );
});

test("a folder name the specification rejects is never sent for repair", async () => {
  const skills: GeneratedSkill[] = [{
    name: "Counterparty_Screening",
    body: missingActivationClause("Counterparty_Screening"),
  }];
  await withHarness([reply(conforming())], async ({ repoRoot, provider }) => {
    await assert.rejects(
      repairGeneratedSkills({
        repoRoot,
        skills,
        violations: violationsFor(skills),
        provider: "openai",
        model: "local-test-model",
      }),
      (error: unknown) => error instanceof SkillSpecViolationError,
    );

    assert.equal(provider.calls.length, 0);
  });
});

test("two generated skills claiming one folder are never sent for repair", async () => {
  const skills: GeneratedSkill[] = [
    { name: SKILL_NAME, body: conforming() },
    { name: SKILL_NAME, body: missingActivationClause() },
  ];
  await withHarness([reply(conforming())], async ({ repoRoot, provider }) => {
    await assert.rejects(
      repairGeneratedSkills({
        repoRoot,
        skills,
        violations: violationsFor(skills),
        provider: "openai",
        model: "local-test-model",
      }),
      (error: unknown) => error instanceof SkillSpecViolationError,
    );

    assert.equal(provider.calls.length, 0);
  });
});
