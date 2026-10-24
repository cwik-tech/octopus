import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";

import type { RunPlan } from "../../contracts/run-plan.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import { whenDefined } from "../../core/optional-properties.js";
import {
  markRunPlanApplying,
  markRunPlanQueued,
  markRunPlanRunning,
} from "../run-orchestrator/orchestrator.js";
import {
  isActiveTaskStatus,
  isTerminalTaskStatus,
  isValidSessionId,
  type SessionSummary,
  type SessionTask,
} from "./session-types.js";
import {
  clearRunPlanApplyClaim,
  isRunPlanRevisionBlocked,
  isTerminalRunPlanStatus,
  resetRunPlanApplyClaim,
} from "./run-plan-helpers.js";
import type { LocatedTaskProcess } from "./task-process-supervisor.js";

export interface RunPlanApplyClaimResult {
  plan: RunPlan;
  claimed: boolean;
}

export interface RunPlanRevisionResult {
  plan: RunPlan;
  revised: boolean;
}

export interface RunPlanCoordinatorPorts {
  sessionsDir(): string;
  sessionDir(sessionId: string): string;
  metadataPath(sessionId: string): string;
  runPlanPath(sessionId: string): string;
  sessionLockPath(sessionId: string): string;
  ensureBaseDir(): Promise<void>;
  readMetadata(sessionId: string): Promise<SessionSummary | null>;
  writeMetadata(summary: SessionSummary): Promise<void>;
  readTaskRecords(sessionId: string): Promise<SessionTask[]>;
  readTaskRecordsStrictForSession(sessionId: string): Promise<SessionTask[]>;
  readTaskRecord(
    sessionId: string,
    taskId: string,
  ): Promise<SessionTask | null>;
  writeTaskRecord(
    sessionId: string,
    taskId: string,
    task: SessionTask,
  ): Promise<void>;
  withSessionLock<T>(
    lockPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  findProcessByIdentity(processIdentity: string): LocatedTaskProcess | null;
  isProcessAlive(pid: number): boolean;
  now(): Date;
  instanceId(): string;
  processId(): number;
  applyClaimLeaseMs(): number;
}

export class RunPlanCoordinator {
  constructor(private readonly ports: RunPlanCoordinatorPorts) {}

  async readRunPlanRecord(sessionId: string): Promise<RunPlan | null> {
    try {
      const raw = await fs.readFile(this.ports.runPlanPath(sessionId), "utf8");
      return JSON.parse(raw) as RunPlan;
    } catch {
      return null;
    }
  }

  async getRunPlan(sessionId: string): Promise<RunPlan | null> {
    if (!isValidSessionId(sessionId)) return null;
    return this.readRunPlanRecord(sessionId);
  }

  async saveRunPlan(sessionId: string, plan: RunPlan): Promise<boolean> {
    if (!isValidSessionId(sessionId)) return false;
    if (!existsSync(this.ports.metadataPath(sessionId))) return false;
    return this.ports.withSessionLock(
      this.ports.sessionLockPath(sessionId),
      async () => {
        const summary = await this.ports.readMetadata(sessionId);
        if (!summary) return false;
        const current = await this.readRunPlanRecord(sessionId);
        if (
          current &&
          current.id !== plan.id &&
          isRunPlanRevisionBlocked(current.status)
        ) {
          return false;
        }
        if (
          current?.id === plan.id &&
          isTerminalRunPlanStatus(current.status)
        ) {
          return false;
        }

        const now = this.ports.now().toISOString();
        const next =
          current?.id === plan.id && current.taskId && !plan.taskId
            ? { ...plan, taskId: current.taskId, updatedAt: now }
            : { ...plan, updatedAt: plan.updatedAt ?? now };
        await fs.mkdir(this.ports.sessionDir(sessionId), { recursive: true });
        await writeJsonAtomic(this.ports.runPlanPath(sessionId), next);
        await this.ports.writeMetadata({
          ...summary,
          updatedAt: now,
        });
        return true;
      },
    );
  }

  async reviseRunPlan(
    sessionId: string,
    expectedPlanId: string | null,
    nextPlan: RunPlan,
  ): Promise<RunPlanRevisionResult | null> {
    if (
      !isValidSessionId(sessionId) ||
      !existsSync(this.ports.metadataPath(sessionId))
    ) {
      return null;
    }
    return this.ports.withSessionLock(
      this.ports.sessionLockPath(sessionId),
      async () => {
        const summary = await this.ports.readMetadata(sessionId);
        if (!summary) return null;
        const current = await this.readRunPlanRecord(sessionId);
        const expectedMatches = expectedPlanId
          ? current?.id === expectedPlanId
          : current === null;
        if (
          !expectedMatches ||
          (current !== null && isRunPlanRevisionBlocked(current.status))
        ) {
          return current ? { plan: current, revised: false } : null;
        }

        const now = this.ports.now().toISOString();
        const revisedPlan = { ...nextPlan, updatedAt: now };
        await writeJsonAtomic(
          this.ports.runPlanPath(sessionId),
          revisedPlan,
        );
        await this.ports.writeMetadata({ ...summary, updatedAt: now });
        return { plan: revisedPlan, revised: true };
      },
    );
  }

  async claimRunPlanForApply(
    sessionId: string,
    planId: string,
  ): Promise<RunPlanApplyClaimResult | null> {
    if (
      !isValidSessionId(sessionId) ||
      !existsSync(this.ports.metadataPath(sessionId))
    ) {
      return null;
    }
    return this.ports.withSessionLock(
      this.ports.sessionLockPath(sessionId),
      async () => {
        const plan = await this.readRunPlanRecord(sessionId);
        if (!plan || plan.id !== planId) {
          return plan ? { plan, claimed: false } : null;
        }
        if (plan.status !== "ready") return { plan, claimed: false };

        const claimedAt = this.ports.now().toISOString();
        const claimedPlan: RunPlan = {
          ...markRunPlanApplying(plan),
          applyClaimId: crypto.randomUUID(),
          applyClaimOwnerInstanceId: this.ports.instanceId(),
          applyClaimOwnerPid: this.ports.processId(),
          applyClaimedAt: claimedAt,
          updatedAt: claimedAt,
        };
        await writeJsonAtomic(
          this.ports.runPlanPath(sessionId),
          claimedPlan,
        );
        const summary = await this.ports.readMetadata(sessionId);
        if (summary) {
          await this.ports.writeMetadata({
            ...summary,
            updatedAt:
              claimedPlan.updatedAt ?? this.ports.now().toISOString(),
          });
        }
        return { plan: claimedPlan, claimed: true };
      },
    );
  }

  async recoverRunPlanApply(
    sessionId: string,
    planId: string,
  ): Promise<RunPlan | null> {
    if (
      !isValidSessionId(sessionId) ||
      !existsSync(this.ports.metadataPath(sessionId))
    ) {
      return null;
    }
    return this.ports.withSessionLock(
      this.ports.sessionLockPath(sessionId),
      async () => {
        let plan = await this.readRunPlanRecord(sessionId);
        if (!plan || plan.id !== planId || plan.status !== "applying") {
          return plan;
        }

        const tasks = await this.ports.readTaskRecords(sessionId);
        const applyingPlan = plan;
        let linkedTask = applyingPlan.taskId
          ? tasks.find((task) => task.id === applyingPlan.taskId)
          : [...tasks]
              .reverse()
              .find((task) => task.runPlanId === applyingPlan.id);
        const applyOwnerIsActive = this.isApplyClaimOwnerActive(applyingPlan);

        if (linkedTask) {
          const belongsToCurrentApply =
            plan.applyClaimOwnerInstanceId === this.ports.instanceId();
          if (
            linkedTask.status === "queued" &&
            !linkedTask.pid &&
            !linkedTask.processGroupId &&
            linkedTask.processIdentity
          ) {
            const located = this.ports.findProcessByIdentity(
              linkedTask.processIdentity,
            );
            if (located) {
              const updatedTask: SessionTask = {
                ...linkedTask,
                pid: located.pid,
                ...whenDefined(located.processGroupId, (processGroupId) => ({
                  processGroupId,
                })),
                updatedAt: this.ports.now().toISOString(),
              };
              await this.ports.writeTaskRecord(
                sessionId,
                updatedTask.id,
                updatedTask,
              );
              linkedTask = updatedTask;
            }
          }
          const workerMayExist = Boolean(
            linkedTask.pid ||
              linkedTask.processGroupId ||
              linkedTask.status !== "queued",
          );
          if (belongsToCurrentApply || applyOwnerIsActive || workerMayExist) {
            if (plan.taskId !== linkedTask.id) {
              plan = {
                ...plan,
                taskId: linkedTask.id,
                updatedAt: this.ports.now().toISOString(),
              };
              await writeJsonAtomic(
                this.ports.runPlanPath(sessionId),
                plan,
              );
            }
            return plan;
          }

          const failedAt = this.ports.now().toISOString();
          await this.ports.writeTaskRecord(sessionId, linkedTask.id, {
            ...linkedTask,
            status: "failed",
            error:
              "Task launch was interrupted before the worker started; retrying the run plan.",
            completedAt: failedAt,
            updatedAt: failedAt,
          });
        } else if (applyOwnerIsActive) {
          return plan;
        }

        plan = resetRunPlanApplyClaim(
          plan,
          this.ports.now().toISOString(),
        );
        await writeJsonAtomic(this.ports.runPlanPath(sessionId), plan);
        const summary = await this.ports.readMetadata(sessionId);
        if (summary) {
          const remainingTasks = await this.ports.readTaskRecords(sessionId);
          await this.ports.writeMetadata({
            ...summary,
            status: remainingTasks.some((task) =>
              isActiveTaskStatus(task.status),
            )
              ? "active"
              : remainingTasks.length > 0
                ? "done"
                : "idle",
            updatedAt: plan.updatedAt ?? this.ports.now().toISOString(),
          });
        }
        return plan;
      },
    );
  }

  async finalizeRunPlanApply(
    sessionId: string,
    planId: string,
    claimId: string,
    nextPlan: RunPlan,
  ): Promise<RunPlan | null> {
    if (
      !isValidSessionId(sessionId) ||
      !existsSync(this.ports.metadataPath(sessionId))
    ) {
      return null;
    }
    return this.ports.withSessionLock(
      this.ports.sessionLockPath(sessionId),
      async () => {
        const current = await this.readRunPlanRecord(sessionId);
        if (
          !current ||
          current.id !== planId ||
          current.status !== "applying" ||
          current.applyClaimId !== claimId ||
          nextPlan.id !== planId
        ) {
          return null;
        }

        const now = this.ports.now().toISOString();
        const finalized = clearRunPlanApplyClaim({
          ...nextPlan,
          ...(current.taskId && !nextPlan.taskId
            ? { taskId: current.taskId }
            : {}),
          updatedAt: nextPlan.updatedAt ?? now,
        });
        await writeJsonAtomic(
          this.ports.runPlanPath(sessionId),
          finalized,
        );
        const summary = await this.ports.readMetadata(sessionId);
        if (summary) {
          await this.ports.writeMetadata({ ...summary, updatedAt: now });
        }
        return finalized;
      },
    );
  }

  async markRunPlanRunningIfQueued(
    sessionId: string,
    planId: string,
    taskId: string,
    executionAttemptId: string,
  ): Promise<RunPlan | null> {
    if (
      !isValidSessionId(sessionId) ||
      !isValidSessionId(taskId) ||
      !existsSync(this.ports.metadataPath(sessionId))
    ) {
      return null;
    }
    return this.ports.withSessionLock(
      this.ports.sessionLockPath(sessionId),
      async () => {
        const [plan, task] = await Promise.all([
          this.readRunPlanRecord(sessionId),
          this.ports.readTaskRecord(sessionId, taskId),
        ]);
        if (!plan || plan.id !== planId) return plan;
        if (
          plan.status !== "queued" ||
          plan.taskId !== taskId ||
          !task ||
          task.executionAttemptId !== executionAttemptId ||
          task.status !== "running" ||
          !task.workerStartedAt
        ) {
          return plan;
        }
        const running = markRunPlanRunning(plan, taskId);
        await writeJsonAtomic(
          this.ports.runPlanPath(sessionId),
          running,
        );
        const summary = await this.ports.readMetadata(sessionId);
        if (summary) {
          await this.ports.writeMetadata({
            ...summary,
            status: "active",
            updatedAt: running.updatedAt ?? this.ports.now().toISOString(),
          });
        }
        return running;
      },
    );
  }

  async recoverOrphanedRunPlanApplies(): Promise<boolean> {
    await this.ports.ensureBaseDir();
    let repairedAny = false;
    const sessionEntries = await fs.readdir(this.ports.sessionsDir(), {
      withFileTypes: true,
    });
    for (const entry of sessionEntries) {
      if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
      const plan = await this.readRunPlanRecord(entry.name);
      if (plan?.status !== "applying") continue;
      await this.ports.withSessionLock(
        this.ports.sessionLockPath(entry.name),
        async () => {
          const current = await this.readRunPlanRecord(entry.name);
          if (
            !current ||
            current.id !== plan.id ||
            current.status !== "applying"
          ) {
            return;
          }
          const currentTasks =
            await this.ports.readTaskRecordsStrictForSession(entry.name);
          let linkedTask = currentTasks.find(
            (task) =>
              task.id === current.taskId || task.runPlanId === current.id,
          );

          // Older applies wrote the queued task and plan link separately.
          if (!linkedTask && !current.taskId) {
            const claimedAt = Date.parse(current.applyClaimedAt ?? "");
            const candidates = currentTasks.filter(
              (task) =>
                task.status === "queued" &&
                !task.runPlanId &&
                !task.executionAttemptId &&
                task.pid === undefined &&
                task.processGroupId === undefined &&
                task.workflowId === current.selectedWorkflow?.id &&
                task.admission?.phase === "pending" &&
                task.admission.executionKind === "initial" &&
                task.admission.source === "startup_repair" &&
                (!Number.isFinite(claimedAt) ||
                  Date.parse(task.createdAt) >= claimedAt),
            );
            if (candidates.length > 1) {
              throw new Error(
                `Applying run plan has multiple unlinked legacy tasks: ${entry.name}/${current.id}`,
              );
            }
            linkedTask = candidates[0];
          }

          if (linkedTask && !isTerminalTaskStatus(linkedTask.status)) {
            const repairedAt = this.ports.now().toISOString();
            const repairedTask: SessionTask = {
              ...linkedTask,
              runPlanId: current.id,
              ...(linkedTask.admission
                ? {
                    admission: {
                      ...linkedTask.admission,
                      runPlanId: current.id,
                      ...(current.applyClaimId
                        ? { applyClaimId: current.applyClaimId }
                        : {}),
                    },
                  }
                : {}),
              updatedAt: repairedAt,
            };
            await this.ports.writeTaskRecord(
              entry.name,
              repairedTask.id,
              repairedTask,
            );
            const repairedPlan =
              linkedTask.status === "running" ||
              (linkedTask.status === "interrupted" && !linkedTask.admission)
                ? markRunPlanRunning(current, repairedTask.id)
                : markRunPlanQueued(current, repairedTask.id);
            await writeJsonAtomic(this.ports.runPlanPath(entry.name), {
              ...repairedPlan,
              updatedAt: repairedAt,
            });
            const summary = await this.ports.readMetadata(entry.name);
            if (summary) {
              await this.ports.writeMetadata({
                ...summary,
                status: "active",
                activityType: "workflow",
                updatedAt: repairedAt,
              });
            }
            repairedAny = true;
            return;
          }
          const reset = resetRunPlanApplyClaim(
            current,
            this.ports.now().toISOString(),
          );
          await writeJsonAtomic(this.ports.runPlanPath(entry.name), reset);
          const summary = await this.ports.readMetadata(entry.name);
          if (summary) {
            await this.ports.writeMetadata({
              ...summary,
              status: "idle",
              updatedAt: reset.updatedAt ?? this.ports.now().toISOString(),
            });
          }
          repairedAny = true;
        },
      );
    }
    return repairedAny;
  }

  private isApplyClaimOwnerActive(plan: RunPlan): boolean {
    if (plan.applyClaimOwnerInstanceId === this.ports.instanceId()) return true;
    const claimedAt = Date.parse(plan.applyClaimedAt ?? "");
    if (!Number.isFinite(claimedAt)) return false;
    const claimAgeMs = Math.max(
      0,
      this.ports.now().getTime() - claimedAt,
    );
    if (claimAgeMs > this.ports.applyClaimLeaseMs()) return false;
    if (plan.applyClaimOwnerPid === undefined) return true;
    return this.ports.isProcessAlive(plan.applyClaimOwnerPid);
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
