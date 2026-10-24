import { _electron as electron, expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV,
  DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE,
  DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV,
} from "../../services/development/development-desktop-restart.js";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import { hasErrorCode } from "../../core/node-errors.js";
import { PROCESS_IDENTITY_ARGUMENT } from "../../domains/sessions/task-process-supervisor.js";
import {
  processesWorkingUnder,
  stopProcessCarrying,
  stopProcessesWorkingUnder,
} from "../support/owned-processes.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const expectsVisibleWindow = process.env.PIPELINE_DESKTOP_E2E_HEADLESS !== "1";

async function waitForChildExit(
  child: ChildProcess,
  description: string,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${description} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const method = init.method ?? "GET";
    throw new Error(
      `${method} ${url} failed within ${timeoutMs}ms: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Connects the deterministic server the way Settings does and makes its model
 * the application default. The packaged workflow fixture's Team still carries
 * `defaults.provider` and a `models` table, which the runtime now ignores, so
 * its worker runs on the application default and needs one to be chosen.
 */
async function connectDeterministicDefaultModel(
  apiBaseUrl: string,
  connection: { name: string; baseUrl: string; apiKey: string; modelId: string },
): Promise<void> {
  const providerResponse = await fetchWithTimeout(`${apiBaseUrl}/settings/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "openai-compatible",
      name: connection.name,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      enabled: true,
    }),
  });
  const provider = await providerResponse.json() as { id: string };
  expect(providerResponse.status, JSON.stringify(provider)).toBe(201);
  const validationResponse = await fetchWithTimeout(
    `${apiBaseUrl}/settings/providers/${provider.id}/validate`,
    { method: "POST" },
  );
  expect(validationResponse.status, await validationResponse.text()).toBe(200);
  // Validation lists newly discovered models as disabled; a default must be an
  // enabled model.
  const enableResponse = await fetchWithTimeout(
    `${apiBaseUrl}/settings/providers/${provider.id}/models`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: connection.modelId, enabled: true }),
    },
  );
  expect(enableResponse.status, await enableResponse.text()).toBe(200);
  const selection = { provider: `connection:${provider.id}`, model: connection.modelId };
  const defaultResponse = await fetchWithTimeout(`${apiBaseUrl}/settings/default-model`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(selection),
  });
  expect(defaultResponse.status, await defaultResponse.text()).toBe(200);
  await expect.poll(async () => {
    const response = await fetchWithTimeout(`${apiBaseUrl}/settings/providers`);
    const body = await response.json() as { defaultModel?: { provider?: string; model?: string } };
    return body.defaultModel;
  }).toEqual(selection);
}

/**
 * The opening of the fixture worker's persona
 * (tests/fixtures/packaged-workflow-smoke/agents/packaged-smoke-worker). Only
 * requests carrying it are the workflow's own worker turns; the app also asks
 * this server for a default-model health check and Team minutes.
 */
const PACKAGED_WORKER_TURN_MARKER = "You are the packaged runtime smoke worker.";

async function startDeterministicOpenAiServer(options: {
  blockResponsesUntilReleased?: boolean;
  /**
   * Hold, until released, only the worker's own turns whose request carries
   * this text. Selecting a turn by what it carries, rather than by arrival
   * number, keeps the choice right when the app adds its own requests, such as
   * a default-model health check or the Team's minutes, around the workflow's
   * turns.
   */
  blockTurnsCarrying?: string;
} = {}): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  releaseBlockedResponses(): void;
  /** The worker's own turns: requests carrying its persona. */
  requestCount(): number;
}> {
  let requests = 0;
  let served = 0;
  let responsesReleased = !(
    options.blockResponsesUntilReleased ||
    options.blockTurnsCarrying !== undefined
  );
  const blockedResponses = new Set<() => void>();
  const shouldBlockResponse = (requestText: string) =>
    !responsesReleased &&
    (options.blockTurnsCarrying === undefined ||
      (requestText.includes(PACKAGED_WORKER_TURN_MARKER) &&
        requestText.includes(options.blockTurnsCarrying)));
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        data: [{
          id: "gpt-5.4-mini",
          name: "Deterministic recovery model",
          context_length: 32_000,
        }],
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const requestText = Buffer.concat(chunks).toString("utf8");
        if (requestText.includes(PACKAGED_WORKER_TURN_MARKER)) requests += 1;
        served += 1;
        const requestNumber = served;
        const body = JSON.parse(requestText) as {
          model?: string;
        };
        const sendResponse = () => {
          blockedResponses.delete(sendResponse);
          if (response.destroyed || response.writableEnded) return;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            id: `chatcmpl_${requestNumber}`,
            object: "chat.completion",
            model: body.model ?? "gpt-5.4-mini",
            choices: [{
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "# Packaged workflow verified\n\nConfigured-provider broker recovery completed.",
              },
            }],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 7,
              total_tokens: 12,
            },
          }));
        };
        if (shouldBlockResponse(requestText)) {
          blockedResponses.add(sendResponse);
          response.once("close", () => blockedResponses.delete(sendResponse));
          return;
        }
        sendResponse();
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const requestText = Buffer.concat(chunks).toString("utf8");
      if (requestText.includes(PACKAGED_WORKER_TURN_MARKER)) requests += 1;
      served += 1;
      const requestNumber = served;
      const body = JSON.parse(requestText) as {
        model?: string;
        stream?: boolean;
      };
      const sendResponse = () => {
        blockedResponses.delete(sendResponse);
        if (response.destroyed || response.writableEnded) return;
        const text = "# Packaged workflow verified\n\nReal worker execution completed.";
        if (!body.stream) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            id: `resp_${requestNumber}`,
            model: body.model ?? "gpt-5.4-mini",
            output_text: text,
            usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
          }));
          return;
        }

        const responseId = `resp_${requestNumber}`;
        const message = {
          id: `msg_${requestNumber}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        const events = [
          { type: "response.created", response: { id: responseId } },
          { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
          { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
          { type: "response.output_item.done", output_index: 0, item: message },
          {
            type: "response.completed",
            response: {
              id: responseId,
              status: "completed",
              output: [message],
              usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
            },
          },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        for (const event of events) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      };

      if (shouldBlockResponse(requestText)) {
        // Keep real provider calls in flight so the test can kill the detached
        // worker after its durable journal has reached `running`.
        blockedResponses.add(sendResponse);
        response.once("close", () => blockedResponses.delete(sendResponse));
        return;
      }
      sendResponse();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve deterministic OpenAI server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
    releaseBlockedResponses: () => {
      responsesReleased = true;
      for (const sendResponse of [...blockedResponses]) sendResponse();
    },
    requestCount: () => requests,
  };
}

interface ElectronSessionTaskRecord {
  id: string;
  sessionId: string;
  runId: string;
  workflowId: string;
  status: string;
  assignmentPath: string;
  admission?: {
    phase: "staged" | "pending" | "granted";
    requestId: string;
    order: string;
    executionKind: "initial" | "recovery";
    source:
      | "apply"
      | "startup_repair"
      | "automatic_recovery"
      | "manual_resume";
    expectedExecutionAttemptId: string | null;
    executionAttemptId?: string;
  };
  pid?: number;
  processGroupId?: number;
  executionAttemptId?: string;
  executionAttemptNumber?: number;
  executionKind?: "initial" | "recovery";
  configuredProviderBrokerIdentity?: string;
  recoveryCount?: number;
  recoveryDisposition?: "automatic" | "manual" | "not_resumable";
  recoveryReason?: string;
  completedAt?: string;
}

async function readElectronSessionTask(
  apiBaseUrl: string,
  sessionId: string,
  taskId: string,
): Promise<ElectronSessionTaskRecord> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl}/sessions/${sessionId}/tasks/${taskId}`,
    {},
    5_000,
  );
  const body = await response.json() as ElectronSessionTaskRecord & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      `Task read failed with HTTP ${response.status}: ${body.error ?? "unknown error"}`,
    );
  }
  return body;
}

async function waitForElectronSessionTask(
  apiBaseUrl: string,
  sessionId: string,
  taskId: string,
  predicate: (task: ElectronSessionTaskRecord) => boolean,
  description: string,
  timeout = 30_000,
): Promise<ElectronSessionTaskRecord> {
  let current: ElectronSessionTaskRecord | null = null;
  await expect
    .poll(
      async () => {
        current = await readElectronSessionTask(apiBaseUrl, sessionId, taskId);
        return predicate(current);
      },
      {
        message: `Timed out waiting for ${description}`,
        timeout,
        intervals: [50, 100, 250],
      },
    )
    .toBe(true);
  return current!;
}

interface TaskResultPublicationReceipt {
  taskId: string;
  executionAttemptId: string;
  publishedAt: string;
}

async function tryReadTaskResultPublicationReceipt(
  markerPath: string,
): Promise<TaskResultPublicationReceipt | null> {
  try {
    return JSON.parse(
      await fs.readFile(markerPath, "utf8"),
    ) as TaskResultPublicationReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function waitForTaskResultPublication(
  task: ElectronSessionTaskRecord,
): Promise<TaskResultPublicationReceipt> {
  if (!task.executionAttemptId) {
    throw new Error("Terminal task has no execution attempt ID");
  }
  const markerPath = path.join(
    task.assignmentPath,
    ".runtime",
    "task-results",
    `${task.executionAttemptId}.published.json`,
  );
  let receipt: TaskResultPublicationReceipt | null = null;
  await expect
    .poll(
      async () => {
        receipt = await tryReadTaskResultPublicationReceipt(markerPath);
        return receipt !== null;
      },
      {
        message: "Timed out waiting for the durable task-result publication receipt",
        timeout: 10_000,
        intervals: [25, 50, 100],
      },
    )
    .toBe(true);
  return receipt!;
}

async function readPublishedWorkflowResult(
  task: ElectronSessionTaskRecord,
): Promise<string> {
  const publicationReceipt = await waitForTaskResultPublication(task);
  expect(publicationReceipt).toMatchObject({
    taskId: task.id,
    executionAttemptId: task.executionAttemptId,
  });
  expect(task.completedAt).toBeTruthy();
  expect(Date.parse(publicationReceipt.publishedAt)).toBeGreaterThanOrEqual(
    Date.parse(task.completedAt!),
  );
  return fs.readFile(
    path.join(task.assignmentPath, `workflow-${task.workflowId}-result.md`),
    "utf8",
  );
}

/**
 * What an attempt's ownership scope records, read from its own files: the
 * Team children it started (intents of kind `team`), which of them have no
 * `resolved/` record, and who wrote `closed.json` (undefined when it is
 * absent). A record that cannot be parsed fails the read rather than counting
 * as absent.
 */
async function readOwnedProcessScope(scopePath: string): Promise<{
  readonly teamChildren: readonly string[];
  readonly unresolvedTeamChildren: readonly string[];
  readonly closedBy: string | undefined;
}> {
  const readRecord = async (file: string): Promise<Record<string, unknown>> => {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Owned-process record ${file} is not an object`);
    }
    return Object.fromEntries(Object.entries(parsed));
  };
  const intentFiles = await fs.readdir(path.join(scopePath, "intents"));
  const teamChildren: string[] = [];
  for (const file of intentFiles.filter((name) => name.endsWith(".json"))) {
    const intent = await readRecord(path.join(scopePath, "intents", file));
    if (intent.kind === "team" && typeof intent.ownedProcessId === "string") {
      teamChildren.push(intent.ownedProcessId);
    }
  }
  const resolved = new Set(
    (await fs.readdir(path.join(scopePath, "resolved")).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length)),
  );
  const closure = await readRecord(path.join(scopePath, "closed.json")).catch(
    (error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    },
  );
  return {
    teamChildren,
    unresolvedTeamChildren: teamChildren.filter((id) => !resolved.has(id)),
    closedBy: typeof closure?.closedBy === "string" ? closure.closedBy : undefined,
  };
}

function isDetachedProcessAlive(task: ElectronSessionTaskRecord): boolean {
  const target = process.platform === "win32"
    ? task.pid
    : -(task.processGroupId ?? task.pid ?? 0);
  if (!target) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Tagged so `npm run desktop:e2e:visible` can select exactly this journey.
// Playwright 1.61.1 supports it via `TestDetails.tag`
// (node_modules/playwright/types/test.d.ts:2693-2696) and `--grep`.
//
// Only this journey is run visibly. Running the whole file under HEADLESS=0
// makes every unrelated test a visible-mode test — the first real run failed on
// a task-resumption assertion while the visibility oracle itself passed.
test(
  "desktop app starts the API and renders the main shell",
  { tag: "@visible-window" },
  async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("user-data");
  const projectRootPath = testInfo.outputPath("project");
  const piStatePath = testInfo.outputPath("pi-state");
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.mkdir(piStatePath, { recursive: true });
  await fs.cp(
    path.join(repoRoot, "tests", "fixtures", "packaged-workflow-smoke"),
    projectRootPath,
    { recursive: true },
  );
  const dropFolderPath = path.join(
    projectRootPath,
    "teams",
    "packaged-smoke-team",
    "input-files",
  );
  await fs.mkdir(dropFolderPath, { recursive: true });
  await fs.copyFile(
    path.join(
      repoRoot,
      "file-parser",
      "tests",
      "fixtures",
      "business-plan.docx",
    ),
    path.join(dropFolderPath, "business-plan.docx"),
  );
  const deterministicOpenAi = await startDeterministicOpenAiServer({
    blockResponsesUntilReleased: true,
  });
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  // The minimal system PATH a packaged app gets outside a shell, through the
  // fixture guard: no provider CLI and no fallback folders.
  const desktopEnvironment: Record<string, string> = {
    ...fixtureDesktopEnvironment({ ...process.env, PATH: "/usr/bin:/bin" }),
    OPENAI_API_KEY: "desktop-packaged-smoke-key",
    OPENAI_BASE_URL: deterministicOpenAi.baseUrl,
    PI_CODING_AGENT_DIR: piStatePath,
    PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
    ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    PIPELINE_DESKTOP_USER_DATA: userDataPath,
  };
  delete desktopEnvironment.PIPELINE_DESKTOP_E2E;

  let app: Awaited<ReturnType<typeof electron.launch>>;
  let appClosedByDevelopmentReplacement = false;
  try {
    app = await electron.launch({
      args: executablePath ? [] : ["."],
      cwd: repoRoot,
      ...(executablePath ? { executablePath } : {}),
      env: desktopEnvironment,
    });
  } catch (error) {
    await deterministicOpenAi.close();
    throw error;
  }

  const page = await app.firstWindow();
  const browserWindow = await app.browserWindow(page);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "request failed";
    // Run intentionally aborts its session-scoped interaction poll when the
    // user leaves the surface. Keep the smoke gate strict for every other
    // network failure, including failed interaction responses.
    if (
      request.method() === "GET" &&
      failure === "net::ERR_ABORTED" &&
      /\/sessions\/[^/]+\/mcp-interactions$/.test(new URL(request.url()).pathname)
    ) {
      return;
    }
    failedRequests.push(
      `${request.url()} ${failure}`,
    );
  });

  try {
    await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='));
    await expect
      .poll(
        () => browserWindow.evaluate((window) => window.isVisible()),
        { timeout: 10_000 },
      )
      .toBe(expectsVisibleWindow);
    await expect(page.getByLabel("Show sidebar").or(page.getByLabel("Hide sidebar"))).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Create" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Admin" })).toHaveCount(0);

    const webPreferences = await browserWindow.evaluate((window) => {
      const preferences = window.webContents.getLastWebPreferences();
      return {
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        sandbox: preferences.sandbox,
      };
    });
    expect(webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });

    const rendererGlobals = await page.evaluate(() => ({
      process: typeof window.process,
      require: typeof window.require,
    }));
    expect(rendererGlobals).toEqual({ process: "undefined", require: "undefined" });

    const contentSecurityPolicy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(contentSecurityPolicy).toContain("default-src 'self'");
    expect(contentSecurityPolicy).toContain("object-src 'none'");
    expect(contentSecurityPolicy).toContain("connect-src 'self' http://127.0.0.1:*");

    const apiBaseUrl = await page.evaluate(() =>
      new URLSearchParams(window.location.hash.slice(1)).get(
        "pipeline-api-base-url",
      ),
    );
    expect(apiBaseUrl).not.toBeNull();

    const tokenizedUrl = new URL(apiBaseUrl!);
    const pathSegments = tokenizedUrl.pathname.split("/");
    const token = pathSegments[2] ?? "";
    const wrongTokenUrl = new URL(tokenizedUrl);
    pathSegments[2] = "x".repeat(token.length);
    wrongTokenUrl.pathname = `${pathSegments.join("/")}/health`;
    const [missingResponse, wrongResponse] = await Promise.all([
      fetch(`${tokenizedUrl.origin}/health`),
      fetch(wrongTokenUrl),
    ]);
    expect(missingResponse.status).toBe(401);
    expect(wrongResponse.status).toBe(401);
    expect(pathSegments[1]).toBe("_pipeline");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const health = await page.evaluate(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      return {
        payload: (await response.json()) as { ok: boolean },
        status: response.status,
      };
    }, apiBaseUrl!);
    expect(health).toEqual({ payload: { ok: true }, status: 200 });
    await expect(page.getByLabel("Settings")).toBeVisible();

    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & {
        __pipelineOpenedExternalUrls?: string[];
      };
      state.__pipelineOpenedExternalUrls = [];
      shell.openExternal = async (url: string) => {
        state.__pipelineOpenedExternalUrls?.push(url);
      };
    });

    const rendererUrl = page.url();
    await page.evaluate(() => {
      const newWindowLink = document.createElement("a");
      newWindowLink.href = "https://example.com/window";
      newWindowLink.target = "_blank";
      document.body.append(newWindowLink);
      newWindowLink.click();
      newWindowLink.remove();

      const disallowedLink = document.createElement("a");
      disallowedLink.href = "file:///tmp/pipeline-untrusted-navigation";
      disallowedLink.target = "_blank";
      document.body.append(disallowedLink);
      disallowedLink.click();
      disallowedLink.remove();
    });

    const navigationPrevented = await browserWindow.evaluate((window) => {
      let prevented = false;
      window.webContents.emit(
        "will-navigate",
        {
          preventDefault() {
            prevented = true;
          },
        } as Electron.Event,
        "https://example.com/navigation",
      );
      return prevented;
    });
    expect(navigationPrevented).toBe(true);

    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __pipelineOpenedExternalUrls?: string[];
          };
          return state.__pipelineOpenedExternalUrls ?? [];
        }),
      )
      .toEqual([
        "https://example.com/window",
        "https://example.com/navigation",
      ]);
    expect(page.url()).toBe(rendererUrl);
    expect(app.windows()).toHaveLength(1);

    if (executablePath) {
      for (const seededPath of [
        "agents",
        "skills",
        "teams",
        "workflows",
        "teams.yaml",
        "start.yaml",
      ]) {
        await expect(
          fs.stat(path.join(projectRootPath, seededPath)),
        ).resolves.toBeDefined();
      }
    }

    // Leaving Create cancels its history read. Finish this smoke's read before
    // navigating back so its strict network oracle does not reject that cleanup.
    const [historyResponse] = await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/create/workflow-architect/turns'),
      ),
      page.getByRole("tab", { name: "Create" }).click(),
    ]);
    expect(historyResponse.ok()).toBe(true);
    await historyResponse.finished();
    await expect(page.getByRole("tab", { name: "Workflows" })).toBeVisible();

    await page.getByRole("tab", { name: "Run" }).click();
    await expect(page.getByRole("region", { name: "Run chat" })).toBeVisible();

    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    expect(
      consoleErrors.filter(
        (message) =>
          !message.includes(
            "Not allowed to load local resource: file:///tmp/pipeline-untrusted-navigation",
          ),
      ),
    ).toEqual([]);

    const sessionResponse = await fetchWithTimeout(`${apiBaseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Desktop deterministic worker" }),
    });
    const sessionResponseBody = await sessionResponse.json();
    expect(sessionResponse.status, JSON.stringify(sessionResponseBody)).toBe(
      201,
    );
    const session = sessionResponseBody as { id: string };
    const uploadResponse = await fetchWithTimeout(
      `${apiBaseUrl}/sessions/${session.id}/files`,
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-filename": encodeURIComponent("desktop-note.txt"),
        },
        body: "Packaged file parser smoke input.",
      },
      30_000,
    );
    const uploadResponseBody = await uploadResponse.json();
    expect(uploadResponse.status, JSON.stringify(uploadResponseBody)).toBe(
      201,
    );
    const uploadedFile = uploadResponseBody as { parseStatus: string };
    expect(uploadedFile.parseStatus).toBe("parsed");

    await connectDeterministicDefaultModel(apiBaseUrl!, {
      name: "Packaged smoke fixture",
      baseUrl: deterministicOpenAi.baseUrl,
      apiKey: "desktop-packaged-smoke-key",
      modelId: "gpt-5.4-mini",
    });

    const taskResponse = await fetchWithTimeout(
      `${apiBaseUrl}/sessions/${session.id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "packaged-smoke",
          brief: "Return the deterministic packaged workflow smoke result.",
        }),
      },
      15_000,
    );
    const taskResponseBody = await taskResponse.json();
    expect(taskResponse.status, JSON.stringify(taskResponseBody)).toBe(202);
    const acceptedTask = taskResponseBody as ElectronSessionTaskRecord;
    expect(acceptedTask).toMatchObject({
      id: acceptedTask.runId,
      sessionId: session.id,
      workflowId: "packaged-smoke",
      status: "queued",
      admission: {
        phase: "pending",
        executionKind: "initial",
        source: "apply",
        expectedExecutionAttemptId: null,
      },
    });
    expect(acceptedTask.executionAttemptId).toBeUndefined();
    expect(acceptedTask.executionAttemptNumber).toBeUndefined();

    const runningTask = await waitForElectronSessionTask(
      apiBaseUrl!,
      session.id,
      acceptedTask.id,
      (current) => current.status === "running",
      "the accepted task to transition from queued to running",
      20_000,
    );
    expect(runningTask).toMatchObject({
      status: "running",
      executionAttemptNumber: 1,
      executionKind: "initial",
      admission: {
        phase: "granted",
        executionKind: "initial",
      },
    });
    expect(runningTask.executionAttemptId).toBeTruthy();
    expect(runningTask.admission?.executionAttemptId).toBe(
      runningTask.executionAttemptId,
    );
    expect(runningTask.processGroupId ?? runningTask.pid).toBeTruthy();

    deterministicOpenAi.releaseBlockedResponses();
    const terminalTask = await waitForElectronSessionTask(
      apiBaseUrl!,
      session.id,
      acceptedTask.id,
      (current) => ["done", "failed", "blocked", "cancelled"].includes(
        current.status,
      ),
      "the running task to reach a terminal state",
      60_000,
    );
    expect(terminalTask.status).toBe("done");
    expect(terminalTask.admission).toBeUndefined();
    expect(terminalTask.executionAttemptId).toBe(runningTask.executionAttemptId);
    expect(deterministicOpenAi.requestCount()).toBeGreaterThan(0);
    const workflowResult = await readPublishedWorkflowResult(terminalTask);
    expect(workflowResult).toContain("Packaged workflow verified");
    const dropFolderManifest = JSON.parse(
      await fs.readFile(
        path.join(dropFolderPath, "parsed", "_manifest.json"),
        "utf8",
      ),
    ) as {
      files: Array<{
        source: string;
        status: string;
        outputs?: Record<string, string>;
      }>;
    };
    const parsedDropFile = dropFolderManifest.files.find(
      (file) => file.source === "business-plan.docx",
    );
    expect(parsedDropFile).toMatchObject({
      source: "business-plan.docx",
      status: "success",
    });
    expect(parsedDropFile?.outputs?.text).toBeTruthy();
    expect(
      await fs.readFile(
        path.join(dropFolderPath, "parsed", parsedDropFile!.outputs!.text!),
        "utf8",
      ),
    ).toContain("ExampleCo");

    await browserWindow.evaluate((window) => window.close());
    await expect.poll(() => app.windows().length).toBe(0);

    const secondInstance = spawn(
      executablePath ?? process.execPath,
      executablePath
        ? []
        : [path.join(repoRoot, "node_modules", "electron", "cli.js"), "."],
      {
        cwd: repoRoot,
        env: desktopEnvironment,
        stdio: "ignore",
      },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        secondInstance.kill();
        reject(new Error("Second desktop launch did not exit within 10 seconds."));
      }, 10_000);
      secondInstance.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      secondInstance.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0 && !signal) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Second desktop launch exited with code ${code ?? "null"} and signal ${signal ?? "none"}.`,
          ),
        );
      });
    });

    await expect.poll(() => app.windows().length).toBe(1);
    const reopenedPage = app.windows()[0]!;
    await reopenedPage.waitForLoadState("domcontentloaded");
    const reopenedWindow = await app.browserWindow(reopenedPage);
    await expect
      .poll(() => reopenedWindow.evaluate((window) => window.isVisible()))
      .toBe(expectsVisibleWindow);

    if (!executablePath) {
      const primaryExit = waitForChildExit(
        app.process(),
        "The original development desktop",
      );
      const replacementRequest = spawn(
        process.execPath,
        [path.join(repoRoot, "node_modules", "electron", "cli.js"), "."],
        {
          cwd: repoRoot,
          env: {
            ...desktopEnvironment,
            [DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV]: "1",
            [DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV]: repoRoot,
          },
          stdio: "ignore",
        },
      );
      const replacementExit = await waitForChildExit(
        replacementRequest,
        "The development replacement request",
      );
      expect(replacementExit).toEqual({
        code: DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE,
        signal: null,
      });
      expect(await primaryExit).toEqual({ code: 0, signal: null });
      appClosedByDevelopmentReplacement = true;
    }
  } finally {
    if (!appClosedByDevelopmentReplacement) await app.close();
    await deterministicOpenAi.close();
  }
});

test("fresh desktop process resumes one interrupted persisted task as a new execution attempt", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const userDataPath = testInfo.outputPath("recovery-user-data");
  const projectRootPath = testInfo.outputPath("recovery-project");
  const piStatePath = testInfo.outputPath("recovery-pi-state");
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.mkdir(piStatePath, { recursive: true });
  await fs.cp(
    path.join(repoRoot, "tests", "fixtures", "packaged-workflow-smoke"),
    projectRootPath,
    { recursive: true },
  );

  // The finalize step's brief is the write step's result, so its turn carries
  // the text this server answered the write step with. Holding exactly that
  // turn leaves the worker running in finalize for the crash below.
  const deterministicOpenAi = await startDeterministicOpenAiServer({
    blockTurnsCarrying: "Configured-provider broker recovery completed.",
  });
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  // The same minimal system PATH, through the fixture guard.
  const launchEnvironment: Record<string, string> = {
      ...fixtureDesktopEnvironment({ ...process.env, PATH: "/usr/bin:/bin" }),
      // The coordinator-free team registry still declares the repo-local
      // OpenAI host bridge. Its agent provider is replaced below with the
      // configured connection, whose real credential remains brokered.
      OPENAI_API_KEY: "desktop-recovery-host-key",
      PI_CODING_AGENT_DIR: piStatePath,
      PIPELINE_DESKTOP_E2E: "1",
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
  };
  const launchDesktop = () => electron.launch({
    args: executablePath ? [] : ["."],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: launchEnvironment,
  });
  let app = await launchDesktop();
  let page = await app.firstWindow();
  let launchedTask: ElectronSessionTaskRecord | null = null;
  let processToCleanUp: ElectronSessionTaskRecord | null = null;
  let bodyFailure: { readonly error: unknown } | undefined;

  try {
    await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='));
    let apiBaseUrl = await page.evaluate(() =>
      new URLSearchParams(window.location.hash.slice(1)).get(
        "pipeline-api-base-url",
      ),
    );
    expect(apiBaseUrl).not.toBeNull();

    const sessionResponse = await fetchWithTimeout(`${apiBaseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Interrupted recovery E2E" }),
    });
    const session = await sessionResponse.json() as { id: string };
    expect(sessionResponse.status).toBe(201);

    await connectDeterministicDefaultModel(apiBaseUrl!, {
      name: "Recovery broker fixture",
      baseUrl: deterministicOpenAi.baseUrl,
      apiKey: "desktop-recovery-key",
      modelId: "gpt-5.4-mini",
    });

    const taskResponse = await fetchWithTimeout(
      `${apiBaseUrl}/sessions/${session.id}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "packaged-smoke",
          brief: "Verify that the same persisted run can recover in Electron.",
        }),
      },
      15_000,
    );
    const acceptedTask = await taskResponse.json() as ElectronSessionTaskRecord;
    launchedTask = acceptedTask;
    expect(taskResponse.status, JSON.stringify(acceptedTask)).toBe(202);
    expect(acceptedTask).toMatchObject({
      id: acceptedTask.runId,
      sessionId: session.id,
      workflowId: "packaged-smoke",
      status: "queued",
      admission: {
        phase: "pending",
        executionKind: "initial",
        source: "apply",
        expectedExecutionAttemptId: null,
      },
    });
    expect(acceptedTask.executionAttemptId).toBeUndefined();
    expect(acceptedTask.executionAttemptNumber).toBeUndefined();

    const runningTask = await waitForElectronSessionTask(
      apiBaseUrl!,
      session.id,
      acceptedTask.id,
      (current) => current.status === "running",
      "the recovery fixture task to transition from queued to running",
      20_000,
    );
    launchedTask = runningTask;
    processToCleanUp = runningTask;
    expect(runningTask).toMatchObject({
      status: "running",
      executionAttemptNumber: 1,
      executionKind: "initial",
      recoveryCount: 0,
      admission: {
        phase: "granted",
        executionKind: "initial",
      },
    });
    expect(runningTask.executionAttemptId).toBeTruthy();
    expect(runningTask.admission?.executionAttemptId).toBe(
      runningTask.executionAttemptId,
    );
    expect(runningTask.configuredProviderBrokerIdentity).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(runningTask.processGroupId ?? runningTask.pid).toBeTruthy();
    expect(isDetachedProcessAlive(runningTask)).toBe(true);
    await expect
      .poll(() => deterministicOpenAi.requestCount(), { timeout: 20_000 })
      .toBe(2);

    const journalPath = path.join(
      launchedTask.assignmentPath,
      ".runtime",
      "workflow-state.json",
    );
    await expect
      .poll(async () => {
        try {
          const state = JSON.parse(await fs.readFile(journalPath, "utf8")) as {
            currentStepId?: string;
            status: string;
          };
          return `${state.status}:${state.currentStepId ?? "none"}`;
        } catch {
          return "missing";
        }
      })
      .toBe("running:finalize");

    // Freeze the worker and crash only the owning desktop/API process. The
    // fresh API must detect that this live worker is bound to the obsolete
    // authenticated broker endpoint, terminate it, and recover from journal.
    if (runningTask.processGroupId && process.platform !== "win32") {
      process.kill(-runningTask.processGroupId, "SIGSTOP");
    }
    const desktopProcess = app.process();
    const desktopExit = once(desktopProcess, "exit");
    desktopProcess.kill("SIGKILL");
    await desktopExit;
    expect(isDetachedProcessAlive(runningTask)).toBe(true);

    app = await launchDesktop();
    page = await app.firstWindow();
    await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='));
    apiBaseUrl = await page.evaluate(() =>
      new URLSearchParams(window.location.hash.slice(1)).get(
        "pipeline-api-base-url",
      ),
    );
    expect(apiBaseUrl).not.toBeNull();

    let interruptedTask: ElectronSessionTaskRecord | null = null;
    await expect
      .poll(async () => {
        interruptedTask = await readElectronSessionTask(
          apiBaseUrl!,
          session.id,
          launchedTask!.id,
        );
        return interruptedTask.status;
      }, { timeout: 25_000 })
      .toBe("interrupted");
    // ADR A4.2c item 14. Recovery reports the dead attempt interrupted only
    // after the frozen root's group has exited and the attempt's owned
    // processes are closed, and before anything resumes it. So at that moment
    // no process works inside this journey's folder, which holds every
    // workspace and assignment it created (found by working directory, which
    // a renamed process title cannot hide), and the attempt's scope records
    // every Team child it started as resolved, and its closure by recovery.
    expect(
      processesWorkingUnder(userDataPath),
      "processes still working in the journey's folder once the attempt reads interrupted",
    ).toEqual([]);
    const frozenAttemptScope = await readOwnedProcessScope(
      path.join(
        userDataPath,
        "workspace",
        "sessions",
        session.id,
        "tasks",
        launchedTask.id,
        "owned-processes",
        "attempt-1",
      ),
    );
    expect(
      frozenAttemptScope.teamChildren.length,
      "Team children the frozen attempt started",
    ).toBeGreaterThan(0);
    expect(
      frozenAttemptScope.unresolvedTeamChildren,
      "Team children the frozen attempt's scope does not record as resolved",
    ).toEqual([]);
    expect(frozenAttemptScope.closedBy, "who closed the frozen attempt's scope").toBe("recovery");
    await expect
      .poll(() => isDetachedProcessAlive(runningTask), { timeout: 10_000 })
      .toBe(false);
    processToCleanUp = null;

    expect(interruptedTask).toMatchObject({
      id: launchedTask.id,
      runId: launchedTask.runId,
      executionAttemptId: launchedTask.executionAttemptId,
      executionAttemptNumber: 1,
      recoveryCount: 0,
      recoveryDisposition: "manual",
    });
    expect(interruptedTask!.recoveryReason).toContain(
      "requires a user recovery decision",
    );
    const requestsBeforeRecovery = deterministicOpenAi.requestCount();
    expect(requestsBeforeRecovery).toBe(2);

    // Wait until RunPanel has finished its own startup-session hydration; an
    // earlier sidebar selection can otherwise be overwritten by that initial
    // state transition. Then select through the visible desktop sidebar so
    // the same App -> RunPanel request path used by an operator is exercised.
    const hydratedRunPanelSession = page
      .getByRole("tabpanel", { name: "Run" })
      .getByRole("button", {
        name: /^Interrupted recovery E2E (?!Workflow session)/,
      });
    await expect(hydratedRunPanelSession).toBeAttached({ timeout: 10_000 });
    const desktopSessionButton = page.getByRole("button", {
      name: "Interrupted recovery E2E",
      exact: true,
    });
    await expect(desktopSessionButton).toBeVisible();
    await desktopSessionButton.click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    const runSummary = page.getByLabel("Run summary");
    await expect(
      runSummary.getByText("Interrupted", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Attempt 1", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Recoveries 0", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(launchedTask.executionAttemptId!, { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("The interrupted step requires a user recovery decision.", {
        exact: true,
      }),
    ).toHaveCount(0);

    const resumeResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(
        `/sessions/${session.id}/tasks/${launchedTask!.id}/resume`,
      ),
    );
    await runSummary.getByRole("button", { name: "Resume", exact: true }).click();
    const resumeResponse = await resumeResponsePromise;
    const acceptedRecovery = await resumeResponse.json() as ElectronSessionTaskRecord;
    expect(resumeResponse.status(), JSON.stringify(acceptedRecovery)).toBe(202);
    expect(acceptedRecovery).toMatchObject({
      id: launchedTask.id,
      runId: launchedTask.runId,
      status: "interrupted",
      executionAttemptId: launchedTask.executionAttemptId,
      executionAttemptNumber: 1,
      executionKind: "initial",
      recoveryCount: 0,
      admission: {
        phase: "pending",
        executionKind: "recovery",
        source: "manual_resume",
        expectedExecutionAttemptId: launchedTask.executionAttemptId,
      },
    });

    const resumedTask = await waitForElectronSessionTask(
      apiBaseUrl!,
      session.id,
      launchedTask.id,
      (current) =>
        current.status === "running" && current.executionAttemptNumber === 2,
      "the accepted recovery to transition from pending admission to running",
      20_000,
    );
    processToCleanUp = resumedTask;
    expect(resumedTask.id).toBe(launchedTask.id);
    expect(resumedTask.runId).toBe(launchedTask.runId);
    expect(resumedTask.executionAttemptNumber).toBe(2);
    expect(resumedTask.executionKind).toBe("recovery");
    expect(resumedTask.recoveryCount).toBe(1);
    expect(resumedTask.executionAttemptId).toBeTruthy();
    expect(resumedTask.executionAttemptId).not.toBe(
      launchedTask.executionAttemptId,
    );
    expect(resumedTask.configuredProviderBrokerIdentity).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(resumedTask.configuredProviderBrokerIdentity).not.toBe(
      launchedTask.configuredProviderBrokerIdentity,
    );
    expect(resumedTask.admission).toMatchObject({
      phase: "granted",
      executionKind: "recovery",
      source: "manual_resume",
      expectedExecutionAttemptId: launchedTask.executionAttemptId,
      executionAttemptId: resumedTask.executionAttemptId,
    });
    expect(resumedTask.processGroupId ?? resumedTask.pid).toBeTruthy();
    expect(isDetachedProcessAlive(resumedTask)).toBe(true);

    deterministicOpenAi.releaseBlockedResponses();
    const terminalTask = await waitForElectronSessionTask(
      apiBaseUrl!,
      session.id,
      launchedTask.id,
      (current) => ["done", "failed", "blocked", "cancelled"].includes(
        current.status,
      ),
      "the resumed recovery attempt to reach a terminal state",
      30_000,
    );
    processToCleanUp = terminalTask;
    expect(terminalTask.status).toBe("done");
    expect(terminalTask).toMatchObject({
      id: launchedTask.id,
      runId: launchedTask.runId,
      executionAttemptNumber: 2,
      executionKind: "recovery",
      recoveryCount: 1,
    });

    await expect(
      runSummary.getByText("Complete", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(deterministicOpenAi.requestCount()).toBe(
      requestsBeforeRecovery + 1,
    );
    const terminalJournal = JSON.parse(
      await fs.readFile(journalPath, "utf8"),
    ) as {
      steps: Array<{
        stepId: string;
        status: string;
        attemptCount: number;
      }>;
    };
    expect(
      terminalJournal.steps.map((step) => ({
        stepId: step.stepId,
        status: step.status,
        attemptCount: step.attemptCount,
      })),
    ).toEqual([
      { stepId: "write", status: "completed", attemptCount: 1 },
      { stepId: "finalize", status: "completed", attemptCount: 2 },
    ]);

    const workflowResult = await readPublishedWorkflowResult(terminalTask);
    expect(workflowResult).toContain("Packaged workflow verified");
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    // Every step runs whatever happened before it, and each keeps its own
    // error, so a failed close cannot skip the process cleanup after it.
    const cleanupErrors: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    // A task runner the journey still holds is stopped only while it still
    // carries its own identity marker. The launcher puts
    // `--runtime-process-identity=<attempt>` on its command line, and the
    // attempt id is that identity (services/task-service.ts:468-469); a pid
    // reused by another process is left alone.
    const runner = processToCleanUp;
    if (runner?.pid && runner.executionAttemptId) {
      const { pid, executionAttemptId } = runner;
      await attempt(() => stopProcessCarrying(pid, `${PROCESS_IDENTITY_ARGUMENT}${executionAttemptId}`));
    }
    await attempt(() => app.close());
    await attempt(() => deterministicOpenAi.close());
    // Nothing this journey started may outlive it. Its own user-data folder
    // holds every workspace and assignment it created, so a process still
    // working inside it is one this journey left behind. Recovery now ends the
    // frozen attempt's Team child (asserted above, ADR A4.2c item 14); this is
    // the backstop when the body failed first. It stops them and fails if any
    // stays.
    await attempt(() => stopProcessesWorkingUnder(userDataPath));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        bodyFailure ? [bodyFailure.error, ...cleanupErrors] : cleanupErrors,
        "The recovery journey's cleanup failed",
      );
    }
  }
});

test("settings validate models, Create omits its fixed header, and the shared picker scrolls", async ({}, testInfo) => {
  const fixture = await startProviderModelFixture();
  const userDataPath = testInfo.outputPath("provider-user-data");
  await fs.mkdir(userDataPath, { recursive: true });
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  const app = await electron.launch({
    args: executablePath ? [] : ["."],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: "1",
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
    },
  });
  const page = await app.firstWindow();

  try {
    await page.getByLabel("Settings").click();
    await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("Connection type").selectOption("openai-compatible");
    await page.getByLabel("Name").fill("Fixture API");
    await page.getByLabel("Base URL").fill(`${fixture.url}/v1`);
    await page.getByRole("textbox", { name: "API key", exact: true }).fill("fixture-key");
    await page.getByRole("button", { name: "Save & Validate" }).click();
    await page.getByRole("button", { name: /^Fixture API/ }).click();
    await expect(page.getByText("Fixture Chat Model", { exact: true })).toBeVisible();
    for (const model of providerFixtureModels) {
      await page.getByRole("switch", { name: `Enable ${model.name}`, exact: true }).click();
    }
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Create" }).click();
    const createChat = page.getByRole("region", {
      name: "Workflow Architect chat",
    });
    await expect(createChat).toBeVisible();
    await expect(
      createChat.locator('[data-slot="chat-shell-header"]'),
    ).toHaveCount(0);
    await expect(
      createChat.getByText("Workflow Architect", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Workflow Architect model").click();
    await expect(page.getByText("Fixture API")).toBeVisible();
    await expect(page.getByText("Fixture Chat Model", { exact: true })).toBeVisible();

    const modelList = page.locator('[data-slot="command-list"]');
    await expect(modelList).toBeVisible();
    await expect
      .poll(() =>
        modelList.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    await expect(modelList).toHaveCSS("overflow-y", "auto");
    await modelList.hover({ position: { x: 32, y: 160 } });
    await page.mouse.wheel(0, 320);
    await expect.poll(() => modelList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  } finally {
    await app.close();
    await fixture.close();
  }
});

const providerFixtureModels = Array.from({ length: 18 }, (_, index) => ({
  id: index === 0 ? "fixture/chat-model" : `fixture/chat-model-${index + 1}`,
  name:
    index === 0
      ? "Fixture Chat Model"
      : `Fixture Chat Model ${String(index + 1).padStart(2, "0")}`,
  context_length: 32_000,
}));

async function startProviderModelFixture(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models" && req.headers.authorization === "Bearer fixture-key") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        data: providerFixtureModels,
      }));
      return;
    }
    res.statusCode = 401;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider fixture failed to listen");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
