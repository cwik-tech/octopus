/**
 * A planned Agent whose generated skill breaks the Agent Skills specification.
 *
 * The Agent Architect sometimes writes a `description` that says what a skill
 * is about and never says when to use it. Every regeneration reproduces it, so
 * the Retry button cannot get past it and the whole Agent is lost. One bounded
 * repair call, before anything is staged, is what makes the build finish.
 *
 * The provider is a real loopback HTTP server because the repair is a second
 * conversation: what it is told about the broken document, and the fact that
 * it happens at all, are only observable from the calls that arrive.
 *
 * The batch runs at concurrency 1 deliberately. That is the capacity the
 * generation gate has for a single-Agent build, and it is the shape in which a
 * repair that waited for a permit `generateOne` already holds would never
 * return.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { PlannedAgentSpec } from "../../contracts/agent-generator.js";
import type { ResourceBuildEventType } from "../../contracts/resource-architect.js";
import {
  buildPlannedAgents,
  type PlannedAgentBuildUpdate,
} from "../../domains/agent-generator/planned-agent-builder.js";
import { findSkillBatchViolations } from "../../domains/agent-generator/skill-spec-validation.js";
import { ResourceLibraryService } from "../../services/resource-library-service.js";

const AGENT_NAME = "crypto-risk-compliance-analyst";
const SKILL_NAME = "crypto-scam-and-security-hygiene";

const PLANNED: PlannedAgentSpec = {
  name: AGENT_NAME,
  role: "Crypto risk and compliance analyst",
  description: "Assesses crypto counterparty risk and compliance exposure.",
  rationale: "No existing Agent covers crypto compliance.",
};

/** A description that names a subject and never says when to use the skill. */
function violatingSkillBody(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: Guidance on crypto scam awareness and security hygiene.",
    "---",
    "",
    "# Crypto Scam and Security Hygiene",
    "",
    "1. Check the counterparty.",
    "",
  ].join("\n");
}

/** The same skill with the activation clause the specification requires. */
function repairedSkillBody(): string {
  return [
    "---",
    `name: ${SKILL_NAME}`,
    "description: >",
    "  Screen a crypto counterparty for scam patterns and weak key hygiene.",
    "  Use when onboarding a new counterparty, reviewing a suspicious",
    "  transfer request, or auditing wallet custody practices.",
    "---",
    "",
    "# Crypto Scam and Security Hygiene",
    "",
    "1. Check the counterparty.",
    "",
  ].join("\n");
}

function persona(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} persona.`,
    "tier: specialist",
    "provider: openai",
    "model: local-test-model",
    "thinking: medium",
    "tools: none",
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

interface ProviderCall {
  system: string;
  messages: Array<{ role?: string; content?: string }>;
}

interface ProviderHarness {
  url: string;
  calls: ProviderCall[];
  close(): Promise<void>;
}

/**
 * Answers the architect with a draft, and the repair with a corrected file.
 *
 * The two calls are told apart by the system prompt each boundary sends, so
 * neither answer depends on the order the calls happen to arrive in.
 */
async function startProvider(): Promise<ProviderHarness> {
  const calls: ProviderCall[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = readMessages(body);
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      calls.push({
        system,
        messages: messages.filter((message) => message.role !== "system"),
      });
      const content = system.includes("# Skill Repair")
        ? JSON.stringify({ name: SKILL_NAME, body: repairedSkillBody() })
        : JSON.stringify({
          message: `Created ${AGENT_NAME}.`,
          suggestedName: AGENT_NAME,
          personaMarkdown: persona(AGENT_NAME),
          generatedSkills: [{ name: SKILL_NAME, body: violatingSkillBody() }],
        });
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

function readMessages(body: unknown): Array<{ role?: string; content?: string }> {
  if (typeof body !== "object" || body === null || !("messages" in body)) return [];
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const role = "role" in entry && typeof entry.role === "string" ? entry.role : undefined;
    const content = "content" in entry && typeof entry.content === "string"
      ? entry.content
      : undefined;
    return [{ ...(role === undefined ? {} : { role }), ...(content === undefined ? {} : { content }) }];
  });
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planned-agent-skill-repair-"));
  for (const architect of ["workflow-architect", "resource-architect"]) {
    const teamDir = path.join(repoRoot, "teams", architect);
    const agentDir = path.join(repoRoot, "agents", architect);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "team.yaml"),
      [
        "team:",
        `  name: ${architect}`,
        "agents:",
        `  - name: ${architect}`,
        `    agent_file: ../../agents/${architect}/${architect}.md`,
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(agentDir, `${architect}.md`),
      // The architect runs with its own agent file's pair.
      "---\nprovider: openai\nmodel: local-test-model\n---\n\n" + ("Create one complete Agent package from the brief.\n"),
    );
  }
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  return repoRoot;
}

async function withHarness(
  run: (context: { repoRoot: string; provider: ProviderHarness }) => Promise<void>,
): Promise<void> {
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
    restoreEnv("OPENAI_API_KEY", previousKey);
    restoreEnv("WORKFLOW_GENERATOR_OPENAI_API_URL", previousUrl);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/** Every receipt still on disk under the staging root, if it still exists. */
function stagedReceipts(repoRoot: string): string[] {
  const root = path.join(repoRoot, ".create-orchestrator", "staged-agents");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "receipt.json")
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("a planned Agent whose skill omits its activation clause is repaired and published", async () => {
  await withHarness(async ({ repoRoot, provider }) => {
    const updates: PlannedAgentBuildUpdate[] = [];
    const library = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: repoRoot, rootPath: path.join(repoRoot, ".test-library") });
    await library.initialize();

    const result = await buildPlannedAgents({
      repoRoot,
      planId: "crypto-plan",
      resourcePublisher: library,
      jobId: "crypto-job",
      agents: [PLANNED],
      maxConcurrency: 1,
      provider: "openai",
      model: "local-test-model",
      onUpdate: (update) => {
        updates.push(update);
      },
    });

    assert.equal(result.items[0]?.status, "created");
    assert.deepEqual(result.items[0]?.resource, { kind: "agent", id: AGENT_NAME });

    const repaired: ResourceBuildEventType = "skill_repaired";
    const repairEvent = updates.find((update) => update.eventType === repaired);
    assert.ok(repairEvent, "the build must report that a skill was repaired");
    assert.match(repairEvent.message, new RegExp(SKILL_NAME));

    const published = fs.readFileSync(
      path.join(repoRoot, "agents", AGENT_NAME, "skills", SKILL_NAME, "SKILL.md"),
      "utf8",
    );
    assert.deepEqual(
      findSkillBatchViolations([{
        origin: "generated",
        folderName: SKILL_NAME,
        source: published,
        skillPath: `skills/${SKILL_NAME}/SKILL.md`,
      }]),
      [],
    );

    assert.deepEqual(stagedReceipts(repoRoot), []);
    assert.equal(provider.calls.length, 2);
    const catalog = await library.store.getSnapshot();
    assert.equal(catalog.agents.find((agent) => agent.id === AGENT_NAME)?.attachments[0]?.alias, SKILL_NAME);
  });
});
