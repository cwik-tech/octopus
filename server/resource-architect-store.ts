import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ResourceArchitectPlan,
  ResourceArchitectTurnMetric,
  ResourceBuildJobSnapshot,
  ResourcePlanAdmission,
} from "../contracts/resource-architect.js";
import type { PersistedResourceArchitectPlan } from "../contracts/resource-architect-persisted.js";
import { TurnMetricStore } from "./turn-metric-store.js";
import { ResourceArchitectConversationStore } from "./resource-architect-conversation-store.js";
import { writeFileAtomic } from "../core/file-mutation.js";
import { ServiceError } from "../services/service-errors.js";
import {
  parsePlanAdmissionRecord,
  parseResourceArchitectPlanRecord,
  parseResourceBuildJobRecord,
  parseTurnMetricRecord,
} from "./resource-architect-durable-records.js";

const TERMINAL_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const TURN_METRIC_RETENTION = 200;

export class ResourceArchitectStore {
  readonly conversation: ResourceArchitectConversationStore;
  private readonly plans = new Map<string, PersistedResourceArchitectPlan>();
  private readonly jobs = new Map<string, ResourceBuildJobSnapshot>();
  private readonly admissions = new Map<string, ResourcePlanAdmission>();
  private readonly applyingPlanIds = new Set<string>();
  private readonly planLocks = new Map<string, Promise<void>>();
  private jobsHydration: Promise<void> | null = null;
  private admissionsHydration: Promise<void> | null = null;
  private nextRetentionSweepAt = 0;

  private readonly turnMetricStore: TurnMetricStore;

  constructor(private readonly workspacePath?: string) {
    this.conversation = new ResourceArchitectConversationStore(workspacePath);
    this.turnMetricStore = new TurnMetricStore(
      workspacePath,
      "resource-architect-telemetry",
    );
  }

  async savePlan(plan: ResourceArchitectPlan): Promise<void> {
    const stored = clone(plan);
    // Durable first, memory second. A plan this process remembers but could
    // not record is a plan a build could still be started from, and the file
    // that was supposed to survive the restart is not there.
    if (this.workspacePath) {
      await writeFileAtomic(
        this.planPath(plan.id),
        `${JSON.stringify(stored, null, 2)}\n`,
      );
    }
    this.plans.set(stored.id, stored);
  }

  /**
   * The plan as it was stored, which is not always the shape authoring writes.
   *
   * A plan file predating the retirement of model grades still holds them, and
   * an update operation is identified by a digest over itself. Handing back a
   * trimmed copy would give the build a different operation from the one its
   * receipt was written for, so the persisted shape is what callers get.
   */
  async getPlan(planId: string): Promise<PersistedResourceArchitectPlan | null> {
    const memory = this.plans.get(planId);
    if (memory) return clone(memory);
    // A store with no workspace holds only what it was given. A plan it was
    // never given is missing, not a reason to go looking for a file.
    if (!this.workspacePath) return null;
    const disk = parseResourceArchitectPlanRecord(
      await this.readJson(this.planPath(planId)),
    );
    // A file that does not describe a plan never enters the map, so a later
    // read of the same id asks the disk again rather than serving something
    // this process already refused.
    if (!disk || disk.id !== planId) return null;
    this.plans.set(planId, disk);
    return clone(disk);
  }

  /**
   * Runs `operation` with no other plan-scoped critical section for this id.
   *
   * Read-then-write is not safe without it. An amendment reads the plan,
   * compares its revision and writes a new one; two of those interleaved both
   * see the same revision and the second silently overwrites the first. The
   * lock is entered *before* the read for that reason — checking a revision
   * read outside it proves nothing.
   *
   * In-process only, like `claimPlan`. One server owns its workspace, and a
   * second process writing the same plan directory is already outside what
   * this store models.
   */
  async withPlanLock<T>(planId: string, operation: () => Promise<T>): Promise<T> {
    const queued = (this.planLocks.get(planId) ?? Promise.resolve()).then(
      operation,
      operation,
    );
    // The chain records completion, never the value or the failure, so one
    // rejected operation does not reject every later waiter on this plan.
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.planLocks.set(planId, settled);
    try {
      return await queued;
    } finally {
      if (this.planLocks.get(planId) === settled) this.planLocks.delete(planId);
    }
  }

  /** Whether a build is applying this plan right now. */
  isPlanBeingApplied(planId: string): boolean {
    return this.applyingPlanIds.has(planId);
  }

  claimPlan(planId: string): () => void {
    if (this.applyingPlanIds.has(planId)) {
      throw new ServiceError(
        "conflict",
        `Resource plan '${planId}' is already being applied.`,
      );
    }
    this.applyingPlanIds.add(planId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.applyingPlanIds.delete(planId);
    };
  }

  /**
   * The build this plan is admitted for, or `null` when it has none.
   *
   * Read from disk when this process has not seen it, so a restart does not
   * forget that a plan was already admitted and let a second submission in.
   */
  async getPlanAdmission(planId: string): Promise<ResourcePlanAdmission | null> {
    const memory = this.admissions.get(planId);
    if (memory) return clone(memory);
    if (!this.workspacePath) return null;
    const disk = parsePlanAdmissionRecord(
      await this.readJson(this.admissionPath(planId)),
    );
    if (!disk || disk.planId !== planId) return null;
    this.admissions.set(planId, disk);
    return clone(disk);
  }

  /**
   * Every admission this workspace holds, hydrated from disk once.
   *
   * Reconciliation needs the ones this process never issued: an admission left
   * by the run that crashed is precisely the one no map in memory knows about.
   */
  async listPlanAdmissions(): Promise<ResourcePlanAdmission[]> {
    await this.hydrateAdmissions();
    return [...this.admissions.values()].map(clone);
  }

  /**
   * Records what this plan is admitted to build.
   *
   * Durable first, memory second, for the same reason a plan is: an admission
   * this process remembers but could not record would be forgotten by the
   * restart it exists to survive.
   */
  async savePlanAdmission(admission: ResourcePlanAdmission): Promise<void> {
    const stored = clone(admission);
    if (this.workspacePath) {
      await writeFileAtomic(
        this.admissionPath(stored.planId),
        `${JSON.stringify(stored, null, 2)}\n`,
      );
    }
    this.admissions.set(stored.planId, stored);
  }

  /**
   * Forgets an admission, so the plan can be admitted again.
   *
   * Only reconciliation calls this, and only for an admission whose job never
   * reached the store — the crash between recording the admission and creating
   * its job. A live submission that has not created its job yet is still in
   * flight, so the caller has to know the difference before it asks.
   */
  async clearPlanAdmission(planId: string): Promise<void> {
    // Hydrated first, so a read still walking the directory cannot put this
    // record back after it has been removed.
    await this.hydrateAdmissions();
    this.admissions.delete(planId);
    if (!this.workspacePath) return;
    await fs.rm(this.admissionPath(planId), { force: true });
  }

  async saveJob(job: ResourceBuildJobSnapshot): Promise<void> {
    const stored = clone(job);
    if (this.workspacePath) {
      await writeFileAtomic(
        this.jobPath(job.jobId),
        `${JSON.stringify(stored, null, 2)}\n`,
      );
    }
    this.jobs.set(job.jobId, stored);
  }

  async getJob(jobId: string): Promise<ResourceBuildJobSnapshot | null> {
    const memory = this.jobs.get(jobId);
    if (memory) return clone(memory);
    if (!this.workspacePath) return null;
    const disk = parseResourceBuildJobRecord(
      await this.readJson(this.jobPath(jobId)),
    );
    if (!disk || disk.jobId !== jobId) return null;
    this.jobs.set(jobId, disk);
    return clone(disk);
  }

  async listJobs(): Promise<ResourceBuildJobSnapshot[]> {
    await this.hydrateJobs();
    await this.pruneExpiredDurableRecords();
    return [...this.jobs.values()]
      .map(clone)
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  async saveTurnMetric(metric: ResourceArchitectTurnMetric): Promise<void> {
    await this.turnMetricStore.save(metric);
  }

  async recordTurnPublicationFailure(jobId: string, status: 'failed' | 'cancelled', totalDurationMs: number): Promise<void> {
    await this.turnMetricStore.recordPublicationFailure(jobId, status, totalDurationMs);
  }

  async listTurnMetrics(limit = TURN_METRIC_RETENTION): Promise<ResourceArchitectTurnMetric[]> {
    return this.turnMetricStore.list(limit);
  }


  private async hydrateJobs(): Promise<void> {
    if (!this.workspacePath || this.jobsHydration) {
      await this.jobsHydration;
      return;
    }
    const workspacePath = this.workspacePath;
    this.jobsHydration = (async () => {
      const directory = path.join(workspacePath, "resource-build-jobs");
      for (const entry of await this.listJsonFiles(directory)) {
        const job = parseResourceBuildJobRecord(
          await this.readJson(path.join(directory, entry)),
        );
        // A file that is not a job is left where it is and reported nowhere:
        // hydration answers with the jobs it could read, never with a
        // half-understood one. A job whose id does not name this file reached
        // the directory some other way, and letting it in would give one job's
        // file authority over another job's id.
        if (!job || entry !== `${digest(job.jobId)}.json`) continue;
        this.jobs.set(job.jobId, job);
      }
    })();
    await this.jobsHydration;
  }


  private async hydrateAdmissions(): Promise<void> {
    if (!this.workspacePath || this.admissionsHydration) {
      await this.admissionsHydration;
      return;
    }
    const workspacePath = this.workspacePath;
    this.admissionsHydration = (async () => {
      const directory = path.join(workspacePath, "resource-plan-admissions");
      for (const entry of await this.listJsonFiles(directory)) {
        const admission = parsePlanAdmissionRecord(
          await this.readJson(path.join(directory, entry)),
        );
        // A record whose plan id does not name its own file reached the
        // directory some other way. Letting it in would give one plan's
        // admission authority over another plan.
        if (!admission || entry !== `${digest(admission.planId)}.json`) continue;
        // Never over what this process already has: a live admission written
        // this run is newer than whatever the directory held when it started.
        if (!this.admissions.has(admission.planId)) {
          this.admissions.set(admission.planId, admission);
        }
      }
    })();
    await this.admissionsHydration;
  }

  private async pruneExpiredDurableRecords(): Promise<void> {
    if (!this.workspacePath || Date.now() < this.nextRetentionSweepAt) return;
    this.nextRetentionSweepAt = Date.now() + RETENTION_SWEEP_INTERVAL_MS;
    const expiredBefore = Date.now() - TERMINAL_JOB_RETENTION_MS;
    for (const job of [...this.jobs.values()]) {
      if (job.status === "running") continue;
      const modifiedAt = await this.modifiedAt(this.jobPath(job.jobId));
      if (modifiedAt === null || modifiedAt >= expiredBefore) continue;
      await fs.rm(this.jobPath(job.jobId), { force: true });
      this.jobs.delete(job.jobId);
    }

    const retainedPlanPaths = new Set(
      [...this.jobs.values()].map((job) => this.planPath(job.planId)),
    );
    const plansDirectory = path.join(this.workspacePath, "resource-architect-plans");
    const expiredPlanPaths = new Set<string>();
    for (const entry of await this.listJsonFiles(plansDirectory)) {
      const planPath = path.join(plansDirectory, entry);
      if (retainedPlanPaths.has(planPath)) continue;
      const modifiedAt = await this.modifiedAt(planPath);
      if (modifiedAt === null || modifiedAt >= expiredBefore) continue;
      await fs.rm(planPath, { force: true });
      expiredPlanPaths.add(planPath);
    }
    for (const [planId] of this.plans) {
      if (expiredPlanPaths.has(this.planPath(planId))) this.plans.delete(planId);
    }
  }

  /** The `.json` entries of one directory; a directory nobody can read is empty. */
  private async listJsonFiles(directory: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(directory);
      return entries.filter((entry) => entry.endsWith(".json"));
    } catch {
      return [];
    }
  }

  /** When a file last changed, or `null` when it cannot be asked. */
  private async modifiedAt(filePath: string): Promise<number | null> {
    try {
      const stats = await fs.stat(filePath);
      return stats.mtimeMs;
    } catch {
      return null;
    }
  }

  /** The file's JSON, still unknown. A file nobody can read is simply absent. */
  private async readJson(filePath: string): Promise<unknown> {
    if (!this.workspacePath) return null;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Where a record lives, for a store that has somewhere to put it.
   *
   * A store with no workspace keeps everything in memory and has no durable
   * path at all. Building one from an empty root would write durable files into
   * whatever directory the process happens to be running in, so the caller that
   * asked without checking is told plainly instead.
   */
  private requireWorkspacePath(): string {
    const workspacePath = this.workspacePath;
    if (!workspacePath) {
      throw new ServiceError(
        "not_configured",
        "Resource Architect store has no workspace to read or write durable records",
      );
    }
    return workspacePath;
  }

  private planPath(id: string): string {
    return path.join(
      this.requireWorkspacePath(),
      "resource-architect-plans",
      `${digest(id)}.json`,
    );
  }

  private admissionPath(id: string): string {
    return path.join(
      this.requireWorkspacePath(),
      "resource-plan-admissions",
      `${digest(id)}.json`,
    );
  }

  private jobPath(id: string): string {
    return path.join(
      this.requireWorkspacePath(),
      "resource-build-jobs",
      `${digest(id)}.json`,
    );
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
