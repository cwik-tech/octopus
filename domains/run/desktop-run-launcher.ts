/**
 * The desktop app's Team host launch.
 *
 * Extracted from `electron/main.ts` so it can be exercised without importing
 * Electron: the file it came from pulls in the whole desktop runtime, which no
 * test can load. It takes the one capability it actually needs — somewhere to
 * ask for the provider environment — rather than the whole settings service.
 */
import * as path from "node:path";

import { RUNTIME_EXTENSION_ENTRY_ENV } from "../../core/pi-runtime.js";
import type { RunLaunchResult, RunStartRequest } from "../../contracts/runs.js";
import {
  launchTeamHostRun,
  type RunLauncher,
  type SpawnDetachedProcess,
} from "./run-launcher.js";

/** The one capability the desktop launcher needs from provider settings. */
export interface RuntimeEnvironmentSource {
  runtimeEnvironment(): Promise<NodeJS.ProcessEnv>;
}

export class DesktopRunLauncher implements RunLauncher {
  constructor(
    private readonly repoRootPath: string,
    private readonly providerSettings: RuntimeEnvironmentSource,
    /** Injected only so a test can observe the environment a child receives. */
    private readonly spawnProcess?: SpawnDetachedProcess,
  ) {}

  async startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    const entryPath =
      process.env[RUNTIME_EXTENSION_ENTRY_ENV] ??
      path.join(this.repoRootPath, "team-runtime", "index.ts");
    const providerEnvironment = await this.providerSettings.runtimeEnvironment();
    const env = {
      ...process.env,
      ...request.env,
      ...providerEnvironment,
      TEAM_RUNTIME_START_SERVICES: "0",
    };
    // The same shared Team-host launch every other path uses, so the isolation
    // that keeps a handover out of the user's Pi settings is decided in one
    // place. It is applied after this environment, which is what stops an
    // agent directory named here — or by the provider settings composed into
    // it — from reaching the host.
    return launchTeamHostRun({
      extensionEntryPath: entryPath,
      cwd: request.cwd,
      environment: env,
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
    });
  }
}
