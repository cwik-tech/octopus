import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionTask } from "../../contracts/sessions.js";
import { validateCodexSubscriptionAuth } from "../../core/codex-subscription-auth.js";
import {
  SourceFileParserLauncher,
  TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV,
} from "../../core/file-parser-launcher.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { PiRunLauncher } from "../../domains/run/run-launcher.js";
import {
  defaultIsProcessAlive,
} from "../../domains/sessions/task-process-supervisor.js";
import { SessionTaskRunnerLauncher } from "../../domains/sessions/session-task-launcher.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { TeamFileStore } from "../../domains/team-files/team-file-store.js";
import { generateWordBuffer } from "../../domains/word-generation/generate-word.js";
import { startApiServer, type StartedApiServer } from "../../server/api-server.js";
import {
  createLiveFileGroundingFixture,
  LIVE_FILE_WORKFLOW_ID,
  LIVE_TEAM_RUNTIME_WORKFLOW_ID,
} from "../helpers/live-file-grounding-fixture.js";
import {
  cliCapability,
  liveTest,
} from "./live-provider-support.js";

const REPO_ROOT = process.cwd();
const LIVE_MODEL =
  process.env.PIPELINE_LIVE_FILE_GROUNDING_MODEL?.trim() || "default";
const LIVE_HOST_MODEL =
  process.env.PIPELINE_LIVE_FILE_GROUNDING_HOST_MODEL?.trim() ||
  "gpt-5.4-mini";
const CLI_CAPABILITY = await cliCapability("codex");
const CODEX_AUTH_ERROR = CLI_CAPABILITY.available
  ? validateCodexSubscriptionAuth()
  : undefined;
const CODEX_CAPABILITY = CODEX_AUTH_ERROR
  ? {
      available: false,
      reason: `Codex CLI subscription auth is unavailable: ${CODEX_AUTH_ERROR}`,
    }
  : CLI_CAPABILITY;
const LIVE_TIMEOUT_MS = 12 * 60_000;

liveTest(
  "all four file-ingestion channels ground real Codex CLI responses in uploaded content",
  "file-grounding-codex",
  CODEX_CAPABILITY,
  async (context) => {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "live-file-grounding-workspace-"),
    );
    const fixture = createLiveFileGroundingFixture({
      model: LIVE_MODEL,
      hostModel: LIVE_HOST_MODEL,
    });
    const sessionStore = new FileSystemSessionStore(workspacePath);
    const teamFileStore = new TeamFileStore(workspacePath);
    const environment = forceCliProviderTransport();
    const launchedTasks: SessionTask[] = [];
    let server: StartedApiServer | undefined;

    try {
      server = await startApiServer({
        store: new FileSystemRunStore(workspacePath),
        launcher: new PiRunLauncher(),
        taskLauncher: new SessionTaskRunnerLauncher(REPO_ROOT),
        sessionStore,
        teamFileStore,
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
        workspacePath,
        fileParserLauncher: new SourceFileParserLauncher(REPO_ROOT),
      });

      await context.test(
        "Workflow Run uploads through the session route and returns grounded output",
        async () => {
          const evidence = createEvidence("workflow");
          const sessionId = await createSession(server!, "Live Workflow file grounding");
          await uploadSessionFile(
            server!,
            sessionId,
            "workflow-evidence.txt",
            evidence.contents,
          );
          const task = await launchWorkflow(
            server!,
            sessionStore,
            sessionId,
            LIVE_FILE_WORKFLOW_ID,
            groundingRequest(),
            launchedTasks,
          );
          assertGroundedWorkflowResult(task, evidence);
          assertCodexCliProviderLog(task);
        },
      );

      await context.test(
        "Agent Chat uploads through the session route and returns grounded output",
        async () => {
          const evidence = createEvidence("agent-chat");
          const sessionId = await createSession(server!, "Live Agent Chat file grounding");
          await uploadSessionFile(
            server!,
            sessionId,
            "agent-chat-evidence.txt",
            evidence.contents,
          );

          const response = await fetch(
            `${server!.url}/sessions/${sessionId}/agent-chat/messages`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: groundingRequest(),
                agentNames: [],
                provider: "codex",
                model: LIVE_MODEL,
              }),
            },
          );
          const responseText = await response.text();
          assert.equal(response.status, 201, responseText);
          const turn = JSON.parse(responseText) as {
            replies: Array<{ text: string }>;
            meta: {
              replies: Array<{
                model: string;
                fallback: boolean;
                reason?: string;
              }>;
            };
          };
          assert.equal(turn.meta.replies.length, 1);
          assert.equal(
            turn.meta.replies[0]?.fallback,
            false,
            turn.meta.replies[0]?.reason,
          );
          assert.notEqual(turn.meta.replies[0]?.model, "fallback");
          assertGrounded(turn.replies[0]?.text ?? "", evidence);
        },
      );

      await context.test(
        "Resource Architect uploads through its team-file route and returns grounded output",
        async () => {
          const evidence = createEvidence("resource-architect");
          const draftId = `live-draft-${randomUUID()}`;
          await uploadTeamFile(
            server!,
            draftId,
            "resource-architect-evidence.txt",
            evidence.contents,
          );

          const response = await fetch(
            `${server!.url}/create/resource-architect/turn`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jobId: `live-resource-architect-${randomUUID()}`,
                operation: "conversation",
                history: [{ role: "user", text: groundingRequest() }],
                currentPlan: null,
                provider: "codex",
                model: LIVE_MODEL,
                draftId,
              }),
            },
          );
          const responseText = await response.text();
          assert.equal(response.status, 200, responseText);
          const turn = JSON.parse(responseText) as {
            message: string;
            meta: { model: string; fallback: boolean; reason?: string };
          };
          assert.equal(turn.meta.fallback, false, turn.meta.reason);
          assert.notEqual(turn.meta.model, "fallback");
          assertGrounded(turn.message, evidence);
        },
      );

      await context.test(
        "Team Runtime parses a DOCX drop-folder file and returns grounded output",
        async () => {
          const evidence = createEvidence("team-runtime");
          const docx = await generateWordBuffer([
            "# Live Team Runtime Evidence",
            "",
            evidence.contents,
          ].join("\n"));
          fs.writeFileSync(
            path.join(fixture.teamDropFolderPath, "team-runtime-evidence.docx"),
            docx.buffer,
          );

          const sessionId = await createSession(
            server!,
            "Live Team Runtime file grounding",
          );
          const task = await launchWorkflow(
            server!,
            sessionStore,
            sessionId,
            LIVE_TEAM_RUNTIME_WORKFLOW_ID,
            groundingRequest(),
            launchedTasks,
            7 * 60_000,
          );
          assertGroundedWorkflowResult(task, evidence);
          assertCodexCliProviderLog(task);

          const manifestPath = path.join(
            fixture.teamDropFolderPath,
            "parsed",
            "_manifest.json",
          );
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
            files?: Array<{ source?: string; status?: string }>;
          };
          assert.ok(
            manifest.files?.some(
              (file) =>
                file.source === "team-runtime-evidence.docx" &&
                file.status === "success",
            ),
            "Team Runtime did not parse the DOCX drop-folder evidence",
          );
        },
      );
    } finally {
      await server?.close().catch(() => undefined);
      for (const task of launchedTasks) {
        await stopTaskProcess(task);
      }
      environment.restore();
      fixture.cleanup();
      makeTreeWritable(workspacePath);
      fs.rmSync(workspacePath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  },
  LIVE_TIMEOUT_MS,
);

interface Evidence {
  token: string;
  fact: string;
  contents: string;
}

function createEvidence(channel: string): Evidence {
  const token = `${channel.toUpperCase().replaceAll("-", "_")}_${randomUUID()}`;
  const fact = `FACT_${randomUUID()}`;
  return {
    token,
    fact,
    contents: [
      "This document is live CLI-provider grounding evidence.",
      `GROUNDING_TOKEN: ${token}`,
      `GROUNDING_FACT: ${fact}`,
      "",
    ].join("\n"),
  };
}

function groundingRequest(): string {
  return [
    "Read the supplied file evidence.",
    "Return the values named GROUNDING_TOKEN and GROUNDING_FACT exactly as written.",
    "Do not infer or invent either value.",
  ].join(" ");
}

async function createSession(
  server: StartedApiServer,
  title: string,
): Promise<string> {
  const response = await fetch(`${server.url}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  const session = JSON.parse(responseText) as { id: string };
  return session.id;
}

async function uploadSessionFile(
  server: StartedApiServer,
  sessionId: string,
  filename: string,
  contents: string,
): Promise<void> {
  const response = await fetch(`${server.url}/sessions/${sessionId}/files`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-filename": encodeURIComponent(filename),
    },
    body: contents,
  });
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  const uploaded = JSON.parse(responseText) as { parseStatus?: string };
  assert.equal(uploaded.parseStatus, "parsed");
}

async function uploadTeamFile(
  server: StartedApiServer,
  draftId: string,
  filename: string,
  contents: string,
): Promise<void> {
  const response = await fetch(
    `${server.url}/create/team-files/${draftId}/files`,
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-filename": encodeURIComponent(filename),
      },
      body: contents,
    },
  );
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  const uploaded = JSON.parse(responseText) as { parseStatus?: string };
  assert.equal(uploaded.parseStatus, "parsed");
}

async function launchWorkflow(
  server: StartedApiServer,
  store: FileSystemSessionStore,
  sessionId: string,
  workflowId: string,
  brief: string,
  launchedTasks: SessionTask[],
  timeoutMs = 4 * 60_000,
): Promise<SessionTask> {
  const response = await fetch(`${server.url}/sessions/${sessionId}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflowId, brief }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 202, responseText);
  const launched = JSON.parse(responseText) as SessionTask;
  launchedTasks.push(launched);
  const task = await waitForTerminalTask(
    store,
    sessionId,
    launched.id,
    timeoutMs,
  );
  assert.equal(task.status, "done", task.error);
  assert.ok(task.runPath);
  assert.ok(task.assignmentPath);
  launchedTasks[launchedTasks.indexOf(launched)] = task;
  return task;
}

async function waitForTerminalTask(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
  timeoutMs: number,
): Promise<SessionTask> {
  const deadline = Date.now() + timeoutMs;
  let lastTask: SessionTask | null = null;
  while (Date.now() < deadline) {
    lastTask = await store.getTaskRecord(sessionId, taskId);
    if (
      lastTask &&
      ["done", "failed", "blocked", "cancelled"].includes(lastTask.status)
    ) {
      return lastTask;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Live task '${taskId}' did not finish within ${timeoutMs}ms: ${JSON.stringify(lastTask)}`,
  );
}

function assertGroundedWorkflowResult(
  task: SessionTask,
  evidence: Evidence,
): void {
  assert.ok(task.runPath);
  const output = walkFiles(task.runPath)
    .filter((filePath) => path.basename(filePath) === "result.md")
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  assert.ok(output, "Workflow did not publish result.md");
  assertGrounded(output, evidence);
}

function assertGrounded(value: string, evidence: Evidence): void {
  assert.match(value, new RegExp(escapeRegExp(evidence.token)));
  assert.match(value, new RegExp(escapeRegExp(evidence.fact)));
}

function assertCodexCliProviderLog(task: SessionTask): void {
  assert.ok(task.runPath);
  const logs = walkFiles(task.runPath)
    .filter((filePath) => path.basename(filePath) === "provider-events.jsonl")
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  assert.match(logs, /"provider":"codex"/);
  assert.match(logs, /"event":"request\.end","status":"completed"/);
  assert.doesNotMatch(
    logs,
    /"provider":"(?:openai|anthropic|deepseek|xai|openrouter|kimi)"/,
  );
}

function walkFiles(rootPath: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function stopTaskProcess(task: SessionTask): Promise<void> {
  if (!task.pid) return;
  const target =
    process.platform === "win32"
      ? task.pid
      : -(task.processGroupId ?? task.pid);
  const deadline = Date.now() + 10_000;
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (!defaultIsProcessAlive(target)) return;
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // The process may have exited between the liveness check and the signal.
  }
}

function makeTreeWritable(entryPath: string): void {
  const stat = fs.lstatSync(entryPath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(entryPath, 0o700);
    for (const entry of fs.readdirSync(entryPath)) {
      makeTreeWritable(path.join(entryPath, entry));
    }
    return;
  }
  if (stat.isFile()) fs.chmodSync(entryPath, 0o600);
}

function forceCliProviderTransport(): { restore(): void } {
  const updates: Record<string, string | undefined> = {
    OPENAI_API_KEY: "",
    FILE_PARSER_OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CLAUDE_API_KEY: "",
    OPENROUTER_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    XAI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    KIMI_API_KEY: "",
    OPENAI_BASE_URL: undefined,
    WORKFLOW_GENERATOR_OPENAI_API_URL: undefined,
    FILE_PARSER_LLM_ENABLED: "0",
    TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: undefined,
    [TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV]: path.join(
      REPO_ROOT,
      "file-parser",
      "dist",
      "index.js",
    ),
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(updates)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return {
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}
