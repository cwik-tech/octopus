import { whenDefined } from "./optional-properties.js"
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import {
  ownedProcessHostEnvironment,
  ownedProcessHostInvocation,
  prepareOwnedProcess,
} from "./owned-processes/owned-process-spawn.js";
import { OWNED_PROCESS_SCOPE_ENV } from "./owned-processes/owned-process-records.js";

export interface FileParserLauncher {
  parseDirectory(
    inputDir: string,
    options?: FileParserRequestOptions,
  ): Promise<void>;
  /**
   * Parse exactly one file into `outputDir`, writing nothing beside the file. A local-only parse
   * never reaches an outside model, whatever this process's environment says.
   */
  parseFile(
    input: FileParseRequest,
    options?: FileParserRequestOptions,
  ): Promise<void>;
}

export interface FileParseRequest {
  filePath: string;
  outputDir: string;
  localOnly: boolean;
}

export interface FileParserRequestOptions {
  signal?: AbortSignal;
}

export type SpawnFileParserProcess = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface FileParserProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: SpawnFileParserProcess;
  signal?: AbortSignal;
  timeoutMs?: number;
  terminationGraceMs?: number;
}

export const TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV =
  "TEAM_RUNTIME_FILE_PARSER_ENTRY";
export const TEAM_RUNTIME_REPO_ROOT_ENV = "TEAM_RUNTIME_REPO_ROOT";

const MAX_ERROR_OUTPUT_BYTES = 8 * 1024;
const DEFAULT_PARSER_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export async function runFileParserProcess(
  options: FileParserProcessOptions,
): Promise<void> {
  throwIfAborted(options.signal);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    spawn(command, [...args], spawnOptions));
  const timeoutMs = positiveDuration(
    options.timeoutMs,
    DEFAULT_PARSER_TIMEOUT_MS,
    "timeoutMs",
  );
  const terminationGraceMs = positiveDuration(
    options.terminationGraceMs,
    DEFAULT_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );

  // Under an ownership scope the parser is recorded before it exists and
  // started through its host, like a Team child, so a closer can find and
  // stop it (docs/adr/2026-09-28-Delegated-Child-Outlives-Terminated-Task.md,
  // sections 2 to 4). Without a scope, and on Windows, nothing changes.
  // Awaited only under a scope, so a spawn without one stays synchronous.
  const env = options.env ?? { ...process.env };
  const owned = env[OWNED_PROCESS_SCOPE_ENV]?.trim()
    ? await prepareOwnedProcess({
        environment: env,
        kind: "file-parser",
        childRunId: null,
        spawnerRunId: env.TEAM_ROOT_SESSION_ID?.trim() || null,
        spawnerAssignmentId: env.TEAM_SESSION_ID?.trim() || null,
      })
    : undefined;
  const spawnCommand = owned
    ? ownedProcessHostInvocation({
        ownedProcessId: owned.ownedProcessId,
        command: options.command,
        args: options.args,
      })
    : { command: options.command, args: options.args };

  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(spawnCommand.command, spawnCommand.args, {
      cwd: options.cwd,
      env: owned ? { ...env, ...ownedProcessHostEnvironment(owned) } : env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let terminationError: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      requestTermination(
        new Error(`File parser timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    timeoutTimer.unref?.();

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminationWatchdogTimer) clearTimeout(terminationWatchdogTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settleRejected = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const requestTermination = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      signalParserProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalParserProcess(child, "SIGKILL");
        terminationWatchdogTimer = setTimeout(() => {
          settleRejected(
            new Error(
              `${terminationError?.message ?? "File parser termination failed"}; ` +
                "child did not exit after SIGKILL",
            ),
          );
        }, terminationGraceMs);
        terminationWatchdogTimer.unref?.();
      }, terminationGraceMs);
      forceKillTimer.unref?.();
    };
    const onAbort = () => {
      requestTermination(abortError(options.signal));
    };

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length >= MAX_ERROR_OUTPUT_BYTES) return;
      stderr += String(chunk).slice(0, MAX_ERROR_OUTPUT_BYTES - stderr.length);
    });

    child.once("error", (error) => {
      settleRejected(
        new Error(
          `Failed to start file parser: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationError) {
        reject(terminationError);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const reason =
        code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
      const detail = stderr.trim();
      reject(
        new Error(
          `File parser failed with ${reason}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive duration in milliseconds`);
  }
  return value;
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("File parser was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function signalParserProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the timeout and signal delivery.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Exit/error listeners settle the process promise.
  }
}

/** The parser's arguments for one file: absolute paths, and the local-only flag when asked. */
export function singleFileParserArgs(input: FileParseRequest): string[] {
  return [
    "--file",
    path.resolve(input.filePath),
    "--output",
    path.resolve(input.outputDir),
    ...(input.localOnly ? ["--local-only"] : []),
  ];
}

const FILE_PARSER_LOCAL_ONLY_ENV = "FILE_PARSER_LOCAL_ONLY";

/**
 * Every variable that can turn the parser's enrichment on, pick its provider or model, carry its
 * API key or name its endpoint (`file-parser/lm/llm-model.ts`).
 */
const FILE_PARSER_ENRICHMENT_ENV = new Set([
  "FILE_PARSER_LLM_ENABLED",
  "FILE_PARSER_LM_ENABLED",
  "FILE_PARSER_LLM_PROVIDER",
  "FILE_PARSER_LM_PROVIDER",
  "FILE_PARSER_LLM_MODEL",
  "FILE_PARSER_LM_MODEL",
  "FILE_PARSER_OPENAI_API_KEY",
  "FILE_PARSER_OPENAI_BASE_URL",
  "OPENAI_API_KEY",
]);

/**
 * The environment a parse starts with. A local-only parse loses every enrichment variable and
 * gains `FILE_PARSER_LOCAL_ONLY=1`, which the parser obeys over anything else it is given. OCR's
 * settings and the rest of the environment are kept: recognition runs locally.
 */
export function fileParserEnvironment(
  base: NodeJS.ProcessEnv,
  localOnly: boolean,
): NodeJS.ProcessEnv {
  if (!localOnly) return { ...base };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // Upper-cased because Windows matches variable names without regard to case.
    if (FILE_PARSER_ENRICHMENT_ENV.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  env[FILE_PARSER_LOCAL_ONLY_ENV] = "1";
  return env;
}

export function resolveSourceFileParserEntry(repoRootPath: string): string {
  return path.join(path.resolve(repoRootPath), "file-parser", "index.ts");
}

export interface RuntimeFileParserLauncherOptions {
  env?: NodeJS.ProcessEnv;
  defaultRepoRootPath?: string;
  spawnProcess?: SpawnFileParserProcess;
  timeoutMs?: number;
  terminationGraceMs?: number;
}

export function resolveRuntimeFileParserLauncher(
  options: RuntimeFileParserLauncherOptions = {},
): FileParserLauncher {
  const env = options.env ?? process.env;
  const configuredEntry = env[TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV]?.trim();
  const processOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: options.terminationGraceMs }),
  };
  if (configuredEntry) {
    requireParserEntry(configuredEntry);
    return new ConfiguredFileParserLauncher(
      configuredEntry,
      options.spawnProcess,
      processOptions,
    );
  }

  const repoRootPath =
    env[TEAM_RUNTIME_REPO_ROOT_ENV]?.trim() || options.defaultRepoRootPath;
  if (!repoRootPath) {
    throw new Error(
      `File parser is not configured; set ${TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV} or ${TEAM_RUNTIME_REPO_ROOT_ENV}`,
    );
  }
  requireParserEntry(resolveSourceFileParserEntry(repoRootPath));
  return new SourceFileParserLauncher(
    repoRootPath,
    options.spawnProcess,
    processOptions,
  );
}

export class ConfiguredFileParserLauncher implements FileParserLauncher {
  private readonly parserEntry: string;

  constructor(
    parserEntry: string,
    private readonly spawnProcess?: SpawnFileParserProcess,
    private readonly processOptions: Pick<
      FileParserProcessOptions,
      "timeoutMs" | "terminationGraceMs"
    > = {},
  ) {
    this.parserEntry = path.resolve(parserEntry);
  }

  async parseDirectory(
    inputDir: string,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.runParser([path.resolve(inputDir)], false, options);
  }

  async parseFile(
    input: FileParseRequest,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.runParser(singleFileParserArgs(input), input.localOnly, options);
  }

  private async runParser(
    parserArgs: readonly string[],
    localOnly: boolean,
    options: FileParserRequestOptions,
  ): Promise<void> {
    requireParserEntry(this.parserEntry);
    await runFileParserProcess({
      command: process.execPath,
      args: [this.parserEntry, ...parserArgs],
      cwd: path.dirname(this.parserEntry),
      env: {
        ...fileParserEnvironment(process.env, localOnly),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      ...whenDefined(this.spawnProcess, (definedValue) => ({ spawnProcess: definedValue })),
      ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
      ...this.processOptions,
    });
  }
}

export class SourceFileParserLauncher implements FileParserLauncher {
  constructor(
    private readonly repoRootPath: string,
    private readonly spawnProcess?: SpawnFileParserProcess,
    private readonly processOptions: Pick<
      FileParserProcessOptions,
      "timeoutMs" | "terminationGraceMs"
    > = {},
  ) {}

  async parseDirectory(
    inputDir: string,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.runParser([path.resolve(inputDir)], false, options);
  }

  async parseFile(
    input: FileParseRequest,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.runParser(singleFileParserArgs(input), input.localOnly, options);
  }

  private async runParser(
    parserArgs: readonly string[],
    localOnly: boolean,
    options: FileParserRequestOptions,
  ): Promise<void> {
    const parserEntry = resolveSourceFileParserEntry(this.repoRootPath);
    if (!existsSync(parserEntry)) {
      throw new Error(`File parser entry is missing: ${parserEntry}`);
    }
    const tsxEntry = createRequire(import.meta.url).resolve("tsx/cli");
    await runFileParserProcess({
      command: process.execPath,
      args: [tsxEntry, parserEntry, ...parserArgs],
      cwd: path.join(path.resolve(this.repoRootPath), "file-parser"),
      env: {
        ...fileParserEnvironment(process.env, localOnly),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      ...whenDefined(this.spawnProcess, (definedValue) => ({ spawnProcess: definedValue })),
      ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
      ...this.processOptions,
    });
  }
}

function requireParserEntry(filePath: string): void {
  try {
    if (statSync(path.resolve(filePath)).isFile()) return;
  } catch {
    // Throw the stable configuration error below.
  }
  throw new Error(`File parser entry is missing: ${path.resolve(filePath)}`);
}
