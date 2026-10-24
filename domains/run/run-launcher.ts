import * as path from "node:path";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RunLaunchResult, RunStartRequest } from "./run-store.js";
import {
  buildPiInvocation,
  RUNTIME_EXTENSION_ENTRY_ENV,
  TEAM_HOST_RUN_PROMPT,
} from "../../core/pi-runtime.js";
import {
  isolatePiAgentDirectory,
  type IsolatedPiAgentDirectory,
} from "./pi-agent-isolation.js";

export interface RunLauncher {
  startRun(request: RunStartRequest): Promise<RunLaunchResult>;
}

export interface DetachedProcess {
  readonly pid: number | undefined;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "spawn", listener: () => void): this;
  /** The child has ended. A detached launch has no other moment to clean up. */
  once(event: "close", listener: () => void): this;
  unref(): void;
}

export type SpawnDetachedProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => DetachedProcess;

const defaultSpawnDetachedProcess: SpawnDetachedProcess = (
  command,
  args,
  options,
) => toDetachedProcess(spawn(command, [...args], options));

export function toDetachedProcess(child: ChildProcess): DetachedProcess {
  return {
    get pid() {
      return child.pid ?? undefined;
    },
    once(event, listener) {
      child.once(event, listener);
      return this;
    },
    unref() {
      child.unref();
    },
  };
}

export async function launchDetachedProcess(params: {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  spawnProcess?: SpawnDetachedProcess;
  /**
   * Release whatever the launch reserved for the child.
   *
   * Called once, on whichever of these happens: the spawn throws, the child
   * reports an error instead of starting, or the child ends. The callee is
   * expected to be idempotent; this only promises not to forget.
   */
  onRelease?: () => void;
}): Promise<number> {
  const release = params.onRelease ?? ((): void => {});
  let child: DetachedProcess;
  try {
    child = (params.spawnProcess ?? defaultSpawnDetachedProcess)(
      params.command,
      params.args,
      params.options,
    );
  } catch (error) {
    release();
    throw error;
  }

  // The child outlives this call, so its end is the only moment the parent can
  // observe. Registered before the promise settles so a fast child cannot end
  // before anyone is listening.
  child.once("close", () => release());

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      release();
      reject(
        new Error(`Failed to launch ${params.command}: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      if (!child.pid) {
        release();
        reject(
          new Error(
            `Failed to launch ${params.command}: child process did not expose a pid`,
          ),
        );
        return;
      }
      child.unref();
      resolve(child.pid);
    });
  });
}

/**
 * Start a detached Team host on its own Pi agent directory.
 *
 * Every Team host launch goes through here so the isolation is decided once.
 * The child owns the directory and deletes it at its own exit; this releases it
 * too, as a backstop for the launch that never started and for the run whose
 * child died without cleaning up.
 */
export async function launchTeamHostRun(params: {
  readonly extensionEntryPath: string;
  readonly cwd: string;
  /** Composed by the caller, so each launcher keeps its own precedence. */
  readonly environment: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnDetachedProcess;
  readonly isolateAgentDirectory?: () => IsolatedPiAgentDirectory;
}): Promise<RunLaunchResult> {
  const isolated = (params.isolateAgentDirectory ?? isolatePiAgentDirectory)();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    isolated.dispose();
  };

  try {
    // The prompt is what the host is alive for. Without one, Pi selects print
    // mode on the ignored stdio below and disposes the session as soon as the
    // extension has finished starting up, so the run's opening entry — queued,
    // never prompted — is thrown away with it.
    const invocation = buildPiInvocation(
      ["-e", params.extensionEntryPath, TEAM_HOST_RUN_PROMPT],
      {
        ...params.environment,
        // Last, so it overrides whatever the parent was using.
        ...isolated.environment,
      },
    );
    const pid = await launchDetachedProcess({
      command: invocation.command,
      args: invocation.args,
      options: {
        cwd: params.cwd,
        env: invocation.env,
        detached: true,
        stdio: "ignore",
      },
      ...(params.spawnProcess ? { spawnProcess: params.spawnProcess } : {}),
      onRelease: release,
    });

    return {
      launched: true,
      pid,
      processGroupId: pid,
      cwd: params.cwd,
    };
  } catch (error) {
    // A launch that never started must not leave a copy of the credentials
    // behind: this covers a failing invocation build as well as the spawn.
    release();
    throw error;
  }
}

export class PiRunLauncher implements RunLauncher {
  constructor(
    /** Injected only so a test can observe the environment a child receives. */
    private readonly spawnProcess?: SpawnDetachedProcess,
  ) {}

  async startRun(request: RunStartRequest): Promise<RunLaunchResult> {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const extensionEntry = process.env[RUNTIME_EXTENSION_ENTRY_ENV]
      ? path.resolve(process.env[RUNTIME_EXTENSION_ENTRY_ENV])
      : path.resolve(
          path.join(moduleDir, "..", "..", "team-runtime", "index.ts"),
        );
    return launchTeamHostRun({
      extensionEntryPath: extensionEntry,
      cwd: request.cwd,
      environment: {
        ...process.env,
        ...request.env,
        TEAM_RUNTIME_START_SERVICES: "0",
      },
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
    });
  }
}
