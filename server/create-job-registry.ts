import {
  FileSystemCreateJobStateStore,
  type CreateJobStateStore,
  type PersistedCreateJob,
  type PersistedCreateJobState,
  type PersistedPendingCancellation,
} from "./create-job-state-store.js";
import { APPLICATION_SHUTDOWN_ABORT_REASON } from "../core/lifecycle.js";

/**
 * A Create job, and how far it has got towards an outcome.
 *
 * `completing` is a claim in flight: the turn has produced an answer and asked
 * to settle as completed, and its terminal record is being written. `completed`
 * is that write having succeeded. The two are separate because only the second
 * is durable — a claim is a reservation, and reporting one as an outcome would
 * announce a completion nobody could read back.
 */
export interface CreateJob {
  controller: AbortController;
  status: "running" | "cancelled" | "completing" | "completed";
}

interface TrackedCreateJob extends CreateJob {
  finished: Promise<void>;
  resolveFinished(): void;
  updatedAt: number;
  /**
   * A cancellation that arrived while a claim was held.
   *
   * It does not rewrite the status — the claim decides the job — but it is not
   * discarded either: if the completion is never stored, this is what applies.
   */
  cancellationRequested: boolean;
}

export type CreateJobStartResult =
  | { status: "started"; job: CreateJob }
  | { status: "pending_cancelled" }
  | { status: "conflict" };

/**
 * What a cancellation request came to.
 *
 * A union rather than a pair of independent fields, so the two halves cannot
 * drift: `cancelled: false` is sayable only alongside a status that explains
 * why, and no caller can report a cancelled job as completed or the reverse.
 */
export type CreateJobCancelResult =
  | { jobId: string; cancelled: true; status: "pending" | "cancelled" }
  | { jobId: string; cancelled: false; status: "completing" | "completed" };

export interface CreateJobRegistryOptions {
  now?: () => number;
  pendingCancellationTtlMs?: number;
  workspacePath?: string;
}

const DEFAULT_PENDING_CANCELLATION_TTL_MS = 60_000;

export class CreateJobRegistry {
  private readonly jobs = new Map<string, TrackedCreateJob>();
  private readonly now: () => number;
  private readonly pendingCancellationExpirations = new Map<string, number>();
  private readonly pendingCancellationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingCancellationTtlMs: number;
  private readonly stateStore: CreateJobStateStore | null;
  private closed = false;

  constructor(options: CreateJobRegistryOptions | number = {}) {
    const normalizedOptions =
      typeof options === "number"
        ? { pendingCancellationTtlMs: options }
        : options;
    this.pendingCancellationTtlMs =
      normalizedOptions.pendingCancellationTtlMs ??
      DEFAULT_PENDING_CANCELLATION_TTL_MS;
    if (
      !Number.isFinite(this.pendingCancellationTtlMs) ||
      this.pendingCancellationTtlMs < 0
    ) {
      throw new Error("pendingCancellationTtlMs must be a non-negative number");
    }
    this.now = normalizedOptions.now ?? Date.now;
    this.stateStore = normalizedOptions.workspacePath
      ? new FileSystemCreateJobStateStore(normalizedOptions.workspacePath)
      : null;

    this.restorePersistedState();
  }

  start(jobId: string): CreateJobStartResult {
    this.assertOpen();
    if (this.consumePendingCancellation(jobId)) {
      return { status: "pending_cancelled" };
    }
    if (this.jobs.has(jobId)) {
      return { status: "conflict" };
    }

    // The settle function exists from the moment the executor runs, but that
    // is a fact about `Promise`, not one the type system can see. Calling
    // through an optional says the same thing without asserting it.
    let settle: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const job: TrackedCreateJob = {
      cancellationRequested: false,
      controller: new AbortController(),
      finished,
      resolveFinished: () => settle?.(),
      status: "running",
      updatedAt: this.now(),
    };
    this.jobs.set(jobId, job);
    try {
      this.persistState();
    } catch (error) {
      this.jobs.delete(jobId);
      throw error;
    }
    return { status: "started", job };
  }

  /**
   * Records that a job is over.
   *
   * The job ending is a fact about a process that has already stopped;
   * persisting that fact is a separate thing that can fail. Putting the entry
   * back when the write fails would make `isActive` report a build nobody is
   * running and reserve its id for good, because the only caller that would
   * ever release it has just been told the job is finished. A state file that
   * still lists the job is the recoverable half: the next start reconciles a
   * stale active job into a pending cancellation. The write failure is still
   * raised, so a caller that can report it does.
   */
  finish(jobId: string): void {
    if (this.closed) return;
    const job = this.jobs.get(jobId);
    if (!job) return;

    // A claim nobody confirmed never became an outcome. Left as it is, a
    // waiting acknowledgement would read `completing` and have to guess; giving
    // it back here means the only status that ever reads as a completion is one
    // whose record was actually stored.
    this.giveBackUnconfirmedClaim(job);
    this.jobs.delete(jobId);
    try {
      this.persistState();
    } finally {
      job.resolveFinished();
    }
  }

  /**
   * Ask to settle this job as completed, in one step.
   *
   * Granted while nothing has cancelled the job, and from that moment a
   * cancellation no longer decides it. Read-then-act cannot express this: a
   * cancellation landing between the read and the reply is invisible to the
   * turn and still flips the job, which is how one turn ends up with two
   * accounts of how it ended.
   *
   * A claim is a reservation, not a success. `confirmCompletion` makes it the
   * job's outcome once the terminal record is stored; `releaseCompletion` gives
   * it back when that write refuses. Idempotent for the turn that holds it, so
   * a route that asks twice is not told its own claim was lost.
   *
   * A job the registry no longer tracks — shut down, or already finished —
   * cannot be claimed: nothing about it is still this turn's to decide.
   */
  claimCompletion(jobId: string): "granted" | "cancelled" {
    const job = this.jobs.get(jobId);
    if (!job) return "cancelled";
    if (job.status === "completing" || job.status === "completed") {
      return "granted";
    }
    if (job.status === "cancelled" || job.controller.signal.aborted) {
      return "cancelled";
    }
    job.status = "completing";
    job.updatedAt = this.now();
    return "granted";
  }

  /**
   * Make a granted claim the job's outcome, its record having been stored.
   *
   * A no-op without a claim in hand. That is what keeps a deliberate exception
   * honest: a turn that reports a stored proposal over a cancellation it *lost*
   * must not retro-claim the job, or Stop would report a completion the person
   * did cancel.
   */
  confirmCompletion(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job?.status !== "completing") return;
    job.status = "completed";
    job.updatedAt = this.now();
  }

  /**
   * Give back a claim whose completion was never stored.
   *
   * Only an unconfirmed one. Once the outcome is committed the job is settled,
   * and a failure in what comes after it — the reply, the socket, closing the
   * stream — may neither make the job cancellable again nor add a second
   * terminal record.
   */
  releaseCompletion(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.giveBackUnconfirmedClaim(job);
  }

  /**
   * The claim is deliberately not persisted, here or in `claimCompletion`.
   *
   * It does not outlive this process, and the next one reconciles every job the
   * state file lists into a pending cancellation whatever its recorded status —
   * so a durable claim would describe a turn that no longer exists.
   */
  private giveBackUnconfirmedClaim(job: TrackedCreateJob): void {
    if (job.status !== "completing") return;
    job.status = job.cancellationRequested ? "cancelled" : "running";
    job.updatedAt = this.now();
  }

  async cancelAndWait(jobId: string): Promise<CreateJobCancelResult> {
    const activeJob = this.jobs.get(jobId);
    const result = this.cancel(jobId);
    if (!activeJob) return result;
    await activeJob.finished;
    // Decided after the wait, not before it. A completion claimed and stored
    // before this cancellation landed is the job's outcome, and calling it
    // cancelled would give Stop and the turn two accounts of one turn. Only a
    // stored completion reads as one: a claim released, a claim never
    // confirmed, a terminal write that failed and a job that ended in error all
    // report the cancellation that was in fact requested.
    return activeJob.status === "completed"
      ? { jobId, cancelled: false, status: "completed" }
      : { jobId, cancelled: true, status: "cancelled" };
  }

  cancel(jobId: string): CreateJobCancelResult {
    this.assertOpen();
    const job = this.jobs.get(jobId);
    if (!job) {
      this.rememberPendingCancellation(jobId);
      return { jobId, cancelled: true, status: "pending" };
    }

    if (job.status === "completing" || job.status === "completed") {
      // The claim already decided this job. Stop stays immediately effective —
      // the signal aborts, so anything still listening is interrupted — but the
      // request is recorded rather than allowed to rewrite an outcome the turn
      // is about to report. Nothing here is cancelled yet, and `completing`
      // says why the answer is not final: a caller that needs one waits, in
      // `cancelAndWait`.
      job.cancellationRequested = true;
      job.controller.abort();
      return { jobId, cancelled: false, status: job.status };
    }

    const previousStatus = job.status;
    const previousUpdatedAt = job.updatedAt;
    job.status = "cancelled";
    job.updatedAt = this.now();
    try {
      this.persistState();
    } catch (error) {
      job.status = previousStatus;
      job.updatedAt = previousUpdatedAt;
      throw error;
    }
    job.controller.abort();
    return { jobId, cancelled: true, status: "cancelled" };
  }

  isCancelled(job: CreateJob): boolean {
    // A claim decides the job. The signal still aborts when Stop lands, so the
    // turn is interrupted at once, but an abort after the claim is no longer an
    // answer to "was this cancelled?" — the answer is whatever became of the
    // claim, and `releaseCompletion` is what turns a failed one back into a
    // cancellation.
    if (job.status === "completing" || job.status === "completed") return false;
    return job.status === "cancelled" || job.controller.signal.aborted;
  }

  isActive(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.pendingCancellationTimers.values()) {
      clearTimeout(timer);
    }
    for (const job of this.jobs.values()) {
      // Shutdown, not Stop: the work records that it was interrupted.
      job.controller.abort(APPLICATION_SHUTDOWN_ABORT_REASON);
      job.resolveFinished();
    }
    this.pendingCancellationTimers.clear();
    this.pendingCancellationExpirations.clear();
    this.jobs.clear();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("CreateJobRegistry is closed");
    }
  }

  private restorePersistedState(): void {
    const persistedState = this.readPersistedState();
    const now = this.now();
    const removedExpired = this.restorePendingCancellations(
      persistedState.pendingCancellations,
      now,
    );
    this.reconcileStaleJobs(persistedState.activeJobs, now);
    if (removedExpired || persistedState.activeJobs.length > 0) {
      this.persistState();
    }
    for (const [jobId, expiresAt] of this.pendingCancellationExpirations) {
      this.schedulePendingCancellationExpiry(jobId, expiresAt);
    }
  }

  private restorePendingCancellations(
    pendingCancellations: PersistedPendingCancellation[],
    now: number,
  ): boolean {
    let removedExpired = false;
    for (const pending of pendingCancellations) {
      if (pending.expiresAt <= now) {
        removedExpired = true;
      } else {
        this.pendingCancellationExpirations.set(
          pending.jobId,
          pending.expiresAt,
        );
      }
    }
    return removedExpired;
  }

  private reconcileStaleJobs(
    staleJobs: PersistedCreateJob[],
    now: number,
  ): void {
    for (const staleJob of staleJobs) {
      const expiresAt = now + this.pendingCancellationTtlMs;
      const existingExpiration =
        this.pendingCancellationExpirations.get(staleJob.jobId) ?? 0;
      this.pendingCancellationExpirations.set(
        staleJob.jobId,
        Math.max(existingExpiration, expiresAt),
      );
    }
  }

  private readPersistedState(): PersistedCreateJobState {
    return (
      this.stateStore?.read() ?? {
        activeJobs: [],
        pendingCancellations: [],
        version: 1,
      }
    );
  }

  private persistState(): void {
    if (!this.stateStore) return;
    const state: PersistedCreateJobState = {
      activeJobs: [...this.jobs].map(([jobId, job]) => ({
        jobId,
        // A claim does not survive this process, and the next one reconciles
        // every job listed here into a pending cancellation whatever status it
        // reads. So `completing` and `completed` are written as what they are
        // from that process's point of view — a job that was in flight — rather
        // than as a state it could not honour.
        status: job.status === "cancelled" ? "cancelled" : "running",
        updatedAt: job.updatedAt,
      })),
      pendingCancellations: [...this.pendingCancellationExpirations].map(
        ([jobId, expiresAt]) => ({ expiresAt, jobId }),
      ),
      version: 1,
    };
    this.stateStore.write(state);
  }

  private rememberPendingCancellation(jobId: string): void {
    const expiresAt = this.now() + this.pendingCancellationTtlMs;
    const previousExpiration =
      this.pendingCancellationExpirations.get(jobId);
    this.pendingCancellationExpirations.set(jobId, expiresAt);
    try {
      this.persistState();
    } catch (error) {
      if (previousExpiration === undefined) {
        this.pendingCancellationExpirations.delete(jobId);
      } else {
        this.pendingCancellationExpirations.set(jobId, previousExpiration);
      }
      throw error;
    }
    this.schedulePendingCancellationExpiry(jobId, expiresAt);
  }

  private schedulePendingCancellationExpiry(
    jobId: string,
    expiresAt: number,
  ): void {
    const existingTimer = this.pendingCancellationTimers.get(jobId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(
      () => this.expirePendingCancellation(jobId, expiresAt),
      Math.max(0, expiresAt - this.now()),
    );
    timer.unref?.();
    this.pendingCancellationTimers.set(jobId, timer);
  }

  private expirePendingCancellation(jobId: string, expiresAt: number): void {
    if (this.closed) return;
    if (this.pendingCancellationExpirations.get(jobId) !== expiresAt) return;

    this.pendingCancellationExpirations.delete(jobId);
    try {
      this.persistState();
      this.pendingCancellationTimers.delete(jobId);
    } catch {
      const retryAt = this.now() + 1_000;
      this.pendingCancellationExpirations.set(jobId, retryAt);
      this.schedulePendingCancellationExpiry(jobId, retryAt);
    }
  }

  private consumePendingCancellation(jobId: string): boolean {
    const expiresAt = this.pendingCancellationExpirations.get(jobId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.expirePendingCancellation(jobId, expiresAt);
      return false;
    }

    this.pendingCancellationExpirations.delete(jobId);
    try {
      this.persistState();
    } catch (error) {
      this.pendingCancellationExpirations.set(jobId, expiresAt);
      throw error;
    }
    const timer = this.pendingCancellationTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.pendingCancellationTimers.delete(jobId);
    return true;
  }
}
