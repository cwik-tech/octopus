import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import { startApiServer } from "../../server/api-server.js";
import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import {
  assertAgentNameIsNotReserved,
  reservePlannedAgentName,
} from "../../domains/agent-generator/agent-name-reservation.js";
import { TeamFileStore } from "../../domains/team-files/team-file-store.js";
import { SourceFileParserLauncher } from "../../core/file-parser-launcher.js";
import {
  createResourceBuildSnapshot,
  launchBackgroundResourceBuild,
} from "../../services/resource-architect-service.js";
import { CreateJobRegistry } from "../../server/create-job-registry.js";
import { restorableResourceBuildJob } from "../../contracts/resource-build-recovery.js";
import { createTeamBuildShell } from "../../domains/resource-architect/team-build-shell.js";
import type { ResourceArchitectTurnMetric } from "../../contracts/resource-architect.js";
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from "../../domains/provider/default-model-selection.js";

const plannedNames = [
  "michigan-contract-lawyer",
  "commercial-risk-lawyer",
  "drafting-completeness-lawyer",
];

interface ProviderHarness {
  close(): Promise<void>;
  generationBriefs(): string[];
  maxGenerationConcurrency(): number;
  planningMessages(): string[];
  requestedModels(): unknown[];
  url: string;
}

interface ResourceBuildJobView {
  jobId?: string;
  status: string;
  selectedResource: { kind: string; id: string } | null;
  items: Array<{
    planIndex: number;
    status: string;
    plannedResource: { kind: string; id: string };
    resource?: { kind: string; id: string };
    error?: string;
  }>;
  events?: Array<{ type: string; message: string }>;
  error?: string;
}

function makeDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeArchitectConfig(repoRoot: string, resourceModel = "local-test-model"): void {
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
      `---\nprovider: openai\nmodel: ${architect === "resource-architect" ? resourceModel : "local-test-model"}\n---\n\n` + (architect === "resource-architect"
        ? "RESOURCE_ARCHITECT_RESPONSE_SCHEMA\n"
        : "Create one complete Agent package from the brief.\n"),
    );
  }
}

function writeAgent(repoRoot: string, name: string, body: string): void {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, `${name}.md`), body);
}

function persona(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description.`,
    "tier: specialist",
    "provider: openai",
    "model: local-test-model",
    "thinking: medium",
    "tools: none",
    "---",
    "",
    `# ${name}`,
    "",
    "## Purpose",
    "",
    `Perform the ${name} assignment independently.`,
    "",
  ].join("\n");
}

async function startProviderHarness(
  expectedGenerationCount = plannedNames.length,
): Promise<ProviderHarness> {
  const generationBriefs: string[] = [];
  const planningMessages: string[] = [];
  const requestedModels: unknown[] = [];
  let activeGenerationRequests = 0;
  let maximumGenerationRequests = 0;
  let releaseGeneration!: () => void;
  const allGenerationRequestsArrived = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  let barrierTimeout: NodeJS.Timeout | undefined;

  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: unknown;
        messages?: Array<{ role?: string; content?: string }>;
      };
      requestedModels.push(body.model);
      const system = body.messages?.find((message) => message.role === "system")
        ?.content ?? "";
      const lastUser = [...(body.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";

      let content: string;
      if (system.trimStart().startsWith("RESOURCE_ARCHITECT_RESPONSE_SCHEMA")) {
        planningMessages.push(
          (body.messages ?? []).map((message) => message.content ?? "").join("\n"),
        );
        const teamRequested = /\bteam\b/i.test(lastUser);
        content = JSON.stringify({
          message: teamRequested
            ? "I will create a contract review team."
            : "I will create these three standalone lawyers.",
          outcome: teamRequested
            ? {
                id: "lawyers-team-plan",
                kind: "team",
                team: {
                  teamId: "contract-review-team",
                  description: "Reviews contracts from complementary legal perspectives.",
                  tags: ["legal"],
                  existingAgents: [{
                    name: "scoping-lawyer",
                    role: "Scope reviewer",
                    tier: "specialist",
                    rationale: "Reuse the existing scope specialist.",
                  }],
                  documentDomains: [{
                    domain: "Michigan contract limitation analysis",
                    evidenceAnchors: ["Michigan limitation period"],
                  }],
                  newAgents: plannedNames.map((name, index) => ({
                    name,
                    role: `${name} role`,
                    tier: "specialist",
                    summary: `${name} summary`,
                    description: `${name} description`,
                    rationale: "Requested for the contract review team.",
                    ...(index === 0 ? {
                      documentSpecialization: {
                        expertiseDomain: "Michigan contract limitation analysis",
                        focus: "Assess the limitation period in the supplied contract evidence.",
                        evidenceAnchors: ["Michigan limitation period", "TEAM-CONTRACT-CONTEXT"],
                        assessmentTargets: ["limitation period", "accrual trigger"],
                        outOfScope: ["General contract negotiation"],
                      },
                    } : {}),
                  })),
                  questionsResolved: ["three complementary reviewers"],
                },
              }
            : {
                id: "three-lawyers-plan",
                kind: "standalone_agents",
                agents: plannedNames.map((name) => ({
                  name,
                  role: `${name} role`,
                  tier: "specialist",
                  summary: `${name} summary`,
                  description: `${name} description`,
                  rationale: "Requested as an independent contract reviewer.",
                })),
              },
          warnings: [],
        });
      } else {
        generationBriefs.push(lastUser);
        const plannedName =
          lastUser.match(/Planned Agent name:\s*`([^`]+)`/i)?.[1] ??
          lastUser.match(/Create the missing agent\s*`([^`]+)`/i)?.[1];
        assert.ok(plannedName, `generation brief must contain a planned name: ${lastUser}`);
        activeGenerationRequests += 1;
        if (!barrierTimeout) {
          barrierTimeout = setTimeout(releaseGeneration, 1_000);
          barrierTimeout.unref();
        }
        maximumGenerationRequests = Math.max(
          maximumGenerationRequests,
          activeGenerationRequests,
        );
        if (maximumGenerationRequests === expectedGenerationCount) {
          releaseGeneration();
        }
        await allGenerationRequestsArrived;
        content = JSON.stringify({
          message: `Created ${plannedName}.`,
          suggestedName: plannedName,
          personaMarkdown: persona(plannedName),
          generatedSkills: [
            {
              name: `${plannedName}-review`,
              body: `---\nname: ${plannedName}-review\ndescription: Review a draft against the method. Use when a draft needs a structured review pass.\n---\n\n# Review\n`,
            },
          ],
        });
        activeGenerationRequests -= 1;
      }

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
    generationBriefs: () => [...generationBriefs],
    maxGenerationConcurrency: () => maximumGenerationRequests,
    planningMessages: () => [...planningMessages],
    requestedModels: () => [...requestedModels],
    close: () => new Promise<void>((resolve, reject) => {
      if (barrierTimeout) clearTimeout(barrierTimeout);
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("standalone multi-Agent creation preserves the selected Agent and publishes the planned names in parallel", async () => {
  const workspacePath = makeDirectory("resource-architect-workspace-");
  const repoRoot = makeDirectory("resource-architect-repo-");
  const provider = await startProviderHarness();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeArchitectConfig(repoRoot);
  // The paid provider is replaced only at its HTTP boundary. Distinct models
  // reproduce the untouched picker: chat inherits the app default, while the
  // unrelated Workflow Architect has its own pinned model.
  const previousDefault = getRuntimeDefaultModelState();
  fs.writeFileSync(path.join(repoRoot, "agents/resource-architect/resource-architect.md"),
    "RESOURCE_ARCHITECT_RESPONSE_SCHEMA\n");
  const scopingPersona = `${persona("scoping-lawyer")}\nOriginal scope boundary.\n`;
  writeAgent(repoRoot, "scoping-lawyer", scopingPersona);

  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
    teamFileStore: new TeamFileStore(workspacePath),
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
  });

  try {
    setRuntimeDefaultModelState({ status: "available", provider: "openai", model: "resource-default" });
    const draftId = "standalone-lawyer-context";
    const contextMarker = "ACME-MICHIGAN-CONTRACT-FACTS";
    const uploadResponse = await fetch(
      `${api.url}/create/team-files/${draftId}/files`,
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-filename": "contract-context.txt",
        },
        body: `${contextMarker}: review the limitation period.`,
      },
    );
    assert.equal(uploadResponse.status, 201);
    const turnResponse = await fetch(`${api.url}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draftId,
        operation: "proposal",
        history: [
          {
            role: "user",
            text: "Create for me now the other three lawyers.",
          },
        ],
      }),
    });
    const turn = (await turnResponse.json()) as {
      outcome: {
        id: string;
        kind: string;
        agents: Array<{ name: string }>;
      };
    };
    assert.equal(turnResponse.status, 200);
    assert.equal(turn.outcome.kind, "standalone_agents");
    assert.deepEqual(turn.outcome.agents.map((agent) => agent.name), plannedNames);
    assert.deepEqual(
      plannedNames.map((name) => fs.existsSync(path.join(repoRoot, "agents", name))),
      [false, false, false],
      "planning must not write Agent folders",
    );
    const metricsResponse = await fetch(
      `${api.url}/create/resource-architect/metrics`,
    );
    const metricsPayload = (await metricsResponse.json()) as {
      metrics: ResourceArchitectTurnMetric[];
    };
    assert.equal(metricsResponse.status, 200);
    assert.equal(metricsPayload.metrics.length, 1);
    assert.equal(metricsPayload.metrics[0]?.operation, "proposal");
    assert.equal(metricsPayload.metrics[0]?.status, "completed");
    assert.equal(metricsPayload.metrics[0]?.outcomeKind, "standalone_agents");
    assert.equal(metricsPayload.metrics[0]?.provider, "openai");
    assert.equal(metricsPayload.metrics[0]?.reasoning, "medium");
    assert.ok((metricsPayload.metrics[0]?.timing.totalDurationMs ?? 0) > 0);

    const buildResponse = await fetch(`${api.url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: turn.outcome.id, draftId }),
    });
    const build = (await buildResponse.json()) as { jobId: string };
    assert.equal(buildResponse.status, 202);

    let job: ResourceBuildJobView | null = null;
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const response = await fetch(
        `${api.url}/create/resource-architect/jobs/${encodeURIComponent(build.jobId)}`,
      );
      const payload = (await response.json()) as {
        job: ResourceBuildJobView | null;
      };
      job = payload.job;
      if (job && job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(job?.status, "completed", JSON.stringify(job, null, 2));
    assert.deepEqual(
      job?.items.map((item) => ({
        name: item.plannedResource.id,
        status: item.status,
        publishedName: item.resource?.id,
      })),
      plannedNames.map((name) => ({
        name,
        status: "created",
        publishedName: name,
      })),
    );
    assert.deepEqual(job?.selectedResource, {
      kind: "agent",
      id: plannedNames[0],
    });
    assert.equal(provider.maxGenerationConcurrency(), 3);
    assert.deepEqual([...new Set(provider.requestedModels())], ["resource-default"],
      "chat and Create must use the Resource Architect's inherited model, never the Workflow Architect's model");
    assert.equal(
      provider.planningMessages().every((message) => message.includes(contextMarker)),
      true,
      "uploaded context must ground resource planning",
    );
    assert.equal(
      provider.generationBriefs().every((message) => message.includes(contextMarker)),
      true,
      "uploaded context must ground each planned Agent generation",
    );
    assert.equal(
      fs.readFileSync(
        path.join(repoRoot, "agents", "scoping-lawyer", "scoping-lawyer.md"),
        "utf8",
      ),
      scopingPersona,
    );
    assert.deepEqual(
      plannedNames.map((name) =>
        fs.readFileSync(path.join(repoRoot, "agents", name, `${name}.md`), "utf8")
          .match(/^name:\s*(.+)$/m)?.[1],
      ),
      plannedNames,
    );
    assert.deepEqual(
      fs.existsSync(path.join(repoRoot, "teams"))
        ? fs.readdirSync(path.join(repoRoot, "teams")).sort()
        : [],
      ["resource-architect", "workflow-architect"],
      "standalone Agent creation must not create a Team",
    );
  } finally {
    setRuntimeDefaultModelState(previousDefault);
    await api.close();
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a post-plan name collision yields a partial batch without suffixing or overwriting", async () => {
  const workspacePath = makeDirectory("resource-collision-workspace-");
  const repoRoot = makeDirectory("resource-collision-repo-");
  const provider = await startProviderHarness(2);
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeArchitectConfig(repoRoot);
  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });

  try {
    const turnResponse = await fetch(`${api.url}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "proposal",
        history: [{ role: "user", text: "Create three standalone lawyers now." }],
      }),
    });
    const turn = (await turnResponse.json()) as {
      outcome: { id: string; agents: Array<{ name: string }> };
    };
    assert.equal(turnResponse.status, 200);

    const racedPersona = `${persona(plannedNames[0]!)}\nCreated by another operation.\n`;
    writeAgent(repoRoot, plannedNames[0]!, racedPersona);

    const buildResponse = await fetch(`${api.url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: turn.outcome.id }),
    });
    const build = (await buildResponse.json()) as { jobId: string };
    assert.equal(buildResponse.status, 202);

    let job: ResourceBuildJobView | null = null;
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const response = await fetch(
        `${api.url}/create/resource-architect/jobs/${encodeURIComponent(build.jobId)}`,
      );
      job = ((await response.json()) as { job: ResourceBuildJobView }).job;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(job?.status, "partially_completed", JSON.stringify(job, null, 2));
    assert.deepEqual(
      job?.items.map((item) => item.status),
      ["needs_input", "created", "created"],
    );
    assert.deepEqual(job?.selectedResource, {
      kind: "agent",
      id: plannedNames[1],
    });
    assert.equal(provider.maxGenerationConcurrency(), 2);
    assert.equal(
      fs.readFileSync(
        path.join(repoRoot, "agents", plannedNames[0]!, `${plannedNames[0]}.md`),
        "utf8",
      ),
      racedPersona,
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", `${plannedNames[0]}-2`)),
      false,
      "a collision must never create a suffixed Agent",
    );
  } finally {
    await api.close();
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a legacy stored plan ignores model intent and builds only after a planId request", async () => {
  const workspacePath = makeDirectory("resource-legacy-plan-workspace-");
  const repoRoot = makeDirectory("resource-legacy-plan-repo-");
  const provider = await startProviderHarness(1);
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeArchitectConfig(repoRoot);
  const legacyPlan = {
    id: "legacy-intent-plan",
    kind: "standalone_agents" as const,
    intent: "create_now",
    agents: [{
      name: plannedNames[0]!,
      role: "Reviewer",
      tier: "specialist",
      description: "Reviews Michigan contracts.",
      rationale: "Legacy compatibility coverage.",
    }],
  };
  await new ResourceArchitectStore(workspacePath).savePlan(legacyPlan);

  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });

  try {
    assert.equal(
      fs.existsSync(path.join(repoRoot, "agents", plannedNames[0]!)),
      false,
      "loading legacy intent must not start a build",
    );
    const buildResponse = await fetch(`${api.url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: legacyPlan.id }),
    });
    const build = (await buildResponse.json()) as { jobId: string };
    assert.equal(buildResponse.status, 202);

    let job: ResourceBuildJobView | null = null;
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const response = await fetch(
        `${api.url}/create/resource-architect/jobs/${encodeURIComponent(build.jobId)}`,
      );
      job = ((await response.json()) as { job: ResourceBuildJobView }).job;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(job?.status, "completed", JSON.stringify(job, null, 2));
    assert.equal(
      fs.existsSync(
        path.join(repoRoot, "agents", plannedNames[0]!, `${plannedNames[0]}.md`),
      ),
      true,
    );
  } finally {
    await api.close();
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a restarted API makes an interrupted resource build retryable and releases its name claims", async () => {
  const workspacePath = makeDirectory("resource-restart-workspace-");
  const repoRoot = makeDirectory("resource-restart-repo-");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeArchitectConfig(repoRoot);
  const durableStore = new ResourceArchitectStore(workspacePath);
  const plan = {
    id: "interrupted-lawyer-plan",
    kind: "standalone_agents" as const,
    agents: [
      {
        name: plannedNames[0]!,
        role: "Reviewer",
        tier: "specialist",
        description: "Reviews Michigan contracts.",
        rationale: "Requested by the user.",
      },
    ],
  };
  const job = createResourceBuildSnapshot({
    plan,
    jobId: "interrupted-lawyer-job",
  });
  await durableStore.savePlan(plan);
  await durableStore.saveJob(job);
  await reservePlannedAgentName({
    repoRoot,
    planId: plan.id,
    jobId: job.jobId,
    name: plannedNames[0]!,
  });

  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });

  try {
    const singleResponse = await fetch(
      `${api.url}/create/resource-architect/jobs/${encodeURIComponent(job.jobId)}`,
    );
    const singlePayload = (await singleResponse.json()) as {
      job: ResourceBuildJobView;
    };

    assert.equal(singleResponse.status, 200);
    assert.equal(singlePayload.job.status, "running");
    assert.throws(() => assertAgentNameIsNotReserved(repoRoot, plannedNames[0]!));

    const response = await fetch(`${api.url}/create/resource-architect/jobs`);
    const payload = (await response.json()) as {
      jobs: ResourceBuildJobView[];
    };

    assert.equal(response.status, 200);
    // Interrupted, not failed: the application stopped the work, and Create
    // keeps interrupted work recoverable while a failure is terminal.
    assert.equal(payload.jobs[0]?.status, "interrupted");
    assert.equal(payload.jobs[0]?.items[0]?.status, "interrupted");
    assert.deepEqual(payload.jobs[0]?.events?.at(-1), {
      id: 2,
      type: "build_interrupted",
      message: "Resource build was interrupted by an API restart. Retry the build to continue.",
    });
    assert.doesNotThrow(() =>
      assertAgentNameIsNotReserved(repoRoot, plannedNames[0]!),
    );
  } finally {
    await api.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a restarted API keeps an interrupted Team shell identified but unfinished", async () => {
  const workspacePath = makeDirectory("resource-team-restart-workspace-");
  const repoRoot = makeDirectory("resource-team-restart-repo-");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  const durableStore = new ResourceArchitectStore(workspacePath);
  const plan = {
    id: "interrupted-team-plan",
    kind: "team" as const,
    team: {
      teamId: "interrupted-review-team",
      description: "Reviews interrupted builds.",
      tags: ["review"],
      existingAgents: [],
      newAgents: [{
        name: plannedNames[0]!,
        role: "Reviewer",
        tier: "specialist",
        description: "Reviews interrupted builds.",
        rationale: "Requested by the user.",
      }],
      questionsResolved: [],
    },
  };
  const job = createResourceBuildSnapshot({
    plan,
    jobId: "interrupted-team-job",
  });
  const team = await createTeamBuildShell({
    repoRoot,
    plan: plan.team,
    orchestratorKey: plan.id,
  });
  job.items[0] = { ...job.items[0]!, status: "generating" };
  job.events.push({
    id: job.events.length + 1,
    type: "team_created",
    plannedResource: { kind: "team", id: team.id },
    message: `Created Team shell \`${team.id}\`.`,
  });
  await durableStore.savePlan(plan);
  await durableStore.saveJob(job);

  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });

  try {
    const response = await fetch(`${api.url}/create/resource-architect/jobs`);
    const payload = (await response.json()) as { jobs: ResourceBuildJobView[] };

    assert.equal(response.status, 200);
    // Unfinished, and said to be. The shell exists from the first moment of a
    // Team build and was never published: it has no roster, it cannot satisfy
    // its own completion gate, and reporting it as created told the user their
    // team was ready and offered to open something that fails when run.
    assert.equal(payload.jobs[0]?.status, "interrupted");
    assert.equal(payload.jobs[0]?.selectedResource, null);
    // Its identity survives the restart, because retry and discard both need
    // to know which shell this build left behind.
    assert.deepEqual(payload.jobs[0]?.items[0], {
      plannedResource: { kind: "team", id: team.id },
      resource: { kind: "team", id: team.id },
      planIndex: 0,
      status: "interrupted",
      error:
        "Resource build was interrupted by an API restart. Retry the build to continue.",
    });
  } finally {
    await api.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

const LEGACY_RESTART_INTERRUPTION =
  "Resource build was interrupted by an API restart. Retry the build to continue.";

/** A stopped build as an earlier release's restart reconciliation saved it. */
function legacyReconciledJob(params: {
  jobId: string;
  planId: string;
  status: "failed" | "partially_completed";
  message: string;
}) {
  const failed = params.status === "failed";
  return {
    jobId: params.jobId,
    planId: params.planId,
    startedAt: "2026-09-19T10:00:00.000Z",
    status: params.status,
    items: [
      ...(failed ? [] : [{
        plannedResource: { kind: "agent" as const, id: "finished-lawyer" },
        resource: { kind: "agent" as const, id: "finished-lawyer" },
        planIndex: 0,
        status: "created" as const,
      }]),
      {
        plannedResource: { kind: "agent" as const, id: "unfinished-lawyer" },
        planIndex: failed ? 0 : 1,
        status: "failed" as const,
        error: params.message,
      },
    ],
    selectedResource: failed ? null : { kind: "agent" as const, id: "finished-lawyer" },
    events: [
      { id: 1, type: "build_started" as const, message: `Started resource plan \`${params.planId}\`.` },
      {
        id: 2,
        type: failed ? "build_failed" as const : "build_partially_completed" as const,
        message: params.message,
      },
    ],
    error: params.message,
  };
}

/** The fields of the jobs list these restart tests read, checked as they arrive. */
const freshApiJobListSchema = z.object({
  jobs: z.array(z.object({
    jobId: z.string(),
    status: z.string(),
    items: z.array(z.object({ status: z.string() })),
    events: z.array(z.object({ type: z.string() })),
    error: z.string().optional(),
  })),
});

async function listJobsFromFreshApi(
  workspacePath: string,
  repoRoot: string,
): Promise<z.infer<typeof freshApiJobListSchema>["jobs"]> {
  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  });
  try {
    const response = await fetch(`${api.url}/create/resource-architect/jobs`);
    assert.equal(response.status, 200);
    return freshApiJobListSchema.parse(await response.json()).jobs;
  } finally {
    await api.close();
  }
}

test("an interruption saved by the earlier restart reconciliation reads back as interrupted", async () => {
  const workspacePath = makeDirectory("resource-legacy-interruption-workspace-");
  const repoRoot = makeDirectory("resource-legacy-interruption-repo-");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  try {
    const durableStore = new ResourceArchitectStore(workspacePath);
    await durableStore.saveJob(legacyReconciledJob({
      jobId: "legacy-interrupted-job",
      planId: "legacy-interrupted-plan",
      status: "failed",
      message: LEGACY_RESTART_INTERRUPTION,
    }));
    await durableStore.saveJob(legacyReconciledJob({
      jobId: "legacy-partial-job",
      planId: "legacy-partial-plan",
      status: "partially_completed",
      message: LEGACY_RESTART_INTERRUPTION,
    }));

    const jobs = await listJobsFromFreshApi(workspacePath, repoRoot);

    const interrupted = jobs.find((job) => job.jobId === "legacy-interrupted-job");
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(interrupted?.items[0]?.status, "interrupted");
    assert.equal(interrupted?.events?.at(-1)?.type, "build_interrupted");
    assert.equal(interrupted?.error, LEGACY_RESTART_INTERRUPTION);
    // Partly finished work stays partly finished; only its stopped item
    // becomes interrupted, and its published item is left exactly as it was.
    const partial = jobs.find((job) => job.jobId === "legacy-partial-job");
    assert.equal(partial?.status, "partially_completed");
    assert.deepEqual(partial?.items.map((item) => item.status), ["created", "interrupted"]);
    assert.equal(partial?.events?.at(-1)?.type, "build_partially_completed");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("quitting the app during a build leaves it interrupted and restorable, not cancelled", async () => {
  const workspacePath = makeDirectory("resource-quit-workspace-");
  const repoRoot = makeDirectory("resource-quit-repo-");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeArchitectConfig(repoRoot);
  // The model is still working when the app quits: it never answers.
  let generationArrived = (): void => {};
  const generating = new Promise<void>((resolve) => { generationArrived = resolve; });
  const provider = http.createServer((request) => {
    request.resume();
    generationArrived();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  try {
    const durableStore = new ResourceArchitectStore(workspacePath);
    const plan = {
      id: "quit-plan",
      kind: "standalone_agents" as const,
      agents: [{
        name: plannedNames[0]!,
        role: "Reviewer",
        description: "Reviews Michigan contracts.",
        rationale: "Requested by the user.",
      }],
    };
    const job = createResourceBuildSnapshot({ plan, jobId: "quit-job" });
    await durableStore.savePlan(plan);
    await durableStore.saveJob(job);
    // The registry the API owns, and the launch the build route makes.
    const registry = new CreateJobRegistry();
    const admitted = registry.start(job.jobId);
    assert.equal(admitted.status, "started");
    if (admitted.status !== "started") return;
    let buildSettled = (): void => {};
    const settled = new Promise<void>((resolve) => { buildSettled = resolve; });
    launchBackgroundResourceBuild(
      {
        repoRoot,
        plan,
        job,
        store: durableStore,
        provider: "openai",
        model: "local-test-model",
        signal: admitted.job.controller.signal,
      },
      { onFailure: () => undefined, onSettled: buildSettled },
    );
    await generating;

    // A normal quit closes the API, and closing the API closes this registry.
    registry.close();
    await settled;
    await listJobsFromFreshApi(workspacePath, repoRoot);

    // The app stopped the work; the user did not. It comes back with Retry.
    const jobs = await new ResourceArchitectStore(workspacePath).listJobs();
    const quit = jobs.find((entry) => entry.jobId === job.jobId);
    assert.equal(quit?.status, "interrupted");
    assert.equal(quit?.events.at(-1)?.type, "build_interrupted");
    assert.equal(restorableResourceBuildJob(jobs)?.jobId, job.jobId);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a build a restart interrupted still reads back as interrupted after the next restart", async () => {
  const workspacePath = makeDirectory("resource-second-restart-workspace-");
  const repoRoot = makeDirectory("resource-second-restart-repo-");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  try {
    const durableStore = new ResourceArchitectStore(workspacePath);
    const plan = {
      id: "second-restart-plan",
      kind: "standalone_agents" as const,
      agents: [{
        name: plannedNames[0]!,
        role: "Reviewer",
        description: "Reviews Michigan contracts.",
        rationale: "Requested by the user.",
      }],
    };
    await durableStore.savePlan(plan);
    await durableStore.saveJob(createResourceBuildSnapshot({ plan, jobId: "second-restart-job" }));
    // The first restart finds the build running with nothing behind it, and
    // writes the interruption.
    const [reconciled] = await listJobsFromFreshApi(workspacePath, repoRoot);
    assert.equal(reconciled?.status, "interrupted");

    // A second restart has only that file to go on. Its reader fails closed on
    // any status or event it does not know, which would lose the build.
    const jobs = await listJobsFromFreshApi(workspacePath, repoRoot);

    const [job] = jobs;
    assert.equal(jobs.length, 1);
    assert.equal(job?.jobId, "second-restart-job");
    assert.equal(job?.status, "interrupted");
    assert.equal(job?.items[0]?.status, "interrupted");
    assert.equal(job?.events?.at(-1)?.type, "build_interrupted");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a provider failure that mentions an interruption stays a terminal failure", async () => {
  const workspacePath = makeDirectory("resource-provider-interruption-workspace-");
  const repoRoot = makeDirectory("resource-provider-interruption-repo-");
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  const providerMessage = "The provider stream was interrupted by the upstream service.";
  try {
    await new ResourceArchitectStore(workspacePath).saveJob(legacyReconciledJob({
      jobId: "provider-failure-job",
      planId: "provider-failure-plan",
      status: "failed",
      message: providerMessage,
    }));

    const [job] = await listJobsFromFreshApi(workspacePath, repoRoot);

    assert.equal(job?.status, "failed");
    assert.equal(job?.items[0]?.status, "failed");
    assert.equal(job?.events?.at(-1)?.type, "build_failed");
    assert.equal(job?.error, providerMessage);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("Team creation generates planned Agents in parallel and binds the roster in plan order", async () => {
  const workspacePath = makeDirectory("resource-team-workspace-");
  const repoRoot = makeDirectory("resource-team-repo-");
  const provider = await startProviderHarness();
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  fs.writeFileSync(path.join(repoRoot, "teams.yaml"), "");
  writeArchitectConfig(repoRoot, "team-authoring");
  writeAgent(repoRoot, "scoping-lawyer", persona("scoping-lawyer"));
  const teamFileStore = new TeamFileStore(workspacePath);
  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
    teamFileStore,
    fileParserLauncher: new SourceFileParserLauncher(process.cwd()),
  });

  try {
    const draftId = "contract-team-context";
    const upload = await fetch(`${api.url}/create/team-files/${draftId}/files`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-filename": "team-contract.txt",
      },
      body: "TEAM-CONTRACT-CONTEXT: assess the Michigan limitation period.",
    });
    assert.equal(upload.status, 201);
    const turnResponse = await fetch(`${api.url}/create/resource-architect/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draftId,
        operation: "proposal",
        history: [{
          role: "user",
          text: "Create a team with three contract lawyers now.",
        }],
      }),
    });
    const turn = (await turnResponse.json()) as {
      outcome: { id: string; kind: string; team: { teamId: string } };
    };
    assert.equal(turnResponse.status, 200);
    assert.equal(turn.outcome.kind, "team");
    assert.equal(turn.outcome.team.teamId, "contract-review-team");

    const buildResponse = await fetch(`${api.url}/create/resource-architect/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planId: turn.outcome.id, draftId }),
    });
    const build = (await buildResponse.json()) as { jobId: string };
    assert.equal(buildResponse.status, 202);

    let job: ResourceBuildJobView | null = null;
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      const response = await fetch(
        `${api.url}/create/resource-architect/jobs/${encodeURIComponent(build.jobId)}`,
      );
      job = ((await response.json()) as { job: ResourceBuildJobView }).job;
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(job?.status, "completed", JSON.stringify(job, null, 2));
    assert.deepEqual(job?.selectedResource, {
      kind: "team",
      id: "contract-review-team",
    });
    assert.equal(provider.maxGenerationConcurrency(), 3);
    assert.deepEqual([...new Set(provider.requestedModels())], ["team-authoring"],
      "every Team member must be authored on the same selection as the Resource Architect chat");
    assert.equal(
      provider.generationBriefs().some((brief) =>
        brief.includes("Established expertise domain: Michigan contract limitation analysis") &&
        brief.includes("Assessment targets: limitation period; accrual trigger") &&
        brief.includes("Out of scope: General contract negotiation"),
      ),
      true,
      "the generated Agent brief must preserve the architect's document specialization",
    );
    const teamYaml = fs.readFileSync(
      path.join(repoRoot, "teams", "contract-review-team", "team.yaml"),
      "utf8",
    );
    const rosterOffsets = ["scoping-lawyer", ...plannedNames]
      .map((name) => teamYaml.indexOf(`name: "${name}"`));
    assert.equal(rosterOffsets.every((offset) => offset >= 0), true);
    assert.deepEqual([...rosterOffsets].sort((left, right) => left - right), rosterOffsets);
    assert.deepEqual(await teamFileStore.listFiles(draftId), []);
    assert.equal(
      (await teamFileStore.listFiles("contract-review-team"))[0]?.name,
      "team-contract.txt",
    );
  } finally {
    await api.close();
    await provider.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousApiUrl;
    }
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
