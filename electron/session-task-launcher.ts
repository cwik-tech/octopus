import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  launchDetachedProcess,
  type DetachedProcess,
  type RunLauncher,
  type SpawnDetachedProcess,
  toDetachedProcess,
} from "../domains/run/run-launcher.js";
import type {
  RunLaunchResult,
  RunStartRequest,
} from "../domains/run/run-store.js";
import { PROCESS_IDENTITY_ARGUMENT } from "../domains/sessions/session-task-launcher.js";
import { CONFIGURED_PROVIDER_BROKER_URL_ENV } from "../domains/provider/provider-settings.js";
import { configuredProviderBrokerIdentity } from "../domains/sessions/provider-broker-identity.js";
import { requireDesktopHeadlessNodePath } from "./headless-node-runtime.js";

export type DesktopSpawnProcess = SpawnDetachedProcess;

export interface DesktopAppRootOptions {
  appRootOverride?: string;
  isPackaged: boolean;
  moduleUrl: string;
  resourcesPath: string;
}

const defaultSpawnProcess: DesktopSpawnProcess = (command, args, options) =>
  toDetachedProcess(spawn(command, [...args], options));

function requireDesktopSessionTaskRunnerPath(appRootPath: string): string {
  const runnerEntry = resolveDesktopSessionTaskRunnerPath(appRootPath);
  if (!existsSync(runnerEntry)) {
    throw new Error(`Desktop session task runner is missing: ${runnerEntry}`);
  }
  return runnerEntry;
}

function buildSessionTaskSpawnOptions(
  request: RunStartRequest,
  projectRootPath: string,
  runtimeEnvironment: Record<string, string>,
): SpawnOptions {
  return {
    cwd: projectRootPath,
    env: {
      ...process.env,
      ...request.env,
      ...runtimeEnvironment,
      ELECTRON_RUN_AS_NODE: "1",
      TEAM_RUNTIME_REPO_ROOT: projectRootPath,
      TEAM_RUNTIME_START_SERVICES: "0",
    },
    detached: true,
    stdio: "ignore",
  };
}

export function resolveDesktopAppRootPath(
  options: DesktopAppRootOptions,
): string {
  if (options.appRootOverride) {
    return path.resolve(options.appRootOverride);
  }

  if (options.isPackaged) {
    // electron-builder uses `asar: false`, so packaged application files live
    // under Resources/app rather than inside app.asar.
    return path.join(path.resolve(options.resourcesPath), "app");
  }

  // Development executes dist-electron/electron/main.js from the repository.
  return path.resolve(
    path.dirname(fileURLToPath(options.moduleUrl)),
    "..",
    "..",
  );
}

export function resolveDesktopSessionTaskRunnerPath(
  appRootPath: string,
): string {
  return path.join(
    appRootPath,
    "dist-electron",
    "domains",
    "sessions",
    "session-task-runner.js",
  );
}

export class ElectronSessionTaskLauncher implements RunLauncher {
  private runtimeEnvironmentProvider: () => Promise<Record<string, string>> =
    async () => ({});

  constructor(
    private readonly appRootPath: string,
    private readonly projectRootPath: string,
    private readonly executablePath = requireDesktopHeadlessNodePath(
      process.execPath,
    ),
    private readonly spawnProcess = defaultSpawnProcess,
  ) {}

  setRuntimeEnvironmentProvider(
    provider: () => Promise<Record<string, string>>,
  ): void {
    this.runtimeEnvironmentProvider = provider;
  }

  async startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    const runnerEntry = requireDesktopSessionTaskRunnerPath(this.appRootPath);
    const identityArguments = request.processIdentity
      ? [`${PROCESS_IDENTITY_ARGUMENT}${request.processIdentity}`]
      : [];
    const runtimeEnvironment = await this.runtimeEnvironmentProvider();
    const brokerIdentity = configuredProviderBrokerIdentity(
      runtimeEnvironment[CONFIGURED_PROVIDER_BROKER_URL_ENV],
    );
    const pid = await launchDetachedProcess({
      command: this.executablePath,
      args: [runnerEntry, ...identityArguments],
      options: buildSessionTaskSpawnOptions(
        request,
        this.projectRootPath,
        runtimeEnvironment,
      ),
      spawnProcess: this.spawnProcess,
    });

    return {
      launched: true,
      pid,
      processGroupId: pid,
      ...(brokerIdentity
        ? { configuredProviderBrokerIdentity: brokerIdentity }
        : {}),
      ...(request.processIdentity
        ? { processIdentity: request.processIdentity }
        : {}),
      cwd: this.projectRootPath,
    };
  }
}
