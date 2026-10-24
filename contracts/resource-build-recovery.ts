/**
 * Which stopped build Create puts back on screen by itself, and which it does not.
 *
 * One rule, shared by the conversation route and the Create hook, so the two
 * cannot disagree about whether a build is still the user's unfinished work.
 * Unfinished work comes back after navigation, New, reload, and restart. A
 * terminal outcome stays visible only in the screen that watched it end.
 *
 * This decides presentation and admission only. It never deletes a receipt or
 * a staged file: a terminal job stays in the durable history for diagnostics.
 */

import type {
  ResourceBuildJobSnapshot,
  ResourceBuildJobStatus,
} from "./resource-architect.js";

/** How automatic Create restoration treats each job status. */
export const RESOURCE_BUILD_JOB_RECOVERY: Readonly<
  Record<ResourceBuildJobStatus, "recoverable" | "terminal">
> = {
  running: "recoverable",
  interrupted: "recoverable",
  partially_completed: "recoverable",
  completed: "terminal",
  failed: "terminal",
  cancelled: "terminal",
};

/**
 * Whether this job is unfinished work Create should keep and restore.
 *
 * `discarded` is a decision the user made about what the build left behind, so
 * it closes the job whatever its status says.
 */
export function isRecoverableResourceBuildJob(
  job: Pick<ResourceBuildJobSnapshot, "status" | "discarded">,
): boolean {
  return job.discarded !== true &&
    RESOURCE_BUILD_JOB_RECOVERY[job.status] === "recoverable";
}

/**
 * What restart reconciliation says about work the API stopped while it ran.
 *
 * Application-authored, so an earlier release's record can be recognized by it
 * exactly. Provider text is never matched by a word it happens to contain.
 */
export const API_RESTART_INTERRUPTION_MESSAGE =
  "Resource build was interrupted by an API restart. Retry the build to continue.";

/**
 * A job saved before `interrupted` existed, read as what it describes.
 *
 * Earlier releases wrote an API-restart interruption as `failed`, with this
 * message as the job error and on the closing build event. Only that exact
 * record qualifies. Anything else is returned unchanged, so a genuine failure
 * stays terminal. A partly finished job keeps its status; only its stopped
 * items become interrupted.
 */
export function readLegacyRestartInterruption(
  job: ResourceBuildJobSnapshot,
): ResourceBuildJobSnapshot {
  if (job.error !== API_RESTART_INTERRUPTION_MESSAGE) return job;
  const closingType = job.status === "failed"
    ? "build_failed"
    : job.status === "partially_completed"
      ? "build_partially_completed"
      : null;
  if (!closingType) return job;
  const closing = job.events.find((event) =>
    event.type === closingType && event.message === API_RESTART_INTERRUPTION_MESSAGE
  );
  if (!closing) return job;
  return {
    ...job,
    status: job.status === "failed" ? "interrupted" : job.status,
    items: job.items.map((item) =>
      item.status === "failed" && item.error === API_RESTART_INTERRUPTION_MESSAGE
        ? { ...item, status: "interrupted" }
        : item
    ),
    events: job.events.map((event) =>
      event === closing && closingType === "build_failed"
        ? { ...event, type: "build_interrupted" }
        : event
    ),
  };
}

/**
 * Newest admitted first. A job written before `startedAt` was recorded sorts
 * after every dated one, and the job id settles equal or missing times so the
 * order never depends on how the list happened to arrive.
 */
export function compareResourceBuildJobsNewestFirst(
  left: Pick<ResourceBuildJobSnapshot, "jobId" | "startedAt">,
  right: Pick<ResourceBuildJobSnapshot, "jobId" | "startedAt">,
): number {
  if (left.startedAt !== right.startedAt) {
    if (left.startedAt === undefined) return 1;
    if (right.startedAt === undefined) return -1;
    return left.startedAt < right.startedAt ? 1 : -1;
  }
  if (left.jobId === right.jobId) return 0;
  return left.jobId < right.jobId ? -1 : 1;
}

/** The newest attempt, whatever became of it. */
export function newestResourceBuildJob<
  T extends Pick<ResourceBuildJobSnapshot, "jobId" | "startedAt">,
>(jobs: readonly T[]): T | undefined {
  return [...jobs].sort(compareResourceBuildJobsNewestFirst)[0];
}

/**
 * The build a reopened Create should put back, or nothing.
 *
 * Only the newest attempt is considered. Every job is sorted first, terminal
 * and discarded ones included, because the newest one is an ordering barrier:
 * filtering it out first would resurrect an older interrupted plan underneath
 * a newer failure, cancellation, completion, or discard.
 */
export function restorableResourceBuildJob<
  T extends Pick<ResourceBuildJobSnapshot, "jobId" | "startedAt" | "status" | "discarded">,
>(jobs: readonly T[]): T | undefined {
  const newest = newestResourceBuildJob(jobs);
  return newest && isRecoverableResourceBuildJob(newest) ? newest : undefined;
}
