import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import {
  mirrorRepositoryWithoutFrontDoor,
  removeMirroredRepository,
} from "../helpers/repository-mirror.js";
import { hashUnapprovedResearchPlan } from "../../domains/deep-research/deep-research-approval.js";
import { createInitialDeepResearchPlanningRevision } from "../../domains/deep-research/deep-research-plan-review.js";
import { enforceDeepResearchPlanReadiness } from "../../domains/run-orchestrator/deep-research.js";
import type { RunPlan } from "../../contracts/run-plan.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { buildChatMessage } from "../../services/session-service.js";
import { makePlan, makeRequest } from "../unit/deep-research-fixtures.js";

const TEST_NONEXISTENT_PID = 2_147_483_647;

class ControllableSessionStore extends FileSystemSessionStore {
  private nextRevisionGate:
    | {
        markEntered: () => void;
        waitForRelease: Promise<void>;
      }
    | undefined;

  pauseNextRunPlanRevision(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextRevisionGate = { markEntered, waitForRelease };
    return { entered, release };
  }

  override async reviseRunPlan(
    id: string,
    expectedPlanId: string | null,
    nextPlan: RunPlan,
  ) {
    const gate = this.nextRevisionGate;
    if (gate) {
      this.nextRevisionGate = undefined;
      gate.markEntered();
      await gate.waitForRelease;
    }
    return super.reviseRunPlan(id, expectedPlanId, nextPlan);
  }
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-task-api-contract-"));
}

function writeWorkflowRegistry(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const registryPath = path.join(dir, "registry.yaml");
  fs.writeFileSync(
    registryPath,
    [
      "wf-1:",
      "  description: Write concise executive summaries from customer research.",
      "  template_path: ./wf-1.yaml",
      "wf-2:",
      "  description: Produce objective geopolitical policy reports for decision makers.",
      "  template_path: ./wf-2.yaml",
      "deep-research-report:",
      "  description: Produce a source-traceable Deep Research report.",
      "  template_path: ./deep-research-report.yaml",
      "wf-invalid:",
      "  description: Invalid routing override fixture.",
      "  template_path: ./wf-invalid.yaml",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "wf-1.yaml"),
    [
      "workflow:",
      "  id: wf-1",
      "  description: Test workflow.",
      "  input:",
      "    artifact: incoming-brief.md",
      "  steps:",
      "    - id: write",
      "      type: team",
      "      team: writing-team",
      "      input_artifact: incoming-brief.md",
      "      result_artifact: final-draft.md",
      "  output:",
      "    from_step: write",
      "    artifact: final-draft.md",
      "  on_blocked: stop",
      "  on_failed: stop",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "wf-2.yaml"),
    [
      "workflow:",
      "  id: wf-2",
      "  description: Produce objective geopolitical policy reports for decision makers.",
      "  input:",
      "    artifact: incoming-brief.md",
      "  steps:",
      "    - id: analyze",
      "      type: team",
      "      team: writing-team",
      "      input_artifact: incoming-brief.md",
      "      result_artifact: final-draft.md",
      "  output:",
      "    from_step: analyze",
      "    artifact: final-draft.md",
      "  on_blocked: stop",
      "  on_failed: stop",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "wf-invalid.yaml"),
    [
      "workflow:",
      "  id: wf-invalid",
      "  description: Invalid routing override fixture.",
      "  steps:",
      "    - id: clarify",
      "      type: team",
      "      team: reception-desk",
      "      input_artifact: incoming-brief.md",
      "      result_artifact: routing-decision.md",
      "      runtime_overrides:",
      "        levels:",
      "          intake:",
      "            discussion:",
      "              participants:",
      "                - receptionist",
      "  output:",
      "    from_step: clarify",
      "    artifact: routing-decision.md",
      "  on_blocked: stop",
      "  on_failed: stop",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "deep-research-report.yaml"),
    fs.readFileSync(
      path.join(
        process.cwd(),
        "workflows",
        "templates",
        "deep-research-to-document.yaml",
      ),
      "utf8",
    ),
  );
  return registryPath;
}

async function withStructuredModelResponses(
  responses: string[],
  fn: () => Promise<void>,
): Promise<void> {
  const pending = [...responses];
  const server = createServer((_req, res) => {
    const content = pending.shift();
    if (content === undefined) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No scripted model response remains" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "local-structured-model",
        choices: [{ message: { content } }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL;
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL =
    `http://127.0.0.1:${address.port}/chat/completions`;
  try {
    await fn();
    assert.equal(pending.length, 0, "every scripted model response should be used");
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL;
    } else {
      process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = previousUrl;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function structuredDecision(input: {
  message: string;
  workflowId: string | null;
  selectionAction?: "select" | "keep" | "clear";
  launchIntent: "none" | "start";
  deepResearchPlanAction?: "keep" | "amend";
  deepResearchMissingInputs?: string[];
}): string {
  return JSON.stringify({
    ...input,
    deepResearchPlanAction: input.deepResearchPlanAction ?? "keep",
    selectionAction:
      input.selectionAction ?? (input.workflowId === null ? "clear" : "select"),
  });
}

async function waitForValue<T>(params: {
  read: () => T | Promise<T>;
  accept: (value: T) => boolean;
  description: string;
  timeoutMs?: number;
}): Promise<T> {
  const deadline = Date.now() + (params.timeoutMs ?? 2_000);
  let value = await params.read();
  while (!params.accept(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    value = await params.read();
  }
  assert.ok(params.accept(value), `Timed out waiting for ${params.description}`);
  return value;
}

async function withSessionTaskServer(
  fn: (
    base: string,
    launched: { count: number; fail: boolean },
    sessionStore: ControllableSessionStore,
    workspacePath: string,
  ) => Promise<void>,
): Promise<void> {
  const workspacePath = makeWorkspace();
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-registry-"));
  const registryPath = writeWorkflowRegistry(registryDir);
  // The Coordinator's plan contract is what these cases are about, and an
  // untargeted turn is the only way the endpoint reaches it.
  const repoRootPath = mirrorRepositoryWithoutFrontDoor("session-task-repo-");
  const launched = { count: 0, fail: false };

  const sessionStore = new ControllableSessionStore(workspacePath);
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath };
      },
    },
    taskLauncher: {
      async startRun(request) {
        launched.count += 1;
        if (launched.fail) throw new Error("simulated worker launch failure");
        return {
          launched: true as const,
          pid: TEST_NONEXISTENT_PID,
          cwd: request.cwd,
        };
      },
    },
    sessionStore,
    workspacePath,
    repoRootPath,
    workflowsRegistryPath: registryPath,
  });

  try {
    await fn(server.url, launched, sessionStore, workspacePath);
  } finally {
    await server.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
    removeMirroredRepository(repoRootPath);
  }
}

test("session/task API contract covers session CRUD, files, and task lifecycle", async () => {
  await withSessionTaskServer(async (base, launched, sessionStore) => {
    const createResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Draft" }),
    });
    const session = (await createResponse.json()) as { id: string; title: string };
    assert.equal(createResponse.status, 201);
    assert.equal(session.title, "Draft");

    const renameResponse = await fetch(`${base}/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    const renamed = (await renameResponse.json()) as { title: string };
    assert.equal(renameResponse.status, 200);
    assert.equal(renamed.title, "Renamed");

    const uploadResponse = await fetch(`${base}/sessions/${session.id}/files`, {
      method: "POST",
      headers: { "x-filename": "notes.txt" },
      body: "important context",
    });
    const uploaded = (await uploadResponse.json()) as {
      name: string;
      parseStatus: string;
    };
    assert.equal(uploadResponse.status, 201);
    assert.equal(uploaded.name, "notes.txt");
    assert.ok(["pending", "parsing", "parsed"].includes(uploaded.parseStatus));

    const taskResponse = await fetch(`${base}/sessions/${session.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        brief: "Write a summary.",
      }),
    });
    const task = (await taskResponse.json()) as {
      id: string;
      workflowId: string;
      status: string;
      pid?: number;
      admission?: { phase: string };
    };
    assert.equal(taskResponse.status, 202);
    assert.equal(task.workflowId, "wf-1");
    assert.equal(task.status, "queued");
    assert.equal(task.admission?.phase, "pending");
    assert.equal(task.pid, undefined);

    await waitForValue({
      read: () => sessionStore.getTaskRecord(session.id, task.id),
      accept: (current) => current?.status === "running",
      description: "the queued task to be handed to the launcher",
    });
    assert.equal(launched.count, 1);

    const readTaskResponse = await fetch(
      `${base}/sessions/${session.id}/tasks/${task.id}`,
    );
    const readTask = (await readTaskResponse.json()) as {
      id: string;
      status: string;
    };
    assert.equal(readTaskResponse.status, 200);
    assert.equal(readTask.id, task.id);
    assert.equal(readTask.status, "running");

    const deleteTaskResponse = await fetch(
      `${base}/sessions/${session.id}/tasks/${task.id}`,
      { method: "DELETE" },
    );
    const deletedTask = (await deleteTaskResponse.json()) as {
      id: string;
      status: string;
    };
    assert.equal(deleteTaskResponse.status, 200);
    assert.equal(deletedTask.id, task.id);
    assert.equal(deletedTask.status, "cancelled");
    await waitForValue({
      read: () => sessionStore.getTaskRecord(session.id, task.id),
      accept: (current) => current?.status === "cancelled",
      description: "task cancellation to become durable",
    });

    const deleteFileResponse = await fetch(
      `${base}/sessions/${session.id}/files/notes.txt`,
      { method: "DELETE" },
    );
    assert.equal(
      deleteFileResponse.status,
      204,
      await deleteFileResponse.clone().text(),
    );

    await waitForValue({
      read: async () => {
        const response = await fetch(`${base}/sessions/${session.id}`, {
          method: "DELETE",
        });
        return response.status;
      },
      accept: (status) => status === 204,
      description: "cancelled session to become deletable",
    });
  });
});

test("workflow Apply gives the worker its sealed selected project context", async () => {
  await withSessionTaskServer(async (base) => {
    const project = (await (
      await fetch(`${base}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admission context" }),
      })
    ).json()) as { id: string };
    await fetch(`${base}/projects/${project.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Stable admission fact: 42." }),
    });
    await fetch(`${base}/projects/${project.id}/files`, {
      method: "POST",
      headers: { "x-filename": "facts.md" },
      body: "Selected evidence: 84.",
    });
    const session = (await (
      await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Project workflow", projectId: project.id }),
      })
    ).json()) as { id: string };
    const projectContext = {
      projectId: project.id,
      includeBrief: true,
      fileNames: ["facts.md"],
    };

    const response = await fetch(`${base}/sessions/${session.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "wf-1",
        brief:
          "Write an executive summary of customer retention trends for the board, using the selected evidence and highlighting risks for the European launch.",
        projectContext,
      }),
    });

    const responseText = await response.text();
    assert.equal(response.status, 202, responseText);
    const task = JSON.parse(responseText) as { inputSnapshotPath?: string; brief: string; cwd: string };
    assert.ok(task.inputSnapshotPath);
    assert.match(task.brief, /Stable admission fact: 42\./,
      "The worker brief must contain the explicitly selected project brief, not only its snapshot path");
    assert.match(task.brief, /Selected evidence: 84\./,
      "The worker brief must contain the explicitly selected project file evidence");
    assert.equal(fs.readFileSync(path.join(task.cwd, "incoming-brief.md"), "utf8"), task.brief);
    const contextPath = path.join(task.inputSnapshotPath, "project-context");
    assert.equal(
      fs.readFileSync(path.join(contextPath, "brief.md"), "utf8"),
      "Stable admission fact: 42.",
    );
    assert.equal(
      fs.readFileSync(path.join(contextPath, "files", "facts.md"), "utf8"),
      "Selected evidence: 84.",
    );
    const plan = (await (
      await fetch(`${base}/sessions/${session.id}/run-plan`)
    ).json()) as { plan: RunPlan };
    assert.deepEqual(plan.plan.projectContext, projectContext);
  });
});

test("session message API returns and persists a run orchestrator plan", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 is ready for this executive-summary request.",
        selectionAction: "select",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Draft" }),
        });
        const session = (await createResponse.json()) as { id: string };

        const messageResponse = await fetch(
          `${base}/sessions/${session.id}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: "Write a concise executive summary of the customer discovery notes for B2B SaaS founders.",
              provider: "deepseek",
              model: "local-structured-model",
            }),
          },
        );
        const messagePayload = (await messageResponse.json()) as {
          plan: {
            status: string;
            selectedWorkflow?: { id: string };
          };
        };
        assert.equal(messageResponse.status, 201);
        assert.equal(messagePayload.plan.status, "ready");
        assert.equal(messagePayload.plan.selectedWorkflow?.id, "wf-1");

        const taskResponse = await fetch(`${base}/sessions/${session.id}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowId: "wf-1" }),
        });
        const task = (await taskResponse.json()) as {
          workflowId: string;
          status: string;
          admission?: { phase: string };
        };
        assert.equal(taskResponse.status, 202);
        assert.equal(task.workflowId, "wf-1");
        assert.equal(task.status, "queued");
        assert.equal(task.admission?.phase, "pending");
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "the queued run plan to reach the launcher",
        });
        assert.equal(launched.count, 1);
      }),
  );
});

test("Deep Research chat completes intake without asking for a freshness period", async () => {
  const unresolvedInputs = [
    "target audience",
    "research objective and output",
    "scope and comparison criteria",
    "jurisdiction or no geographic constraint",
    "exclusions or no exclusions",
  ];
  await withStructuredModelResponses(
    [
      structuredDecision({
        message:
          "Who is the audience, what should the report compare, what jurisdiction applies (or none), and are there exclusions?",
        selectionAction: "select",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchMissingInputs: unresolvedInputs,
      }),
      structuredDecision({
        message:
          "Thanks. What outcome, comparison scope, jurisdiction, and exclusions should the report use?",
        selectionAction: "keep",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchMissingInputs: unresolvedInputs.slice(1),
      }),
      structuredDecision({
        message:
          "The intake is complete. Planning will continue in the background, and progress will appear in this session.",
        selectionAction: "keep",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchMissingInputs: [],
      }),
      structuredDecision({
        message:
          "I added a separate dog-safe frozen-treat task. Planning will continue in the background, and progress will appear in this session.",
        selectionAction: "keep",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchPlanAction: "amend",
        deepResearchMissingInputs: [],
      }),
      structuredDecision({
        message:
          "The dog-safe frozen-treat task will remain separate from the main ranking. Planning will continue in the background, and progress will appear in this session.",
        selectionAction: "keep",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchPlanAction: "amend",
        deepResearchMissingInputs: [],
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Deep Research intake" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        const questionResponse = await postMessage(
          "Do deep research on local ice cream businesses in Ann Arbor.",
        );
        const question = (await questionResponse.json()) as {
          messages: { text: string }[];
          plan: RunPlan;
        };
        assert.equal(questionResponse.status, 201);
        assert.equal(
          question.plan.selectedWorkflow?.id,
          "deep-research-report",
          JSON.stringify(question),
        );
        assert.equal(question.plan.deepResearchIntakeComplete, false);
        const originalResearchGoal = question.plan.goal;
        assert.deepEqual(question.plan.requiredInputs, [
          ...unresolvedInputs,
          "research plan",
        ]);
        assert.match(question.messages[0]!.text, /jurisdiction applies \(or none\)/i);

        // The user takes the recommendation. Everything below expects planning
        // to start by itself once intake closes, and only a user's own
        // selection opens the workspace that starts it.
        const selectionResponse = await fetch(
          `${base}/sessions/${session.id}/run-plan/workflow`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workflowId: "deep-research-report",
              expectedPlanId: question.plan.id,
            }),
          },
        );
        const selection = (await selectionResponse.json()) as { plan: RunPlan };
        assert.equal(
          selectionResponse.status,
          200,
          JSON.stringify(selection),
        );
        assert.equal(
          selection.plan.selectedWorkflow?.selectionSource,
          "user",
        );

        const audienceResponse = await postMessage(
          "Families visiting Ann Arbor with young children are the primary audience.",
        );
        const audience = (await audienceResponse.json()) as {
          plan: RunPlan;
        };
        assert.equal(audienceResponse.status, 201);
        assert.equal(audience.plan.deepResearchIntakeComplete, false);
        assert.deepEqual(audience.plan.requiredInputs, [
          ...unresolvedInputs.slice(1),
          "research plan",
        ]);

        const remainingIntakeTurns: Array<[string, string]> = [
          [
            "What outcome and format should the research produce?",
            "Produce a ranked visitor guide with a concise market overview.",
          ],
          [
            "What should the report compare?",
            "Compare shops, prices, dietary options, reviews, and sourcing.",
          ],
          [
            "What geographic jurisdiction applies?",
            "Use Ann Arbor city limits as the jurisdiction.",
          ],
          [
            "Are there any exclusions?",
            "No exclusions.",
          ],
        ];
        for (const [assistantText, userText] of remainingIntakeTurns) {
          await sessionStore.appendChatMessage(
            session.id,
            buildChatMessage("assistant", assistantText),
          );
          await sessionStore.appendChatMessage(
            session.id,
            buildChatMessage("user", userText),
          );
        }

        const answerResponse = await postMessage(
          "That completes the intake. Use all of the settled answers above.",
        );
        const answer = (await answerResponse.json()) as {
          messages: { text: string }[];
          plan: RunPlan;
        };
        assert.equal(answerResponse.status, 201);
        assert.equal(answer.plan.deepResearchIntakeComplete, true);
        // The automatic-planning promise below is only truthful because the
        // user owns this selection.
        assert.equal(answer.plan.selectedWorkflow?.selectionSource, "user");
        assert.equal(answer.plan.deepResearchPlanning?.origin, "initial");
        assert.equal(answer.plan.deepResearchPlanning?.requiresSolReview, false);
        assert.equal(answer.plan.deepResearchPlanning?.revisionNumber, 1);
        assert.deepEqual(answer.plan.requiredInputs, ["research plan"]);
        assert.equal(answer.plan.goal, originalResearchGoal);
        assert.match(
          answer.messages[0]!.text,
          /Planning will continue in the background, and progress will appear in this session\./,
        );
        assert.match(answer.plan.brief ?? "", /local ice cream businesses/i);
        assert.match(
          answer.plan.brief ?? "",
          /Families visiting Ann Arbor with young children/i,
        );
        assert.deepEqual(
          (await sessionStore.getRunPlan(session.id))?.requiredInputs,
          ["research plan"],
        );

        const canonicalQuestion =
          "Which Ann Arbor ice cream shops best fit visitors and residents?";
        const generatedResearchPlan = makePlan({
          request: makeRequest({
            question: canonicalQuestion,
            objective: "Produce a current ranked guide.",
            audience: "Families visiting Ann Arbor with young children",
            includedScope: ["Independent Ann Arbor ice cream shops"],
            excludedScope: ["National chains"],
            jurisdictions: ["Ann Arbor city limits"],
          }),
        });
        const concurrentInitialProposal = enforceDeepResearchPlanReadiness({
          ...answer.plan,
          id: `${answer.plan.id}-generated-proposal`,
          researchPlan: generatedResearchPlan,
          researchPlanProposalHash:
            hashUnapprovedResearchPlan(generatedResearchPlan),
        });
        const initialAmendmentRevisionGate =
          sessionStore.pauseNextRunPlanRevision();
        const amendmentResponsePromise = postMessage(
          "Also add a separate task identifying which shortlisted shops offer dog-safe ice cream, pup cups, or frozen treats.",
        );
        await initialAmendmentRevisionGate.entered;
        const concurrentInitialGenerationRevision =
          await sessionStore.reviseRunPlan(
            session.id,
            answer.plan.id,
            concurrentInitialProposal,
          );
        initialAmendmentRevisionGate.release();
        assert.equal(concurrentInitialGenerationRevision?.revised, true);

        const amendmentResponse = await amendmentResponsePromise;
        const amendment = (await amendmentResponse.json()) as {
          messages: { text: string }[];
          plan: RunPlan;
        };
        assert.equal(amendmentResponse.status, 201);
        assert.equal(amendment.plan.goal, canonicalQuestion);
        assert.equal(amendment.plan.researchPlan, undefined);
        assert.equal(amendment.plan.researchPlanProposalHash, undefined);
        assert.equal(amendment.plan.deepResearchIntakeComplete, true);
        assert.equal(
          amendment.plan.deepResearchPlanning?.origin,
          "user_amendment",
        );
        assert.equal(
          amendment.plan.deepResearchPlanning?.requiresSolReview,
          true,
        );
        assert.equal(
          amendment.plan.deepResearchPlanning?.revisionNumber,
          2,
        );
        assert.equal(
          amendment.plan.deepResearchPlanning?.sourceProposalHash,
          hashUnapprovedResearchPlan(generatedResearchPlan),
        );
        assert.equal(
          amendment.plan.deepResearchPlanning?.sourceProposalSnapshot
            ?.request.question,
          canonicalQuestion,
        );
        assert.equal(
          amendment.plan.deepResearchPlanning?.amendmentMessageIds.length,
          1,
        );
        assert.deepEqual(amendment.plan.requiredInputs, ["research plan"]);
        assert.match(amendment.plan.brief ?? "", /dog-safe ice cream/i);
        assert.match(amendment.plan.brief ?? "", /local ice cream businesses/i);
        assert.match(
          amendment.plan.brief ?? "",
          /Preserved Deep Research Request Baseline/,
        );
        assert.match(
          amendment.plan.brief ?? "",
          /"audience": "Families visiting Ann Arbor with young children"/,
        );
        assert.match(amendment.plan.brief ?? "", /"freshnessAsOf":/);
        assert.match(
          amendment.plan.brief ?? "",
          /"jurisdictions": \[\s*"Ann Arbor city limits"/,
        );
        assert.match(
          amendment.messages[0]!.text,
          /Planning will continue in the background, and progress will appear in this session\./,
        );

        const amendmentRevisionGate = sessionStore.pauseNextRunPlanRevision();
        const secondAmendmentResponsePromise = postMessage(
          "Keep the dog-treat findings separate from the main visitor ranking.",
        );
        await amendmentRevisionGate.entered;
        const concurrentGeneratedPlan = enforceDeepResearchPlanReadiness({
          ...amendment.plan,
          id: `${amendment.plan.id}-concurrent-generation`,
          researchPlan: generatedResearchPlan,
          researchPlanProposalHash:
            hashUnapprovedResearchPlan(generatedResearchPlan),
        });
        const concurrentGenerationRevision = await sessionStore.reviseRunPlan(
          session.id,
          amendment.plan.id,
          concurrentGeneratedPlan,
        );
        amendmentRevisionGate.release();
        assert.equal(concurrentGenerationRevision?.revised, true);

        const secondAmendmentResponse = await secondAmendmentResponsePromise;
        const secondAmendment = (await secondAmendmentResponse.json()) as {
          plan: RunPlan;
        };
        assert.equal(secondAmendmentResponse.status, 201);
        assert.equal(secondAmendment.plan.goal, canonicalQuestion);
        assert.equal(secondAmendment.plan.researchPlan, undefined);
        assert.equal(secondAmendment.plan.researchPlanProposalHash, undefined);
        assert.equal(
          secondAmendment.plan.deepResearchPlanning?.origin,
          "user_amendment",
        );
        assert.equal(
          secondAmendment.plan.deepResearchPlanning?.requiresSolReview,
          true,
        );
        assert.equal(
          secondAmendment.plan.deepResearchPlanning?.revisionNumber,
          3,
        );
        assert.equal(
          secondAmendment.plan.deepResearchPlanning?.amendmentMessageIds.length,
          2,
        );
        assert.match(
          secondAmendment.plan.brief ?? "",
          /"audience": "Families visiting Ann Arbor with young children"/,
        );
        assert.match(
          secondAmendment.plan.brief ?? "",
          /Keep the dog-treat findings separate/i,
        );
        assert.equal(launched.count, 0);
      }),
  );
});

test("a recommended Deep Research plan never claims that planning started", async () => {
  const unresolvedInputs = [
    "target audience",
    "research objective and output",
    "scope and comparison criteria",
    "jurisdiction or no geographic constraint",
    "exclusions or no exclusions",
  ];
  // Adversarial on purpose: the provider insists on the sentence the
  // user-selected journey uses. Nothing but the server's own knowledge of who
  // selected the workflow can tell the difference.
  const backgroundClaim =
    "The intake is complete. Planning will continue in the background, and progress will appear in this session.";
  await withStructuredModelResponses(
    [
      structuredDecision({
        message:
          "Who is the audience, what should the report compare, what jurisdiction applies (or none), and are there exclusions?",
        selectionAction: "select",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchMissingInputs: unresolvedInputs,
      }),
      structuredDecision({
        message: backgroundClaim,
        selectionAction: "keep",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchMissingInputs: [],
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const session = (await (
          await fetch(`${base}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Recommended Deep Research" }),
          })
        ).json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        await postMessage(
          "Do deep research on local ice cream businesses in Ann Arbor.",
        );
        for (const [assistantText, userText] of [
          [
            "Who is the audience?",
            "Families visiting Ann Arbor with young children.",
          ],
          [
            "What outcome and format should the research produce?",
            "Produce a ranked visitor guide with a concise market overview.",
          ],
          [
            "What should the report compare?",
            "Compare shops, prices, dietary options, reviews, and sourcing.",
          ],
          [
            "What geographic jurisdiction applies?",
            "Use Ann Arbor city limits as the jurisdiction.",
          ],
          ["Are there any exclusions?", "No exclusions."],
        ] satisfies Array<[string, string]>) {
          await sessionStore.appendChatMessage(
            session.id,
            buildChatMessage("assistant", assistantText),
          );
          await sessionStore.appendChatMessage(
            session.id,
            buildChatMessage("user", userText),
          );
        }

        const completeResponse = await postMessage(
          "That completes the intake. Use all of the settled answers above.",
        );
        const complete = (await completeResponse.json()) as {
          messages: { text: string }[];
          plan: RunPlan;
        };
        assert.equal(completeResponse.status, 201);

        // Nobody chose this workflow, so nobody owns starting it.
        assert.equal(
          complete.plan.selectedWorkflow?.selectionSource,
          "coordinator",
        );
        assert.equal(complete.plan.deepResearchIntakeComplete, true);

        const reply = complete.messages[0]!.text;
        assert.doesNotMatch(
          reply,
          /in the background/i,
          `Recommended Deep Research promised background planning: ${reply}`,
        );
        assert.doesNotMatch(
          reply,
          /planning (has |is )?(started|starting|under way|underway|continuing)/i,
          `Recommended Deep Research claimed planning had begun: ${reply}`,
        );
        assert.match(reply, /select/i);
        assert.match(reply, /deep research/i);

        // And no planning work exists to have produced that claim.
        assert.equal(complete.plan.researchPlan, undefined);
        assert.equal(
          complete.plan.deepResearchPlanning?.latestAttemptId,
          undefined,
        );
        const stored = await sessionStore.getRunPlan(session.id);
        assert.equal(stored?.researchPlan, undefined);
        assert.equal(stored?.deepResearchPlanning?.latestAttemptId, undefined);
        assert.equal(launched.count, 0);
      }),
  );
});

test("casual Deep Research chat preserves the pending proposal and planning revision", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message:
          "Planning is still in progress; the configured limit remains unchanged.",
        selectionAction: "keep",
        workflowId: "deep-research-report",
        launchIntent: "none",
        deepResearchPlanAction: "keep",
        deepResearchMissingInputs: [],
      }),
    ],
    () =>
      withSessionTaskServer(async (base, _launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Pending Deep Research proposal" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const researchPlan = makePlan();
        const planningRevision = {
          ...createInitialDeepResearchPlanningRevision(
            "2026-07-26T12:00:00.000Z",
          ),
          latestAttemptId: "attempt-pending-proposal",
        };
        const pending = enforceDeepResearchPlanReadiness({
          id: "run-plan-pending-proposal",
          goal: "Compare enterprise research platforms.",
          summary: "Review the generated proposal.",
          status: "needs_input",
          selectedWorkflow: {
            id: "deep-research-report",
            rationale: "The request requires source-traceable research.",
            confidence: "high",
          },
          deepResearchIntakeComplete: true,
          deepResearchPlanning: planningRevision,
          researchPlan,
          researchPlanProposalHash:
            hashUnapprovedResearchPlan(researchPlan),
          requiredInputs: ["research plan approval"],
          actions: [],
          warnings: [],
          createdAt: "2026-07-26T12:00:00.000Z",
        });
        assert.equal(await sessionStore.saveRunPlan(session.id, pending), true);

        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "How long will this take?",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        assert.equal(response.status, 201);
        const payload = (await response.json()) as { plan: RunPlan };
        assert.equal(payload.plan.id, pending.id);
        assert.deepEqual(payload.plan.researchPlan, researchPlan);
        assert.equal(
          payload.plan.researchPlanProposalHash,
          pending.researchPlanProposalHash,
        );
        assert.deepEqual(payload.plan.deepResearchPlanning, planningRevision);
        assert.deepEqual(
          await sessionStore.getRunPlan(session.id),
          payload.plan,
        );
      }),
  );
});

test("a thin request preserves the LLM workflow choice and focused follow-up", async () => {
  const focusedQuestion =
    "The geopolitical policy workflow fits. Who is the audience, which period or regions matter, and how long should the report be?";

  await withStructuredModelResponses(
    [
      structuredDecision({
        message: focusedQuestion,
        selectionAction: "select",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Thin policy request" }),
        });
        const session = (await createResponse.json()) as { id: string };

        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Elaborate on Trump's foreign policy.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as {
          messages: { text: string }[];
          plan: {
            id: string;
            status: string;
            selectedWorkflow?: { id: string };
            requiredInputs: string[];
          };
          task?: unknown;
        };

        assert.equal(response.status, 201);
        assert.equal(body.plan.status, "needs_input");
        assert.equal(body.plan.selectedWorkflow?.id, "wf-2");
        assert.ok(body.plan.requiredInputs.includes("specific task details"));
        assert.equal(body.messages[0]!.text, focusedQuestion);
        assert.equal(body.task, undefined);
        assert.equal(launched.count, 0);

        const persisted = await sessionStore.getRunPlan(session.id);
        assert.equal(persisted?.id, body.plan.id);
        assert.equal(persisted?.status, "needs_input");
        assert.equal(persisted?.selectedWorkflow?.id, "wf-2");
      }),
  );
});

test("an ambiguous workflow decision preserves the LLM options and question", async () => {
  const optionsQuestion =
    "I can make either a concise executive summary with wf-1 or a fuller policy report with wf-2. Which output do you want?";

  await withStructuredModelResponses(
    [
      structuredDecision({
        message: optionsQuestion,
        selectionAction: "clear",
        workflowId: null,
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Ambiguous request" }),
        });
        const session = (await createResponse.json()) as { id: string };

        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Help me turn this material into a useful document.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as {
          messages: { text: string }[];
          plan: {
            status: string;
            selectedWorkflow?: { id: string };
            requiredInputs: string[];
          };
          task?: unknown;
        };

        assert.equal(response.status, 201);
        assert.equal(body.plan.status, "needs_input");
        assert.equal(body.plan.selectedWorkflow, undefined);
        assert.ok(body.plan.requiredInputs.includes("workflow selection"));
        assert.equal(body.messages[0]!.text, optionsQuestion);
        assert.equal(body.task, undefined);
        assert.equal(launched.count, 0);
        assert.equal(
          (await sessionStore.getRunPlan(session.id))?.selectedWorkflow,
          undefined,
        );
      }),
  );
});

test("a later unrelated request can replace the persisted workflow", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 fits the requested customer-research summary.",
        selectionAction: "select",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "I switched the plan to wf-2 for the new policy-report request.",
        selectionAction: "select",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Changed direction" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        const firstResponse = await postMessage(
          "Summarize the detailed customer discovery notes for B2B SaaS founders in one page.",
        );
        const first = (await firstResponse.json()) as {
          plan: { id: string; selectedWorkflow?: { id: string } };
        };
        assert.equal(firstResponse.status, 201);
        assert.equal(first.plan.selectedWorkflow?.id, "wf-1");

        const changedResponse = await postMessage(
          "Change direction completely: prepare an objective geopolitical policy report for government decision makers.",
        );
        const changed = (await changedResponse.json()) as {
          messages: { text: string }[];
          plan: { id: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };

        assert.equal(changedResponse.status, 201);
        assert.notEqual(changed.plan.id, first.plan.id);
        assert.equal(changed.plan.selectedWorkflow?.id, "wf-2");
        assert.match(changed.messages[0]!.text, /switched the plan to wf-2/i);
        assert.equal(changed.task, undefined);
        assert.equal(launched.count, 0);

        const persisted = await sessionStore.getRunPlan(session.id);
        assert.equal(persisted?.id, changed.plan.id);
        assert.equal(persisted?.selectedWorkflow?.id, "wf-2");
      }),
  );
});

test("an ambiguous later request can clear a persisted workflow selection", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 fits the requested customer-research summary.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "The new request could use either workflow; choose the output you want.",
        selectionAction: "clear",
        workflowId: null,
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Clear workflow selection" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        const selectedResponse = await postMessage(
          "Summarize the detailed customer research for B2B SaaS founders in one page.",
        );
        const selected = (await selectedResponse.json()) as {
          plan: { id: string; selectedWorkflow?: { id: string } };
        };
        assert.equal(selected.plan.selectedWorkflow?.id, "wf-1");

        const clearedResponse = await postMessage(
          "Instead, help me decide whether I need a short summary or a full policy report.",
        );
        const cleared = (await clearedResponse.json()) as {
          messages: { text: string }[];
          plan: {
            id: string;
            status: string;
            selectedWorkflow?: { id: string };
            requiredInputs: string[];
          };
          task?: unknown;
        };

        assert.equal(clearedResponse.status, 201);
        assert.notEqual(cleared.plan.id, selected.plan.id);
        assert.equal(cleared.plan.status, "needs_input");
        assert.equal(cleared.plan.selectedWorkflow, undefined);
        assert.ok(cleared.plan.requiredInputs.includes("workflow selection"));
        assert.match(cleared.messages[0]!.text, /choose the output/i);
        assert.equal(cleared.task, undefined);
        assert.equal(launched.count, 0);
        assert.equal(
          (await sessionStore.getRunPlan(session.id))?.selectedWorkflow,
          undefined,
        );
      }),
  );
});

test("an unavailable receptionist preserves the prior plan instead of reusing it for a new goal", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 fits the requested customer-research summary.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Fail-closed selection" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        const selectedResponse = await postMessage(
          "Summarize the detailed customer research for B2B SaaS founders in one page.",
        );
        const selected = (await selectedResponse.json()) as {
          plan: { id: string; goal: string; selectedWorkflow?: { id: string } };
        };
        assert.equal(selected.plan.selectedWorkflow?.id, "wf-1");

        const changedResponse = await postMessage(
          "Change direction completely: write a geopolitical policy report for government leaders.",
        );
        const changed = (await changedResponse.json()) as {
          messages: { text: string }[];
          plan: { id: string; goal: string; selectedWorkflow?: { id: string } };
          meta: { fallback?: boolean };
          task?: unknown;
        };

        assert.equal(changedResponse.status, 201);
        assert.equal(changed.meta.fallback, true);
        assert.equal(changed.plan.id, selected.plan.id);
        assert.equal(changed.plan.goal, selected.plan.goal);
        assert.equal(changed.plan.selectedWorkflow?.id, "wf-1");
        assert.match(changed.messages[0]!.text, /existing run plan unchanged/i);
        assert.equal(changed.task, undefined);
        assert.equal(launched.count, 0);
        const persisted = await sessionStore.getRunPlan(session.id);
        assert.equal(persisted?.id, selected.plan.id);
        assert.equal(persisted?.goal, selected.plan.goal);
      }),
  );
});

test("a stale non-launch decision cannot contradict a concurrently revised plan", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 fits the initial summary.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "I switched the plan to wf-2.",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "No workflow should remain selected until the format is clear.",
        selectionAction: "clear",
        workflowId: null,
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Concurrent selection" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        await postMessage(
          "Summarize the detailed customer research for B2B SaaS founders in one page.",
        );
        const revisionGate = sessionStore.pauseNextRunPlanRevision();
        const staleResponsePromise = postMessage(
          "Switch this to a geopolitical policy report for government leaders.",
        );
        await revisionGate.entered;

        const winningResponse = await postMessage(
          "Pause the workflow choice; I need to decide between a summary and a report.",
        );
        const winning = (await winningResponse.json()) as {
          plan: { id: string; selectedWorkflow?: { id: string } };
        };
        assert.equal(winning.plan.selectedWorkflow, undefined);

        revisionGate.release();
        const staleResponse = await staleResponsePromise;
        const stale = (await staleResponse.json()) as {
          messages: { text: string }[];
          plan: { id: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };

        assert.equal(staleResponse.status, 201);
        assert.equal(stale.plan.id, winning.plan.id);
        assert.equal(stale.plan.selectedWorkflow, undefined);
        assert.match(stale.messages[0]!.text, /run plan changed while I was replying/i);
        assert.doesNotMatch(stale.messages[0]!.text, /switched the plan to wf-2/i);
        assert.equal(stale.task, undefined);
        assert.equal(launched.count, 0);
      }),
  );
});

test("a non-launch update reports when the workflow starts before its revision", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 fits the initial summary.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "I switched the plan to wf-2.",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Concurrent launch" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        await postMessage(
          "Summarize the detailed customer research for B2B SaaS founders in one page.",
        );
        const revisionGate = sessionStore.pauseNextRunPlanRevision();
        const updateResponsePromise = postMessage(
          "Switch this to a geopolitical policy report for government leaders.",
        );
        await revisionGate.entered;

        const taskResponse = await fetch(`${base}/sessions/${session.id}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowId: "wf-1" }),
        });
        assert.equal(taskResponse.status, 202);

        revisionGate.release();
        const updateResponse = await updateResponsePromise;
        const update = (await updateResponse.json()) as {
          messages: { text: string }[];
          plan: { status: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };

        assert.equal(updateResponse.status, 201);
        assert.ok(["applying", "queued", "running"].includes(update.plan.status));
        assert.equal(update.plan.selectedWorkflow?.id, "wf-1");
        assert.match(update.messages[0]!.text, /started before I could apply that update/i);
        assert.match(update.messages[0]!.text, /update was not applied/i);
        assert.doesNotMatch(update.messages[0]!.text, /switched the plan to wf-2/i);
        assert.equal(update.task, undefined);
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "the concurrently started workflow to reach the launcher",
        });
      }),
  );
});

test("receptionist cannot make a non-launchable workflow ready", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "I selected the invalid fixture.",
        workflowId: "wf-invalid",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "I selected the launchable summary workflow.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Launchability filter" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Write an executive summary for B2B SaaS leaders from detailed customer research.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as {
          plan: { status: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };

        assert.equal(response.status, 201);
        assert.equal(body.plan.status, "ready");
        assert.equal(body.plan.selectedWorkflow?.id, "wf-1");
        assert.equal(body.task, undefined);
        assert.equal(launched.count, 0);
      }),
  );
});

test("workflow selection API resolves and persists the exact needs-input dead end", async () => {
  await withSessionTaskServer(async (base, launched, sessionStore) => {
    const createResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dead end" }),
    });
    const session = (await createResponse.json()) as { id: string };
    await sessionStore.appendChatMessage(session.id, {
      id: "dead-end-user-message",
      role: "user",
      text: "Research second-term foreign policy and write an objective two-page markdown report.",
      createdAt: new Date().toISOString(),
    });
    const stalledPlan = {
      id: "run-plan-dead-end",
      goal: "objective, second term, any focus, markdown file",
      summary: "A workflow still needs to be selected.",
      status: "needs_input" as const,
      requiredInputs: ["workflow selection"],
      actions: [
        {
          id: "select-workflow",
          type: "select_workflow" as const,
          status: "needs_input" as const,
          title: "Select workflow",
          rationale: "No workflow was persisted from the receptionist reply.",
        },
      ],
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    assert.equal(await sessionStore.saveRunPlan(session.id, stalledPlan), true);

    const beforeResponse = await fetch(`${base}/sessions/${session.id}/run-plan`);
    const before = (await beforeResponse.json()) as {
      plan: { id: string; status: string; selectedWorkflow?: { id: string } };
    };
    assert.equal(beforeResponse.status, 200);
    assert.equal(before.plan.status, "needs_input");
    assert.equal(before.plan.selectedWorkflow, undefined);

    const invalidSelectionResponse = await fetch(
      `${base}/sessions/${session.id}/run-plan/workflow`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "wf-invalid",
          expectedPlanId: stalledPlan.id,
        }),
      },
    );
    const invalidSelection = (await invalidSelectionResponse.json()) as {
      error: string;
      detail: string;
    };
    assert.equal(invalidSelectionResponse.status, 400);
    assert.equal(invalidSelection.error, "Workflow is invalid");
    assert.match(invalidSelection.detail, /routing/i);
    assert.equal((await sessionStore.getRunPlan(session.id))?.id, stalledPlan.id);

    const selectResponse = await fetch(
      `${base}/sessions/${session.id}/run-plan/workflow`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "wf-2",
          expectedPlanId: stalledPlan.id,
        }),
      },
    );
    const selected = (await selectResponse.json()) as {
      plan: { id: string; status: string; selectedWorkflow?: { id: string } };
    };
    assert.equal(selectResponse.status, 200);
    assert.equal(selected.plan.status, "ready");
    assert.equal(selected.plan.selectedWorkflow?.id, "wf-2");
    assert.notEqual(selected.plan.id, stalledPlan.id);

    const reloadedResponse = await fetch(`${base}/sessions/${session.id}/run-plan`);
    const reloaded = (await reloadedResponse.json()) as typeof selected;
    assert.equal(reloaded.plan.id, selected.plan.id);
    assert.equal(reloaded.plan.status, "ready");

    const staleSelectionResponse = await fetch(
      `${base}/sessions/${session.id}/run-plan/workflow`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "wf-1",
          expectedPlanId: stalledPlan.id,
        }),
      },
    );
    assert.equal(staleSelectionResponse.status, 409);

    const taskResponse = await fetch(`${base}/sessions/${session.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "wf-2" }),
    });
    const task = (await taskResponse.json()) as {
      id: string;
      workflowId: string;
      status: string;
      admission?: { phase: string };
    };
    assert.equal(taskResponse.status, 202);
    assert.equal(task.workflowId, "wf-2");
    assert.equal(task.status, "queued");
    assert.equal(task.admission?.phase, "pending");

    const activeSelectionResponse = await fetch(
      `${base}/sessions/${session.id}/run-plan/workflow`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "wf-1",
          expectedPlanId: selected.plan.id,
        }),
      },
    );
    assert.equal(activeSelectionResponse.status, 409);
    const activePlan = await sessionStore.getRunPlan(session.id);
    assert.equal(activePlan?.id, selected.plan.id);
    assert.ok(
      activePlan?.status === "queued" || activePlan?.status === "running",
    );
    assert.equal(activePlan?.selectedWorkflow?.id, "wf-2");

    const duplicateStartResponse = await fetch(
      `${base}/sessions/${session.id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "wf-2" }),
      },
    );
    const duplicateTask = (await duplicateStartResponse.json()) as { id: string };
    assert.equal(duplicateStartResponse.status, 202);
    assert.equal(duplicateTask.id, task.id);
    await waitForValue({
      read: () => launched.count,
      accept: (count) => count === 1,
      description: "the selected workflow to reach the launcher",
    });
    assert.equal(launched.count, 1);

    const conflictingStartResponse = await fetch(
      `${base}/sessions/${session.id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: "wf-1" }),
      },
    );
    assert.equal(conflictingStartResponse.status, 409);
    assert.equal(launched.count, 1);
    assert.equal((await sessionStore.listTaskRecords(session.id)).length, 1);
  });
});

test("an arbitrary-language chat confirmation launches the persisted ready plan", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "The workflow is selected and ready for your confirmation.",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "I will pass the approved plan to Run Orchestrator.",
        selectionAction: "keep",
        workflowId: "wf-2",
        launchIntent: "start",
      }),
      structuredDecision({
        message: "The analysis stage compares the evidence before drafting the policy report.",
        selectionAction: "keep",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Semantic confirmation" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        const planningResponse = await postMessage(
          "Write an objective two-page geopolitical policy report for public-sector decision makers using the supplied research context.",
        );
        const planning = (await planningResponse.json()) as {
          plan: { status: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };
        assert.equal(planning.plan.status, "ready");
        assert.equal(planning.plan.selectedWorkflow?.id, "wf-2");
        assert.equal(planning.task, undefined);

        // The confirmation is not English and names no control: the decision
        // to launch comes from the structured turn, not from parsed prose.
        const confirmationResponse = await postMessage(
          "Wszystko zatwierdzone po mojej stronie; oddaj to teraz zespołowi.",
        );
        const confirmation = (await confirmationResponse.json()) as {
          messages: { text: string }[];
          plan: { status: string; taskId?: string };
          task?: unknown;
        };
        assert.equal(confirmationResponse.status, 201);
        assert.ok(
          confirmation.plan.status === "queued" ||
            confirmation.plan.status === "running",
          `the confirmed plan launches immediately, got ${confirmation.plan.status}`,
        );
        assert.ok(confirmation.plan.taskId, "the launched plan names its task");
        assert.match(confirmation.messages[0]!.text, /wf-2 is starting/i);
        assert.doesNotMatch(confirmation.messages[0]!.text, /Begin workflow/i);
        const tasks = await sessionStore.listTaskRecords(session.id);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.workflowId, "wf-2");
        assert.equal(tasks[0]?.id, confirmation.plan.taskId);
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "the confirmed workflow to reach the launcher",
        });

        const questionResponse = await postMessage(
          "What does the analysis stage do after I begin it?",
        );
        const question = (await questionResponse.json()) as {
          messages: { text: string }[];
          plan: { status: string };
          task?: unknown;
        };
        assert.equal(questionResponse.status, 201);
        assert.match(question.messages[0]!.text, /compares the evidence/i);
        assert.doesNotMatch(question.messages[0]!.text, /already starting or running/i);
        assert.equal(question.task, undefined);
        assert.equal(launched.count, 1, "a follow-up question launches nothing more");
        assert.equal((await sessionStore.listTaskRecords(session.id)).length, 1);
      }),
  );
});

test("an active run cannot be switched by a later receptionist decision", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "wf-1 is ready.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "The approved plan can start.",
        selectionAction: "keep",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "I switched the active run to wf-2.",
        selectionAction: "select",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "wf-1 is already running, so its plan remains unchanged.",
        selectionAction: "keep",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Active plan guard" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        await postMessage(
          "Summarize the detailed customer research for B2B SaaS founders in one page.",
        );
        const startedResponse = await postMessage(
          "Everything is approved; send it to the team now.",
        );
        const started = (await startedResponse.json()) as {
          plan: { id: string; status: string; selectedWorkflow?: { id: string } };
        };
        assert.equal(started.plan.status, "ready");
        assert.equal(started.plan.selectedWorkflow?.id, "wf-1");

        const beginResponse = await fetch(
          `${base}/sessions/${session.id}/tasks`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workflowId: "wf-1" }),
          },
        );
        assert.equal(beginResponse.status, 202);

        const switchResponse = await postMessage(
          "Switch the work to a geopolitical policy report instead.",
        );
        const switched = (await switchResponse.json()) as {
          messages: { text: string }[];
          plan: { id: string; status: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };

        assert.equal(switchResponse.status, 201);
        assert.equal(switched.plan.id, started.plan.id);
        assert.ok(
          switched.plan.status === "queued" || switched.plan.status === "running",
        );
        assert.equal(switched.plan.selectedWorkflow?.id, "wf-1");
        assert.match(switched.messages[0]!.text, /already running/i);
        assert.doesNotMatch(switched.messages[0]!.text, /switched the active run/i);
        assert.equal(switched.task, undefined);
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "the active workflow to reach the launcher",
        });
        assert.equal(launched.count, 1);
        assert.equal(
          (await sessionStore.getRunPlan(session.id))?.selectedWorkflow?.id,
          "wf-1",
        );
      }),
  );
});

test("a repaired structured start decision still launches a ready plan", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "The policy workflow is ready.",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
      "I forgot the required JSON envelope.",
      structuredDecision({
        message: "The user's authorization is clear.",
        selectionAction: "keep",
        workflowId: "wf-2",
        launchIntent: "start",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Repair launch intent" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        await postMessage(
          "Prepare a detailed geopolitical policy report for government decision makers.",
        );
        // The first attempt at an answer was not valid JSON; the repaired
        // decision carries the same authority as any other structured turn.
        const confirmationResponse = await postMessage(
          "You have my authorization; hand the approved work to the team now.",
        );
        const confirmation = (await confirmationResponse.json()) as {
          plan: { status: string; taskId?: string };
          task?: unknown;
        };

        assert.equal(confirmationResponse.status, 201);
        assert.ok(
          confirmation.plan.status === "queued" ||
            confirmation.plan.status === "running",
          `the repaired confirmation launches, got ${confirmation.plan.status}`,
        );
        assert.ok(confirmation.plan.taskId);
        const tasks = await sessionStore.listTaskRecords(session.id);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.workflowId, "wf-2");
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "the confirmed workflow to reach the launcher",
        });
      }),
  );
});

test("a ready chat response always reports that execution has not started", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "Started the workflow.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Truthful status" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Write an executive summary for B2B SaaS leaders from customer research.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as {
          messages: { text: string }[];
          plan: { status: string };
          task?: unknown;
        };

        assert.equal(response.status, 201);
        assert.equal(body.plan.status, "ready");
        assert.match(body.messages[0]!.text, /Status: ready, not started/i);
        assert.match(body.messages[0]!.text, /Begin workflow/i);
        assert.equal(body.task, undefined);
        assert.equal(launched.count, 0);
      }),
  );
});

test("a chat confirmation starts a ready workflow without the Begin workflow action", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "The workflow is ready.",
        workflowId: "wf-2",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "The user approved the plan in chat.",
        selectionAction: "keep",
        workflowId: "wf-2",
        launchIntent: "start",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Chat-confirmed launch" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });

        await postMessage(
          "Write an objective policy report for public-sector decision makers.",
        );
        const confirmationResponse = await postMessage(
          "Everything is approved; start the workflow now.",
        );
        const confirmation = (await confirmationResponse.json()) as {
          messages: { text: string }[];
          plan: { status: string; taskId?: string };
          task?: { id: string; workflowId: string };
        };

        assert.equal(confirmationResponse.status, 201);
        assert.ok(
          confirmation.plan.status === "queued" ||
            confirmation.plan.status === "running",
          `the chat confirmation launches, got ${confirmation.plan.status}`,
        );
        assert.ok(confirmation.plan.taskId);
        assert.equal(
          confirmation.task?.workflowId,
          "wf-2",
          "the dispatch response carries the launched task, not only the plan",
        );
        assert.equal(confirmation.task?.id, confirmation.plan.taskId);
        assert.match(confirmation.messages[0]!.text, /wf-2 is starting/i);
        assert.doesNotMatch(confirmation.messages[0]!.text, /Begin workflow/i);
        const tasks = await sessionStore.listTaskRecords(session.id);
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0]?.workflowId, "wf-2");
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "the confirmed workflow to reach the launcher",
        });
      }),
  );
});

test("a first request that asks to start does not launch, even when the model claims start intent", async () => {
  // The envelope forbids "start" on a first request, but the server is the
  // gate: a selection made in this same turn is not a confirmation, so the
  // plan is readied and the refusal is said aloud — nothing is admitted.
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "Starting the executive-summary workflow now.",
        workflowId: "wf-1",
        launchIntent: "start",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "First-request start" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Write a concise executive summary for B2B SaaS leaders from the attached customer research, and start it now.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as {
          messages: { text: string }[];
          plan: { status: string; selectedWorkflow?: { id: string } };
          task?: unknown;
        };

        assert.equal(response.status, 201);
        assert.equal(body.plan.status, "ready");
        assert.equal(body.plan.selectedWorkflow?.id, "wf-1");
        assert.equal(body.task, undefined);
        assert.match(body.messages[0]!.text, /could not start/i);
        assert.equal(launched.count, 0);
        assert.equal((await sessionStore.listTaskRecords(session.id)).length, 0);
      }),
  );
});

test("chat start language cannot bypass an incomplete authoritative brief", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "The user asked to run, but more detail is required.",
        workflowId: "wf-1",
        launchIntent: "start",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Thin brief" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Take it away.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as {
          messages: { text: string }[];
          plan: { status: string };
          task?: unknown;
        };
        assert.equal(body.plan.status, "needs_input");
        assert.equal(body.task, undefined);
        assert.match(body.messages[0]!.text, /more detail is required/i);
        assert.equal(launched.count, 0);
      }),
  );
});

test("Begin workflow acknowledges queue admission before an asynchronous worker launch failure", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "The workflow is ready.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "Execution is authorized.",
        selectionAction: "keep",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Launch failure" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });
        await postMessage(
          "Write a concise executive summary for B2B SaaS leaders from customer research.",
        );
        launched.fail = true;

        const approvalResponse = await postMessage(
          "The plan is approved; hand it to the team now.",
        );
        const approval = (await approvalResponse.json()) as {
          plan: { status: string };
          task?: unknown;
        };
        assert.equal(approval.plan.status, "ready");
        assert.equal(approval.task, undefined);

        const response = await fetch(`${base}/sessions/${session.id}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowId: "wf-1" }),
        });
        const task = (await response.json()) as {
          id: string;
          status: string;
          admission?: { phase: string };
        };

        assert.equal(response.status, 202);
        assert.equal(task.status, "queued");
        assert.equal(task.admission?.phase, "pending");

        const taskId = task.id;
        assert.ok(taskId);
        const failedTask = await waitForValue({
          read: () => sessionStore.getTaskRecord(session.id, taskId),
          accept: (task) => task?.status === "failed",
          description: "the asynchronous launch failure to become terminal",
        });
        assert.match(failedTask?.error ?? "", /simulated worker launch failure/i);
        const failedPlan = await waitForValue({
          read: () => sessionStore.getRunPlan(session.id),
          accept: (plan) => plan?.status === "failed",
          description: "the failed task to finalize its run plan",
        });
        assert.equal(failedPlan?.taskId, taskId);
        assert.equal(launched.count, 1);
      }),
  );
});

test("concurrent chat confirmations create exactly one task", async () => {
  await withStructuredModelResponses(
    [
      structuredDecision({
        message: "The workflow is ready.",
        workflowId: "wf-1",
        launchIntent: "none",
      }),
      structuredDecision({
        message: "Execution is authorized.",
        selectionAction: "keep",
        workflowId: "wf-1",
        launchIntent: "start",
      }),
      structuredDecision({
        message: "Execution is authorized.",
        selectionAction: "keep",
        workflowId: "wf-1",
        launchIntent: "start",
      }),
    ],
    () =>
      withSessionTaskServer(async (base, launched, sessionStore) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Concurrent confirmations" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const postMessage = (text: string) =>
          fetch(`${base}/sessions/${session.id}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              provider: "deepseek",
              model: "local-structured-model",
            }),
          });
        await postMessage(
          "Create a comprehensive product strategy report for an enterprise software leadership team.",
        );

        const confirmations = await Promise.all([
          postMessage("The baton is yours; put the approved plan into motion."),
          postMessage("Everything is settled here; send the work through."),
        ]);
        assert.deepEqual(
          confirmations.map((response) => response.status),
          [201, 201],
        );
        const payloads = await Promise.all(
          confirmations.map(
            (response) =>
              response.json() as Promise<{
                messages: { text: string }[];
                plan: { status: string };
                task?: { id: string };
              }>,
          ),
        );

        // Two confirmations, one launch: admission is idempotent under
        // concurrency, so the loser observes the winner's apply.
        assert.equal((await sessionStore.listTaskRecords(session.id)).length, 1);
        await waitForValue({
          read: () => launched.count,
          accept: (count) => count === 1,
          description: "exactly one launch to reach the launcher",
        });
        const finalPlan = await sessionStore.getRunPlan(session.id);
        assert.ok(
          finalPlan?.status === "queued" || finalPlan?.status === "running",
          `the confirmed plan is launching, got ${finalPlan?.status}`,
        );
        assert.ok(
          payloads.every((payload) =>
            /plan changed|is starting|already/i.test(payload.messages[0]!.text),
          ),
        );
      }),
  );
});

test("malformed structured receptionist output cannot launch a workflow", async () => {
  await withStructuredModelResponses(
    ["I am starting it now.", "Still not JSON."],
    () =>
      withSessionTaskServer(async (base, launched) => {
        const createResponse = await fetch(`${base}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Malformed model output" }),
        });
        const session = (await createResponse.json()) as { id: string };
        const response = await fetch(`${base}/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Write a detailed market report for enterprise software investors and deliver it as markdown.",
            provider: "deepseek",
            model: "local-structured-model",
          }),
        });
        const body = (await response.json()) as { task?: unknown };
        assert.equal(response.status, 201);
        assert.equal(body.task, undefined);
        assert.equal(launched.count, 0);
      }),
  );
});

test("session/task API contract maps service validation errors to JSON responses", async () => {
  await withSessionTaskServer(async (base) => {
    const createResponse = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Draft" }),
    });
    const session = (await createResponse.json()) as { id: string };

    const titleResponse = await fetch(`${base}/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    const titlePayload = (await titleResponse.json()) as { error: string };
    assert.equal(titleResponse.status, 400);
    assert.equal(titlePayload.error, "Field title must not be empty");

    const taskResponse = await fetch(`${base}/sessions/${session.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "" }),
    });
    const taskPayload = (await taskResponse.json()) as { error: string };
    assert.equal(taskResponse.status, 400);
    assert.equal(
      taskPayload.error,
      "Field workflowId is required and must be a non-empty string",
    );
  });
});
