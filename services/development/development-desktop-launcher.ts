import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

import {
  canonicalDevelopmentRepositoryRoot,
  DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV,
  DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE,
  DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV,
} from "./development-desktop-restart.js";

const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_RETRY_TIMEOUT_MS = 15_000;

export interface DevelopmentDesktopLaunchOptions {
  appArguments?: readonly string[];
  electronCliPath: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  forwardSignals?: boolean;
  onChildSpawn?: (child: ChildProcess) => void;
  onReplacementWait?: (status: {
    attempts: number;
    elapsedMs: number;
    timeoutMs: number;
  }) => void;
  replaceExisting?: boolean;
  repositoryRoot: string;
  retryDelayMs?: number;
  retryTimeoutMs?: number;
  stdio?: StdioOptions;
}

export interface DevelopmentDesktopLaunchResult {
  attempts: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class DevelopmentDesktopReplacementTimeoutError extends Error {
  constructor(
    readonly repositoryRoot: string,
    readonly attempts: number,
    readonly timeoutMs: number,
  ) {
    super(
      `Could not replace the development desktop for ${repositoryRoot} within ${timeoutMs}ms after ${attempts} launch attempts. ` +
        "The running desktop may belong to another worktree or may predate restart support. Quit that desktop once, then rerun the command.",
    );
    this.name = "DevelopmentDesktopReplacementTimeoutError";
  }
}

export async function launchDevelopmentDesktop(
  options: DevelopmentDesktopLaunchOptions,
): Promise<DevelopmentDesktopLaunchResult> {
  const repositoryRoot = canonicalDevelopmentRepositoryRoot(
    options.repositoryRoot,
  );
  const replaceExisting = options.replaceExisting ?? true;
  const retryDelayMs = requireNonNegativeFinite(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
  );
  const retryTimeoutMs = requireNonNegativeFinite(
    options.retryTimeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS,
    "retryTimeoutMs",
  );
  const startedAt = Date.now();
  let attempts = 0;

  while (true) {
    attempts += 1;
    const child = spawn(
      options.executablePath ?? process.execPath,
      [options.electronCliPath, ...(options.appArguments ?? ["."])],
      {
        cwd: repositoryRoot,
        env: buildLaunchEnvironment(
          options.environment ?? process.env,
          repositoryRoot,
          replaceExisting,
        ),
        stdio: options.stdio ?? "inherit",
      },
    );
    options.onChildSpawn?.(child);
    const result = await waitForChild(child, options.forwardSignals ?? false);

    if (
      !replaceExisting ||
      result.signal ||
      result.code !== DEVELOPMENT_DESKTOP_RESTART_EXIT_CODE
    ) {
      return { ...result, attempts };
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= retryTimeoutMs) {
      throw new DevelopmentDesktopReplacementTimeoutError(
        repositoryRoot,
        attempts,
        retryTimeoutMs,
      );
    }

    options.onReplacementWait?.({
      attempts,
      elapsedMs,
      timeoutMs: retryTimeoutMs,
    });
    await delay(Math.min(retryDelayMs, retryTimeoutMs - elapsedMs));
  }
}

function buildLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  repositoryRoot: string,
  replaceExisting: boolean,
): NodeJS.ProcessEnv {
  const environment = { ...base };
  if (replaceExisting) {
    environment[DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV] = "1";
    environment[DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV] = repositoryRoot;
  } else {
    delete environment[DEVELOPMENT_DESKTOP_RESTART_ENABLED_ENV];
    delete environment[DEVELOPMENT_DESKTOP_RESTART_ROOT_ENV];
  }
  return environment;
}

function waitForChild(
  child: ChildProcess,
  forwardSignals: boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };

    if (forwardSignals) {
      for (const signal of forwardedSignals) {
        const handler = () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
          }
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    }

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

function requireNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
