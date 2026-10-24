import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type PersistedCreateJobStatus = "running" | "cancelled";

export interface PersistedCreateJob {
  jobId: string;
  status: PersistedCreateJobStatus;
  updatedAt: number;
}

export interface PersistedPendingCancellation {
  expiresAt: number;
  jobId: string;
}

export interface PersistedCreateJobState {
  activeJobs: PersistedCreateJob[];
  pendingCancellations: PersistedPendingCancellation[];
  version: 1;
}

export interface CreateJobStateStore {
  read(): PersistedCreateJobState;
  write(state: PersistedCreateJobState): void;
}

const STATE_VERSION = 1;
const EMPTY_STATE: PersistedCreateJobState = {
  activeJobs: [],
  pendingCancellations: [],
  version: STATE_VERSION,
};

export class FileSystemCreateJobStateStore implements CreateJobStateStore {
  private readonly statePath: string;

  constructor(workspacePath: string) {
    this.statePath = path.join(
      path.resolve(workspacePath),
      "create-jobs",
      "state.json",
    );
  }

  read(): PersistedCreateJobState {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      return parsePersistedState(parsed, this.statePath);
    } catch (error) {
      if (isFileNotFound(error)) return EMPTY_STATE;
      throw error;
    }
  }

  write(state: PersistedCreateJobState): void {
    writeJsonAtomically(this.statePath, state);
  }
}

function parsePersistedState(
  value: unknown,
  statePath: string,
): PersistedCreateJobState {
  if (!isRecord(value) || value.version !== STATE_VERSION) {
    throw invalidStateError(statePath);
  }
  if (
    !Array.isArray(value.activeJobs) ||
    !Array.isArray(value.pendingCancellations)
  ) {
    throw invalidStateError(statePath);
  }

  const activeJobs = value.activeJobs.map((job) =>
    parsePersistedJob(job, statePath),
  );
  const pendingCancellations = value.pendingCancellations.map((pending) =>
    parsePendingCancellation(pending, statePath),
  );
  return { activeJobs, pendingCancellations, version: STATE_VERSION };
}

function parsePersistedJob(
  value: unknown,
  statePath: string,
): PersistedCreateJob {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    (value.status !== "running" && value.status !== "cancelled") ||
    !isFiniteTimestamp(value.updatedAt)
  ) {
    throw invalidStateError(statePath);
  }
  return {
    jobId: value.jobId,
    status: value.status,
    updatedAt: value.updatedAt,
  };
}

function parsePendingCancellation(
  value: unknown,
  statePath: string,
): PersistedPendingCancellation {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    !isFiniteTimestamp(value.expiresAt)
  ) {
    throw invalidStateError(statePath);
  }
  return { expiresAt: value.expiresAt, jobId: value.jobId };
}

function writeJsonAtomically(
  filePath: string,
  value: PersistedCreateJobState,
): void {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { mode: 0o700, recursive: true });
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    writeTemporaryStateFile(temporaryPath, value);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function writeTemporaryStateFile(
  filePath: string,
  value: PersistedCreateJobState,
): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalidStateError(statePath: string): Error {
  return new Error(`Invalid Create job registry state: ${statePath}`);
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
