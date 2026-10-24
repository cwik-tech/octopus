import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildServices } from "../../server/composition.js";
import { BrowserManager } from "../../domains/browser/browser-manager.js";
import { MCP_WORKER_TURN_URL_ENV } from "../../domains/mcp/mcp-worker-turn.js";
import type { RunStartRequest } from "../../domains/run/run-store.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { GenerateWordToolService } from "../../services/generate-word-tool-service.js";
import { YoutubeSettingsService } from "../../services/youtube-settings-service.js";
import { CapabilityDispatchRuntime } from "../../services/capability-dispatch-runtime.js";

test("composition publishes registry-built tool services and endpoint environment", async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "composition-tools-")),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, "workspace");
  const repoRootPath = path.join(root, "repo");
  await fs.mkdir(workspacePath);
  await fs.mkdir(repoRootPath);
  await fs.writeFile(
    path.join(root, "browser-settings.json"),
    JSON.stringify({ version: 1, mode: "headless" }),
  );

  const browserManager = new BrowserManager({
    profilePath: path.join(root, "browser-profile"),
    executablePath: path.join(root, "missing-browser"),
  });
  const generateWordToolService = new GenerateWordToolService({
    workspacePath,
    repoRootPath,
  });
  let launchedRequest: RunStartRequest | undefined;
  const taskLauncher = {
    async startRun(request: RunStartRequest) {
      launchedRequest = request;
      return { launched: true as const, pid: 1, cwd: request.cwd };
    },
  };
  let composition: Awaited<ReturnType<typeof buildServices>> | undefined;

  try {
    composition = await buildServices({
      store: new FileSystemRunStore(workspacePath),
      launcher: taskLauncher,
      taskLauncher,
      sessionStore: new FileSystemSessionStore(workspacePath),
      recoverInterruptedTasks: false,
      workspacePath,
      repoRootPath,
      browserManager,
      toolModuleOptions: {
        "generate-word": {
          toolService: generateWordToolService,
        },
      },
    });

    assert.deepEqual(
      composition.services.toolContributions.map(
        (contribution) => contribution.name,
      ),
      [
        "youtube",
        "browser",
        "research-web",
        "generate-word",
        "generate-excel",
        "skill-loader",
        "create-file",
      ],
    );
    const youtube = contributionNamed(composition, "youtube");
    const browser = contributionNamed(composition, "browser");
    const word = contributionNamed(composition, "generate-word");
    assert.ok(
      youtube.services.youtubeSettingsService instanceof
        YoutubeSettingsService,
    );
    assert.equal(browser.services.browserManager, browserManager);
    assert.equal(
      word.services.generateWordToolService,
      generateWordToolService,
    );
    assert.ok(
      composition.services.capabilityDispatchRuntime instanceof
        CapabilityDispatchRuntime,
    );
    assert.equal(
      composition.services.toolContributions.every(
        (contribution) => contribution.agentTool !== undefined,
      ),
      true,
    );
    assert.equal(
      composition.services.toolContributions
        .filter((contribution) => !["skill-loader", "create-file"].includes(contribution.name))
        .every((contribution) => contribution.workerEndpoint !== undefined),
      true,
    );
    assert.equal(
      contributionNamed(composition, "skill-loader").workerEndpoint,
      undefined,
    );

    await composition.start();
    assert.equal((await browserManager.status()).mode, "headless");
    await composition.activateAfterListen({
      host: "127.0.0.1",
      port: 3210,
      baseUrl: "http://127.0.0.1:3210",
      publicUrl: "http://127.0.0.1:3210",
    });

    const launcher = composition.services.authoritativeTaskLauncher;
    assert.ok(launcher);
    await launcher.startRun({
      cwd: path.join(workspacePath, "assignment"),
      env: { CALLER_VALUE: "preserved" },
    });
    assert.equal(launchedRequest?.env?.CALLER_VALUE, "preserved");
    assert.equal(
      launchedRequest?.env?.[MCP_WORKER_TURN_URL_ENV],
      `http://127.0.0.1:3210${composition.services.mcpWorkerTurnPath}`,
    );
    for (const contribution of composition.services.toolContributions) {
      const endpoint = contribution.workerEndpoint;
      if (!endpoint) continue;
      assert.equal(
        launchedRequest?.env?.[endpoint.environmentVariable],
        `http://127.0.0.1:3210${endpoint.path}`,
      );
    }
  } finally {
    if (composition) await composition.dispose();
    else await browserManager.close();
  }
});

test("tool-module construction failure disposes the composition-owned Browser", async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "composition-tool-failure-")),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, "workspace");
  const repoRootPath = path.join(root, "repo");
  await fs.mkdir(workspacePath);
  await fs.mkdir(repoRootPath);
  const browserManager = new CloseObservedBrowserManager({
    profilePath: path.join(root, "browser-profile"),
    executablePath: path.join(root, "missing-browser"),
  });
  const launcher = {
    async startRun(request: RunStartRequest) {
      return { launched: true as const, pid: 1, cwd: request.cwd };
    },
  };

  await assert.rejects(
    buildServices({
      store: new FileSystemRunStore(workspacePath),
      launcher,
      workspacePath,
      repoRootPath,
      browserManager,
      toolModuleOptions: {
        "generate-word": {
          endpoint: { path: "/invalid-word-capability" },
        },
      },
    }),
    /Generate Word endpoint path is invalid/,
  );
  assert.equal(browserManager.closed, true);
});

test("composition binds capability resource release to durable task terminal notifications", async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "composition-capability-lifecycle-")),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, "workspace");
  const repoRootPath = path.join(root, "repo");
  await fs.mkdir(workspacePath);
  await fs.mkdir(repoRootPath);
  const sessionStore = new TerminalObservedSessionStore(workspacePath);
  const launcher = {
    async startRun(request: RunStartRequest) {
      return { launched: true as const, pid: 1, cwd: request.cwd };
    },
  };

  const composition = await buildServices({
    store: new FileSystemRunStore(workspacePath),
    launcher,
    taskLauncher: launcher,
    sessionStore,
    recoverInterruptedTasks: false,
    workspacePath,
    repoRootPath,
  });

  // Two subscribers, both released on dispose: capability resources, and the
  // display-stream channel a Team run holds while it is alive. The count is
  // pinned rather than merely balanced so an accidental third subscriber —
  // the usual way a listener leaks — has to be declared here.
  assert.equal(sessionStore.subscriptionCount, 2);
  await composition.dispose();
  assert.equal(
    sessionStore.unsubscriptionCount,
    sessionStore.subscriptionCount,
  );
});

function contributionNamed(
  composition: Awaited<ReturnType<typeof buildServices>>,
  name: string,
) {
  const contribution = composition.services.toolContributions.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(contribution);
  return contribution;
}

class CloseObservedBrowserManager extends BrowserManager {
  closed = false;

  override async close(): Promise<void> {
    this.closed = true;
    await super.close();
  }
}

class TerminalObservedSessionStore extends FileSystemSessionStore {
  subscriptionCount = 0;
  unsubscriptionCount = 0;

  override subscribeTaskTerminal(
    listener: Parameters<FileSystemSessionStore["subscribeTaskTerminal"]>[0],
  ): () => void {
    this.subscriptionCount += 1;
    const unsubscribe = super.subscribeTaskTerminal(listener);
    return () => {
      this.unsubscriptionCount += 1;
      unsubscribe();
    };
  }
}
