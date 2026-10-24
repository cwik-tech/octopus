/**
 * Several Agents updated by one plan, and the budget those updates share.
 *
 * Two things are under test and they pull in opposite directions. Operations
 * on different Agents must not reach into each other: each publishes only the
 * skills its own operation named. And however many operations run at once,
 * and however many skills each of them authors, the number of provider calls
 * in flight must stay inside the one configured budget — an operation that
 * built its own semaphore would multiply the cap by the number of operations.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ResourceBuildJobSnapshot,
  ResourceUpdatePlan,
} from "../../contracts/resource-architect.js";
import { computeAgentRevision } from "../../domains/agent-generator/agent-revision.js";
import { createResourceBuildSnapshot } from "../../services/resource-architect-service.js";
import { runResourceUpdateBuild } from "../../services/resource-update-executor.js";
import { createResourceUpdateGate } from "../../services/resource-update-gate.js";
import type { PlannedAgentGenerationGate } from "../../domains/agent-generator/planned-agent-builder.js";

const FIRST_AGENT = "michigan-contract-lawyer";
const SECOND_AGENT = "scoping-lawyer";
const SKILLS: Record<string, string[]> = {
  [FIRST_AGENT]: ["termination-clause-review", "indemnity-clause-review"],
  [SECOND_AGENT]: ["scope-boundary-review", "deliverable-acceptance-review"],
};

function authored(name: string): string {
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
    "Check the clause.",
    "",
  ].join("\n");
}

interface ProviderHarness {
  url: string;
  callCount(): number;
  close(): Promise<void>;
}

/** Answers every authoring call immediately and counts them. */
async function startCountingProvider(): Promise<ProviderHarness> {
  let callCount = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const asked = (body.messages ?? [])
        .filter((message) => message.role !== "system")
        .map((message) => message.content)
        .join("\n");
      const name = asked.match(/Skill folder name:\s*`([^`]+)`/)?.[1] ?? "unknown-skill";
      callCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content: JSON.stringify({ name, body: authored(name) }) } }],
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
    callCount: () => callCount,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/**
 * The shared budget, watched from the inside.
 *
 * Counting requests that happen to overlap on the wire measures the scheduler
 * as much as the code: a call answered instantly may finish before the next
 * one starts, and no overlap proves nothing either way. Watching the budget
 * itself is exact — how many callers hold it at once, and whether every
 * provider call asked for it at all.
 */
function watchGate(capacity: number): PlannedAgentGenerationGate & {
  acquisitions(): number;
  peak(): number;
  outstanding(): number;
} {
  const budget = createResourceUpdateGate(capacity);
  let held = 0;
  let peak = 0;
  let acquisitions = 0;
  return {
    acquire: async (signal?: AbortSignal) => {
      await budget.acquire(signal);
      acquisitions += 1;
      held += 1;
      peak = Math.max(peak, held);
    },
    release: () => {
      held -= 1;
      budget.release();
    },
    acquisitions: () => acquisitions,
    peak: () => peak,
    outstanding: () => held,
  };
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-update-concurrency-"));
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
  for (const agentId of [FIRST_AGENT, SECOND_AGENT]) {
    const agentDir = path.join(repoRoot, "agents", agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, `${agentId}.md`),
      `---\nname: ${agentId}\ndescription: Reviews contracts.\ntier: strategic\n---\n\n# ${agentId}\n`,
    );
  }
  return repoRoot;
}

function makePlan(repoRoot: string): ResourceUpdatePlan {
  return {
    id: "concurrency-plan",
    kind: "resource_updates",
    operations: [FIRST_AGENT, SECOND_AGENT].map((agentId) => ({
      kind: "update_agent_skills" as const,
      target: { kind: "agent" as const, id: agentId },
      expectedRevision: computeAgentRevision(repoRoot, agentId),
      skillUpdates: SKILLS[agentId]!.map((name) => ({
        action: "create" as const,
        name,
        instruction: `Author the ${name} procedure.`,
      })),
    })),
  };
}

function skillNames(repoRoot: string, agentId: string): string[] {
  const skillsDir = path.join(repoRoot, "agents", agentId, "skills");
  return fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
}

async function runBatch(options: {
  /** How many operations may run at once. */
  operations: number;
  /** The provider budget the whole job shares. */
  provider: number;
}): Promise<{
  repoRoot: string;
  job: ResourceBuildJobSnapshot;
  gate: ReturnType<typeof watchGate>;
  calls: number;
}> {
  const repoRoot = makeRepo();
  const provider = await startCountingProvider();
  const gate = watchGate(options.provider);
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    const plan = makePlan(repoRoot);
    const job = createResourceBuildSnapshot({ plan, jobId: "job-1" });
    await runResourceUpdateBuild({
      repoRoot,
      plan,
      job,
      store: { saveJob: async () => undefined },
      maxConcurrency: options.operations,
      // The budget is smaller than the number of operations on purpose: what
      // is being watched is whether the operations share it.
      generationGate: gate,
      provider: "openai",
      model: "local-test-model",
    });
    return { repoRoot, job, gate, calls: provider.callCount() };
  } finally {
    await provider.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
  }
}

test("two Agents updated by one plan each receive only their own skills", async () => {
  const { repoRoot, job } = await runBatch({ operations: 2, provider: 2 });
  try {
    assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
    assert.deepEqual(job.items.map((item) => item.status), ["updated", "updated"]);
    assert.deepEqual(
      job.items.map((item) => item.plannedResource.id),
      [FIRST_AGENT, SECOND_AGENT],
    );
    assert.deepEqual(skillNames(repoRoot, FIRST_AGENT), [...SKILLS[FIRST_AGENT]!].sort());
    assert.deepEqual(skillNames(repoRoot, SECOND_AGENT), [...SKILLS[SECOND_AGENT]!].sort());
    for (const agentId of [FIRST_AGENT, SECOND_AGENT]) {
      for (const name of SKILLS[agentId]!) {
        assert.equal(
          fs.readFileSync(
            path.join(repoRoot, "agents", agentId, "skills", name, "SKILL.md"),
            "utf8",
          ),
          authored(name),
        );
      }
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * One budget for the whole job. Four skills across two operations, and never
 * more than the configured number of provider calls in flight — which is the
 * property a per-operation semaphore would quietly break.
 */
test("the provider budget bounds the whole job, not each operation", async () => {
  for (const budget of [1, 2]) {
    // Both operations are allowed to run at once. Only the shared budget can
    // keep the provider calls inside it.
    const { repoRoot, job, gate, calls } = await runBatch({
      operations: 2,
      provider: budget,
    });
    try {
      assert.equal(job.status, "completed", JSON.stringify(job, null, 2));
      assert.equal(calls, 4, "one authoring call per requested skill");
      assert.equal(
        gate.acquisitions(),
        4,
        "every authoring call asks the shared budget for room, including repairs",
      );
      assert.ok(
        gate.peak() <= budget,
        `expected at most ${budget} calls holding the budget, saw ${gate.peak()}`,
      );
      assert.equal(gate.outstanding(), 0, "every slot taken is given back");
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }
});
