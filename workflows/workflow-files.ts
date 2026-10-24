/**
 * The file helpers that the workflow state store and the artifact receipts
 * module share: the cross-process workflow file lock and its default timeout
 * and retry interval, JSON reads with the store's error messages, atomic JSON
 * writes, the JSON deep copy, and the streaming SHA-256 file hash.
 *
 * workflows/workflow-state-store.ts and workflows/workflow-artifact-receipts.ts
 * both import this file, and it imports neither of them. Each caller passes its
 * own lock path and lock options; nothing here chooses a path.
 */

import * as crypto from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  acquireProcessFileLock,
  crossProcessFileLockAdapter,
  ProcessFileLockError,
  type CrossProcessFileLockRecord,
} from "../core/cross-process-file-lock.js";
import { writeFileAtomic } from "../core/file-mutation.js";
import { WorkflowStateStoreError } from "./workflow-state-errors.js";

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCK_RETRY_MS = 10;

export async function hashFile(artifactPath: string): Promise<{
  sha256: string;
  byteLength: number;
}> {
  const hash = crypto.createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(artifactPath)) {
    const bytes = chunk as Buffer;
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), byteLength };
}

export interface FileLockOptions {
  processId: number;
  isProcessAlive: (pid: number) => boolean;
  timeoutMs: number;
  retryMs: number;
}

export async function readJsonFile(
  filePath: string,
  label: string,
): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkflowStateStoreError("corrupt", `Could not read ${label}.`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new WorkflowStateStoreError(
      "corrupt",
      `Could not parse ${label} as JSON.`,
      { cause: error },
    );
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function withWorkflowFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireWorkflowFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function acquireWorkflowFileLock(
  lockPath: string,
  options: FileLockOptions,
) {
  const record: CrossProcessFileLockRecord = {
    pid: options.processId,
    nonce: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    return await acquireProcessFileLock({
      lockPath,
      record,
      adapter: crossProcessFileLockAdapter,
      timeoutMs: options.timeoutMs,
      retryMs: options.retryMs,
      waitDescription: "workflow lock",
      corruptBehavior: "wait",
      isProcessAlive: options.isProcessAlive,
    });
  } catch (error) {
    if (error instanceof ProcessFileLockError) {
      throw new WorkflowStateStoreError(
        "lock_timeout",
        `Timed out waiting for workflow lock '${path.basename(lockPath)}'.`,
        { cause: error },
      );
    }
    throw error;
  }
}
