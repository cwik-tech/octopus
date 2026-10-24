import * as z from 'zod/v4';
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

import {
  ElectronSessionTaskLauncher,
  resolveDesktopAppRootPath,
  resolveDesktopSessionTaskRunnerPath,
  type DesktopSpawnProcess,
} from "../../electron/session-task-launcher.js";
import {
  requireDesktopHeadlessNodePath,
  resolveDesktopHeadlessNodePath,
} from "../../electron/headless-node-runtime.js";
import { PROCESS_IDENTITY_ARGUMENT } from "../../domains/sessions/session-task-launcher.js";
import { configuredProviderBrokerIdentity } from "../../domains/sessions/provider-broker-identity.js";
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from "../../domains/runtime/agent-text-delta-tokens.js";

test("macOS headless desktop workers use the background-only Electron Helper executable", () => {
  const appPath = path.join(
    os.tmpdir(),
    "Pipeline.app",
    "Contents",
    "MacOS",
    "Pipeline",
  );

  assert.equal(
    resolveDesktopHeadlessNodePath(appPath, "darwin"),
    path.join(
      os.tmpdir(),
      "Pipeline.app",
      "Contents",
      "Frameworks",
      "Pipeline Helper.app",
      "Contents",
      "MacOS",
      "Pipeline Helper",
    ),
  );
});

test("macOS preserves a standalone Node executable outside an app bundle", () => {
  assert.equal(
    resolveDesktopHeadlessNodePath("/opt/homebrew/bin/node", "darwin"),
    "/opt/homebrew/bin/node",
  );
});

test("desktop headless workers fail closed when their runtime is missing", () => {
  assert.throws(
    () => requireDesktopHeadlessNodePath(
      path.join(os.tmpdir(), "missing", "Pipeline.app", "Contents", "MacOS", "Pipeline"),
      "darwin",
    ),
    /Desktop headless Node runtime is missing/,
  );
});

test("desktop app root resolution distinguishes development and packaged layouts", () => {
  const developmentRoot = path.join(os.tmpdir(), "pipeline-development");
  const developmentModuleUrl = pathToFileURL(
    path.join(developmentRoot, "dist-electron", "electron", "main.js"),
  ).href;
  assert.equal(
    resolveDesktopAppRootPath({
      isPackaged: false,
      moduleUrl: developmentModuleUrl,
      resourcesPath: path.join(os.tmpdir(), "unused-resources"),
    }),
    developmentRoot,
  );

  const resourcesPath = path.join(
    os.tmpdir(),
    "Pipeline.app",
    "Contents",
    "Resources",
  );
  assert.equal(
    resolveDesktopAppRootPath({
      isPackaged: true,
      moduleUrl: developmentModuleUrl,
      resourcesPath,
    }),
    path.join(resourcesPath, "app"),
  );

  const overridePath = path.join(os.tmpdir(), "pipeline-override");
  assert.equal(
    resolveDesktopAppRootPath({
      appRootOverride: overridePath,
      isPackaged: true,
      moduleUrl: developmentModuleUrl,
      resourcesPath,
    }),
    overridePath,
  );
});

test("Electron taskLauncher targets the compiled deterministic session worker", async () => {
  const appRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "electron-task-launcher-"),
  );
  const projectRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "electron-task-project-"),
  );
  const runnerEntry = resolveDesktopSessionTaskRunnerPath(appRootPath);
  fs.mkdirSync(path.dirname(runnerEntry), { recursive: true });
  fs.writeFileSync(runnerEntry, "// compiled deterministic worker\n");

  let unrefCalled = false;
  let spawnCall:
    | {
        command: string;
        args: readonly string[];
        options: Parameters<DesktopSpawnProcess>[2];
      }
    | undefined;
  const spawnProcess: DesktopSpawnProcess = (command, args, options) => {
    spawnCall = { command, args, options };
    const emitter = new EventEmitter();
    const child = {
      pid: 4312,
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      unref() {
        unrefCalled = true;
      },
    } as ReturnType<DesktopSpawnProcess>;
    queueMicrotask(() => emitter.emit("spawn"));
    return child;
  };

  try {
    const launcher = new ElectronSessionTaskLauncher(
      appRootPath,
      projectRootPath,
      "/Applications/Pipeline.app/Contents/MacOS/Pipeline",
      spawnProcess,
    );
    launcher.setRuntimeEnvironmentProvider(async () => ({
      PIPELINE_CONFIGURED_PROVIDER_BROKER_URL: "http://127.0.0.1/broker",
      PIPELINE_CONFIGURED_PROVIDERS: "safe-metadata",
    }));
    const result = await launcher.startRun({
      cwd: appRootPath,
      env: {
        TEAM_RUNTIME_SESSION_ID: "session-1",
        TEAM_RUNTIME_TASK_ID: "task-1",
        TEAM_RUNTIME_WORKFLOW_ID: "workflow-1",
      },
      processIdentity: "desktop-process-identity",
    });

    assert.equal(
      spawnCall?.command,
      "/Applications/Pipeline.app/Contents/MacOS/Pipeline",
    );
    assert.deepEqual(spawnCall?.args, [
      runnerEntry,
      `${PROCESS_IDENTITY_ARGUMENT}desktop-process-identity`,
    ]);
    assert.equal(
      spawnCall?.args[0]?.endsWith(
        path.join(
          "dist-electron",
          "domains",
          "sessions",
          "session-task-runner.js",
        ),
      ),
      true,
    );
    assert.equal(spawnCall?.args[0]?.endsWith("index.ts"), false);
    assert.equal(
      spawnCall?.options.env?.TEAM_RUNTIME_SESSION_ID,
      "session-1",
    );
    assert.equal(spawnCall?.options.env?.TEAM_RUNTIME_TASK_ID, "task-1");
    assert.equal(spawnCall?.options.env?.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(
      spawnCall?.options.env?.PIPELINE_CONFIGURED_PROVIDER_BROKER_URL,
      "http://127.0.0.1/broker",
    );
    assert.equal(
      spawnCall?.options.env?.PIPELINE_CONFIGURED_PROVIDERS,
      "safe-metadata",
    );
    assert.equal(
      spawnCall?.options.env?.TEAM_RUNTIME_REPO_ROOT,
      projectRootPath,
    );
    assert.equal(
      spawnCall?.options.env?.TEAM_RUNTIME_START_SERVICES,
      "0",
    );
    assert.equal(spawnCall?.options.detached, true);
    assert.equal(spawnCall?.options.stdio, "ignore");
    assert.equal(spawnCall?.options.cwd, projectRootPath);
    assert.equal(unrefCalled, true);
    assert.deepEqual(result, {
      launched: true,
      pid: 4312,
      processGroupId: 4312,
      processIdentity: "desktop-process-identity",
      configuredProviderBrokerIdentity: configuredProviderBrokerIdentity(
        "http://127.0.0.1/broker",
      ),
      cwd: projectRootPath,
    });
  } finally {
    fs.rmSync(appRootPath, { recursive: true, force: true });
    fs.rmSync(projectRootPath, { recursive: true, force: true });
  }
});

test("Electron taskLauncher fails before spawning when the compiled worker is missing", async () => {
  const appRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "electron-task-launcher-missing-"),
  );
  let spawnCalled = false;
  const spawnProcess: DesktopSpawnProcess = () => {
    spawnCalled = true;
    throw new Error("spawn should not be called");
  };

  try {
    const launcher = new ElectronSessionTaskLauncher(
      appRootPath,
      appRootPath,
      process.execPath,
      spawnProcess,
    );
    await assert.rejects(
      launcher.startRun({ cwd: appRootPath, env: {} }),
      /Desktop session task runner is missing/,
    );
    assert.equal(spawnCalled, false);
  } finally {
    fs.rmSync(appRootPath, { recursive: true, force: true });
  }
});

test("desktop package declares runtime configuration and file-parser assets", () => {
  const value: unknown = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const fileSetSchema = z.object({ from: z.string(), to: z.string(), filter: z.array(z.string()) });
  const packageJson = z.object({ build: z.object({ files: z.array(z.union([z.string(), fileSetSchema])) }) }).parse(value);
  const packagedFiles = packageJson.build.files;
  assert.ok(packagedFiles.includes('file-parser/dist/**/*'));
  assert.ok(packagedFiles.includes('file-parser/node_modules/**/*'));
  assert.deepEqual(packagedFiles.find((entry) => typeof entry !== 'string' && entry.from === 'build/curated-resources'), { from: 'build/curated-resources', to: '.', filter: ['**/*'] }, 'Curated runtime configuration and resources must be staged at the app root');
  assert.ok(!packagedFiles.includes('agents/**/*'), 'Personal Agent trees must not be packaged by a broad source glob');
  assert.ok(!packagedFiles.includes('skills/**/*'), 'Personal skills must not be packaged by a broad source glob');

});

test("desktop workers receive the display-stream values the launch handed them", async () => {
  // The desktop launcher builds its own environment rather than inheriting
  // one, so a value the launch computed reaches the child only if this merge
  // carries it. Asserted here because the packaged app is the only place this
  // launcher runs, and a silent drop would leave Team streaming working in
  // development and dead in the shipped product.
  const appRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "electron-task-launcher-stream-"),
  );
  const projectRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "electron-task-project-stream-"),
  );
  const runnerEntry = resolveDesktopSessionTaskRunnerPath(appRootPath);
  fs.mkdirSync(path.dirname(runnerEntry), { recursive: true });
  fs.writeFileSync(runnerEntry, "// compiled deterministic worker\n");

  let spawnCall: { options: Parameters<DesktopSpawnProcess>[2] } | undefined;
  const spawnProcess: DesktopSpawnProcess = (_command, _args, options) => {
    spawnCall = { options };
    const emitter = new EventEmitter();
    const child = {
      pid: 5150,
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return child;
      },
      unref() {},
    } as ReturnType<DesktopSpawnProcess>;
    queueMicrotask(() => emitter.emit("spawn"));
    return child;
  };

  try {
    const launcher = new ElectronSessionTaskLauncher(
      appRootPath,
      projectRootPath,
      "/Applications/Pipeline.app/Contents/MacOS/Pipeline",
      spawnProcess,
    );
    await launcher.startRun({
      cwd: appRootPath,
      env: {
        TEAM_RUNTIME_SESSION_ID: "session-1",
        TEAM_RUNTIME_TASK_ID: "task-1",
        TEAM_RUNTIME_WORKFLOW_ID: "workflow-1",
        [AGENT_TEXT_STREAM_URL_ENV]:
          "http://127.0.0.1:4321/internal/agent-text-stream",
        [AGENT_TEXT_STREAM_CHANNEL_ENV]:
          "11111111-2222-4333-8444-555555555555",
        [AGENT_TEXT_STREAM_TOKEN_ENV]: "a-working-credential",
      },
      processIdentity: "desktop-process-identity",
    });

    assert.equal(
      spawnCall?.options.env?.[AGENT_TEXT_STREAM_URL_ENV],
      "http://127.0.0.1:4321/internal/agent-text-stream",
    );
    assert.equal(
      spawnCall?.options.env?.[AGENT_TEXT_STREAM_CHANNEL_ENV],
      "11111111-2222-4333-8444-555555555555",
    );
    assert.equal(
      spawnCall?.options.env?.[AGENT_TEXT_STREAM_TOKEN_ENV],
      "a-working-credential",
    );
  } finally {
    fs.rmSync(appRootPath, { recursive: true, force: true });
    fs.rmSync(projectRootPath, { recursive: true, force: true });
  }
});
