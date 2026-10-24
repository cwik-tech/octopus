import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import {
  isTerminalTaskStatus,
  isValidSessionId,
  type SessionTask,
  type TaskAdmission,
  type TaskStatus,
} from "./session-types.js";
import { requireSessionTaskRecord } from "./session-normalizers.js";
import {
  FileSystemWorkflowStateStore,
  terminalTaskStatusForWorkflow,
} from "../../workflows/workflow-state-store.js";
import type { DurableWorkflowTerminalOutcome } from "../../workflows/types.js";

export interface TaskRecordCompareAndSetResult {
  task: SessionTask;
  updated: boolean;
}

/** Patch fields may be explicitly cleared before the record is serialized. */
export type SessionTaskPatch = {
  [Key in keyof SessionTask]?: SessionTask[Key] | undefined;
};

export interface TaskRecordCompareAndSetOptions {
  /** A null expectation requires that no execution attempt has been reserved. */
  expectedExecutionAttemptId?: string | null;
  expectedAdmissionRequestId?: string | null;
  expectedAdmissionPhase?: TaskAdmission["phase"] | null;
  expectedAdmissionGrantId?: string | null;
  expectedAdmissionOwnerEpoch?: string | null;
}

export interface SessionTaskRepositoryPorts {
  sessionDir(sessionId: string): string;
  now(): Date;
  withTaskLock<T>(
    lockPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  verifyWorkflowOutcomeArtifacts(
    task: SessionTask,
    outcome: DurableWorkflowTerminalOutcome,
  ): Promise<unknown>;
  tryRepairTerminalTaskResult(task: SessionTask): Promise<void>;
  finalizeTerminalTask(sessionId: string, task: SessionTask): Promise<void>;
}

export class SessionTaskRepository {
  constructor(private readonly ports: SessionTaskRepositoryPorts) {}

  taskDir(sessionId: string, taskId: string): string {
    if (!isValidSessionId(sessionId) || !isValidSessionId(taskId)) {
      throw new Error("Invalid session or task id");
    }
    const sessionDir = this.ports.sessionDir(sessionId);
    const tasksDir = resolveRelativePathInside(sessionDir, "tasks");
    if (!tasksDir) throw new Error("Task path must stay inside the session");
    if (
      existsSync(tasksDir) &&
      !resolveExistingPathInside(sessionDir, tasksDir)
    ) {
      throw new Error("Task path must stay inside the session");
    }
    const taskDir = resolveRelativePathInside(tasksDir, taskId);
    if (!taskDir) throw new Error("Task path must stay inside the session");
    if (
      existsSync(taskDir) &&
      !resolveExistingPathInside(sessionDir, taskDir)
    ) {
      throw new Error("Task path must stay inside the session");
    }
    return taskDir;
  }

  taskLockPath(sessionId: string, taskId: string): string {
    return path.join(this.taskDir(sessionId, taskId), ".task.lock");
  }

  async readTaskRecord(
    sessionId: string,
    taskId: string,
  ): Promise<SessionTask | null> {
    if (!isValidSessionId(sessionId) || !isValidSessionId(taskId)) return null;
    const taskDir = this.taskDir(sessionId, taskId);
    const recordPath = path.join(taskDir, "task.json");
    if (
      existsSync(recordPath) &&
      !resolveExistingPathInside(taskDir, recordPath)
    ) {
      return null;
    }
    try {
      const raw = await fs.readFile(recordPath, "utf8");
      return JSON.parse(raw) as SessionTask;
    } catch {
      return null;
    }
  }

  async readTaskRecords(sessionId: string): Promise<SessionTask[]> {
    const tasksDir = path.join(this.ports.sessionDir(sessionId), "tasks");
    let entries: string[];
    try {
      entries = await fs.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const tasks: SessionTask[] = [];
    for (const entry of entries) {
      if (!isValidSessionId(entry)) continue;
      const record = await this.readTaskRecord(sessionId, entry);
      if (record) tasks.push(record);
    }

    tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return tasks;
  }

  async readTaskRecordsStrictForSession(
    sessionId: string,
  ): Promise<SessionTask[]> {
    const tasksDir = path.join(this.ports.sessionDir(sessionId), "tasks");
    const entries = await fs.readdir(tasksDir, { withFileTypes: true })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
    const tasks: SessionTask[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
      const taskDir = this.taskDir(sessionId, entry.name);
      const recordPath = path.join(taskDir, "task.json");
      if (!resolveExistingPathInside(taskDir, recordPath)) {
        throw new Error(`Task record path is invalid: ${entry.name}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(recordPath, "utf8"));
      } catch (error) {
        throw new Error(
          `Task record cannot be decoded: ${sessionId}/${entry.name}`,
          { cause: error },
        );
      }
      tasks.push(requireSessionTaskRecord(parsed, {
        sessionId,
        taskId: entry.name,
      }));
    }
    tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return tasks;
  }

  async writeTaskRecord(
    sessionId: string,
    taskId: string,
    record: SessionTask,
  ): Promise<void> {
    if (!isValidSessionId(sessionId) || !isValidSessionId(taskId)) {
      throw new Error("Invalid session or task id");
    }
    const taskDir = this.taskDir(sessionId, taskId);
    const recordPath = path.join(taskDir, "task.json");
    if (
      existsSync(recordPath) &&
      !resolveExistingPathInside(taskDir, recordPath)
    ) {
      throw new Error("Task record path must stay inside the task");
    }
    await writeJsonAtomic(recordPath, record);
  }

  async compareAndSetTaskRecord(
    sessionId: string,
    taskId: string,
    expectedStatuses: readonly TaskStatus[],
    patch: SessionTaskPatch,
    options: TaskRecordCompareAndSetOptions = {},
  ): Promise<TaskRecordCompareAndSetResult | null> {
    if (!isValidSessionId(sessionId) || !isValidSessionId(taskId)) return null;
    if (!existsSync(path.join(this.taskDir(sessionId, taskId), "task.json"))) {
      return null;
    }
    let terminalTask: SessionTask | null = null;
    const result = await this.ports.withTaskLock(
      this.taskLockPath(sessionId, taskId),
      async () => {
        const existing = await this.readTaskRecord(sessionId, taskId);
        if (!existing) return null;
        if (!expectedStatuses.includes(existing.status)) {
          return { task: existing, updated: false };
        }
        if (
          options.expectedExecutionAttemptId !== undefined &&
          existing.executionAttemptId !==
            (options.expectedExecutionAttemptId ?? undefined)
        ) {
          return { task: existing, updated: false };
        }
        if (
          options.expectedAdmissionRequestId !== undefined &&
          existing.admission?.requestId !==
            (options.expectedAdmissionRequestId ?? undefined)
        ) {
          return { task: existing, updated: false };
        }
        if (
          options.expectedAdmissionPhase !== undefined &&
          existing.admission?.phase !==
            (options.expectedAdmissionPhase ?? undefined)
        ) {
          return { task: existing, updated: false };
        }
        if (
          options.expectedAdmissionGrantId !== undefined &&
          (existing.admission?.phase === "granted"
            ? existing.admission.grantId
            : undefined) !== (options.expectedAdmissionGrantId ?? undefined)
        ) {
          return { task: existing, updated: false };
        }
        if (
          options.expectedAdmissionOwnerEpoch !== undefined &&
          (existing.admission?.phase === "granted"
            ? existing.admission.ownerEpoch
            : undefined) !== (options.expectedAdmissionOwnerEpoch ?? undefined)
        ) {
          return { task: existing, updated: false };
        }
        if (
          isTerminalTaskStatus(existing.status) &&
          patch.status !== undefined &&
          patch.status !== existing.status
        ) {
          return { task: existing, updated: false };
        }

        const now = this.ports.now().toISOString();
        const merged: Record<string, unknown> = {
          ...existing,
          id: existing.id,
          sessionId: existing.sessionId,
          runId: existing.runId,
          workflowId: existing.workflowId,
          cwd: existing.cwd,
          createdAt: existing.createdAt,
          updatedAt: now,
        };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete merged[key];
          else merged[key] = value;
        }
        merged.id = existing.id;
        merged.sessionId = existing.sessionId;
        merged.runId = existing.runId;
        merged.workflowId = existing.workflowId;
        if (existing.targetKind === undefined) delete merged.targetKind;
        else merged.targetKind = existing.targetKind;
        if (existing.teamId === undefined) delete merged.teamId;
        else merged.teamId = existing.teamId;
        merged.cwd = existing.cwd;
        merged.createdAt = existing.createdAt;
        merged.updatedAt = now;
        const next = requireSessionTaskRecord(merged, {
          sessionId,
          taskId,
        });
        if (isTerminalTaskStatus(next.status) && !next.completedAt) {
          next.completedAt = now;
        }
        if (
          next.status === "done" &&
          !isTerminalTaskStatus(existing.status)
        ) {
          const snapshot = next.assignmentPath
            ? await new FileSystemWorkflowStateStore(next.assignmentPath).load()
            : null;
          if (
            snapshot &&
            terminalTaskStatusForWorkflow(snapshot.state.status) === "done"
          ) {
            if (!snapshot.state.terminalOutcome) {
              throw new Error(
                "Terminal workflow journal has no durable publication outcome.",
              );
            }
            await this.ports.verifyWorkflowOutcomeArtifacts(
              next,
              snapshot.state.terminalOutcome,
            );
          }

          await this.ports.tryRepairTerminalTaskResult(next);
        }
        await this.writeTaskRecord(sessionId, taskId, next);
        if (isTerminalTaskStatus(next.status)) terminalTask = next;
        return { task: next, updated: true };
      },
    );

    if (terminalTask) {
      await this.ports.finalizeTerminalTask(sessionId, terminalTask);
    }
    return result;
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}
