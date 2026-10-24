/**
 * Find and stop processes a finished test run left behind.
 *
 * Tracking a spawned process and killing it in a `finally` block is the first
 * line of cleanup, and it is not sufficient on its own. A durable task host is
 * launched detached and unref'd because the product requires a run to survive
 * the API server restarting, so it also survives the test that started it and
 * cannot be reached by killing a process tree. A `finally` block does not run at
 * all when the test file process is killed outright, and nothing tracks a
 * grandchild the test never received a handle for.
 *
 * The one handle that reaches all of them is the environment: every descendant
 * inherits it. The runner stamps a unique id into the environment of everything
 * it spawns, then asks the process table who still carries that id.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Stamped into the environment of every process a test run spawns. */
export const TEST_RUN_ID_ENV = "PIPELINE_TEST_RUN_ID";

/** How long a survivor is given to honour SIGTERM before SIGKILL. */
const terminateGraceMs = 2_000;
const terminatePollMs = 50;

/**
 * `ps` prints the environment inline, so a process table row is large. The
 * default 1MB buffer truncates the table on a busy machine, which would silently
 * hide survivors rather than fail.
 */
const processTableBufferBytes = 64 * 1024 * 1024;

export interface ProcessTableEntry {
  readonly pid: number;
  /** The command and environment as one line, which is what carries the id. */
  readonly line: string;
}

export interface ReapResult {
  /** Survivors that stopped on SIGTERM. */
  readonly terminated: number[];
  /** Survivors that had to be SIGKILLed. */
  readonly killed: number[];
  /** Set when the process table could not be read, so a caller can report it. */
  readonly failure?: string;
}

/**
 * The runner's pid is part of the id so a later run can tell an abandoned run's
 * survivors from a concurrent run's. A uuid alone cannot answer that question.
 */
export function createTestRunId(runnerPid = process.pid): string {
  return `pipeline-test-${String(runnerPid)}-${randomUUID()}`;
}

/** The pid of the runner that owns a run id, or null if the id is not ours. */
export function readRunOwnerPid(runId: string): number | null {
  const match = /^pipeline-test-(\d+)-/u.exec(runId);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The run id stamped into a process table line, or null when it carries none. */
export function readRunId(line: string): string | null {
  const match = new RegExp(`${TEST_RUN_ID_ENV}=(\\S+)`, "u").exec(line);
  return match?.[1] ?? null;
}

/**
 * Survivors of a run that can no longer clean up after itself.
 *
 * A run killed outright never reaches its own sweep. Its survivors are only
 * collectable by a later run, which must not touch a run that is still going —
 * the normal case when several worktrees run tests at once. An owner process
 * that is gone settles it.
 */
export function findAbandonedSurvivors(params: {
  readonly processTable: readonly ProcessTableEntry[];
  readonly currentRunId: string;
  readonly isAlive?: (pid: number) => boolean;
  readonly ancestorPids?: readonly number[];
}): number[] {
  const isAlive = params.isAlive ?? isProcessAlive;
  const excluded = new Set([
    process.pid,
    ...(params.ancestorPids ?? readAncestorPids()),
  ]);
  const abandoned: number[] = [];
  for (const entry of params.processTable) {
    if (excluded.has(entry.pid)) continue;
    const runId = readRunId(entry.line);
    if (runId === null || runId === params.currentRunId) continue;
    const ownerPid = readRunOwnerPid(runId);
    if (ownerPid === null || isAlive(ownerPid)) continue;
    abandoned.push(entry.pid);
  }
  return abandoned;
}

export function parseProcessTable(output: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ pid, line: match[2] ?? "" });
  }
  return entries;
}

export function findSurvivors(params: {
  readonly runId: string;
  readonly processTable: readonly ProcessTableEntry[];
  readonly excludePids?: readonly number[];
}): number[] {
  const excluded = new Set(params.excludePids ?? []);
  return params.processTable
    .filter((entry) => !excluded.has(entry.pid))
    .filter((entry) => entry.line.includes(params.runId))
    .map((entry) => entry.pid);
}

/** Read the process table with the environment included. */
export function readProcessTable(): string {
  // `-A` every process, `-E` with its environment, `-ww` without truncating the
  // line. Linux spells the environment flag as the BSD-style `e` operand.
  const args =
    process.platform === "linux"
      ? ["axeww", "-o", "pid=,command="]
      : ["-A", "-E", "-ww", "-o", "pid=,command="];
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    maxBuffer: processTableBufferBytes,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `ps exited with status ${String(result.status)}: ${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * The reaper's own ancestry, which must never be signalled.
 *
 * `ps` prints the command line and the environment as one line, and nothing in
 * it says where one ends and the other begins. A shell invoked as
 * `PIPELINE_TEST_RUN_ID=... npm run test:reap` therefore carries the id in its
 * command, matches like a survivor, and is the reaper's own parent. Excluding
 * the ancestry is what makes that safe; it costs nothing when there is no match.
 */
export function parseParentMap(output: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const rawLine of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(rawLine);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    parents.set(pid, ppid);
  }
  return parents;
}

export function collectAncestors(
  pid: number,
  parents: ReadonlyMap<number, number>,
): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>([pid]);
  let current = parents.get(pid);
  // `seen` also terminates a parent map that is inconsistent because processes
  // exited while it was being read.
  while (current !== undefined && current > 0 && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = parents.get(current);
  }
  return ancestors;
}

export function readAncestorPids(pid: number = process.pid): number[] {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: processTableBufferBytes,
  });
  if (result.error || result.status !== 0) return [];
  return collectAncestors(pid, parseParentMap(result.stdout ?? ""));
}

/** The state column `ps` reports for a process, or null when it has none. */
export function readProcessState(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  const state = (result.stdout ?? "").trim();
  return state === "" ? null : state;
}

/**
 * Whether a process state describes a process that is still running.
 *
 * `Z` is a process that has already exited and is only waiting for its parent
 * to collect it. It answers a signal probe like a live process, which would make
 * the reaper report a survivor it had just stopped as one it could not stop.
 */
export function isRunningState(state: string | null): boolean {
  if (state === null || state === "") return false;
  return !state.startsWith("Z");
}

export function isProcessAlive(
  pid: number,
  readState: (pid: number) => string | null = readProcessState,
): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return isRunningState(readState(pid));
}

export async function reapSurvivors(params: {
  readonly runId: string;
  readonly excludePids?: readonly number[];
  readonly readProcessTable?: () => string;
  readonly readAncestors?: () => readonly number[];
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly graceMs?: number;
}): Promise<ReapResult> {
  const readTable = params.readProcessTable ?? readProcessTable;
  const kill = params.kill ?? defaultKill;
  const isAlive = params.isAlive ?? isProcessAlive;
  const delay = params.delay ?? defaultDelay;
  const graceMs = params.graceMs ?? terminateGraceMs;

  let table: string;
  try {
    table = readTable();
  } catch (error) {
    // A reaper that throws would replace a real test result with its own
    // failure. Report and let the caller decide.
    return { terminated: [], killed: [], failure: String(error) };
  }

  const readAncestors = params.readAncestors ?? readAncestorPids;
  const survivors = findSurvivors({
    runId: params.runId,
    processTable: parseProcessTable(table),
    excludePids: [
      process.pid,
      ...readAncestors(),
      ...(params.excludePids ?? []),
    ],
  });
  if (survivors.length === 0) return { terminated: [], killed: [] };

  for (const pid of survivors) kill(pid, "SIGTERM");

  const deadline = graceMs;
  let waited = 0;
  let remaining = survivors.filter((pid) => isAlive(pid));
  while (remaining.length > 0 && waited < deadline) {
    await delay(terminatePollMs);
    waited += terminatePollMs;
    remaining = remaining.filter((pid) => isAlive(pid));
  }

  for (const pid of remaining) kill(pid, "SIGKILL");

  const killedSet = new Set(remaining);
  return {
    terminated: survivors.filter((pid) => !killedSet.has(pid)),
    killed: remaining,
  };
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The survivor exited between the process table read and the signal.
  }
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
