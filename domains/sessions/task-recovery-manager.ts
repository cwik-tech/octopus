import { whenDefined } from "../../core/optional-properties.js"
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RunPlan } from "../../contracts/run-plan.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  intentRecordSchema,
  ownedProcessScopeFolders,
  readScopeRecord,
} from "../../core/owned-processes/owned-process-records.js";
import { ownedProcessScopePath } from "../../core/owned-processes/owned-process-scope.js";
import {
  isPathInside,
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import {
  markRunPlanTerminal,
} from "../run-orchestrator/orchestrator.js";
import {
  buildSessionRunAssignmentLocation,
} from "../run/run-location.js";
import {
  getRunRuntimePaths,
  resolveAssignmentPath,
} from "../runtime/runtime-paths.js";
import {
  buildArtifactMetadata,
  parseMarkdownArtifact,
  publishMarkdownArtifactWrittenEvent,
  withArtifactFrontmatter,
} from "../runtime/artifacts.js";
import { logRuntimeEvent } from "../runtime/logger.js";
import {
  closeTaskOwnedProcesses,
  taskOwnedProcessesClosed,
} from "./task-owned-processes.js";
import { resolveWorkflowJournalRecorder } from "../../services/workflow-journal-recorder.js";
import { reportWorkflowJournalDivergence } from "../../services/workflow-journal-divergence.js";
import type { WorkspaceExecutionJournalRegistry } from "../../services/workspace-execution-journal-registry.js";
import {
  isActiveTaskStatus,
  isExecutingTaskStatus,
  isTerminalTaskStatus,
  isValidSessionId,
  type ChatDeliveryArtifact,
  type ChatMessage,
  type ChatMessageSpeaker,
  type ChatOutcomeStatus,
  type SessionStatus,
  type SessionSummary,
  type SessionTask,
  type TaskStatus,
} from "./session-types.js";
import {
  taskProcessTarget,
  terminateTaskProcess,
  type LocatedTaskProcess,
  type TaskProcessIdentityClassification,
} from "./task-process-supervisor.js";
import {
  isTerminalRunPlanStatus,
  taskAdmissionFence,
  taskStatusToRunPlanStatus,
} from "./run-plan-helpers.js";
import type {
  SessionTaskPatch,
  TaskRecordCompareAndSetOptions,
  TaskRecordCompareAndSetResult,
} from "./session-task-repository.js";
import {
  FileSystemWorkflowStateStore,
  classifyWorkflowRecoveryWithReceipts,
  hashWorkflowContent,
  terminalTaskStatusForWorkflow,
  verifyWorkflowArtifactReference,
} from "../../workflows/workflow-state-store.js";
import { buildDurableWorkflowTerminalOutcome } from "../../workflows/results.js";
import type {
  DurableWorkflowState,
  DurableWorkflowTerminalOutcome,
  WorkflowPublishedArtifactReference,
} from "../../workflows/types.js";

export interface TaskRecoveryTaskPort {
  get(
    sessionId: string,
    taskId: string,
  ): Promise<SessionTask | null>;
  list(sessionId: string): Promise<SessionTask[]>;
  compareAndSet(
    sessionId: string,
    taskId: string,
    expectedStatuses: readonly TaskStatus[],
    patch: SessionTaskPatch,
    options?: TaskRecordCompareAndSetOptions,
  ): Promise<TaskRecordCompareAndSetResult | null>;
}

export interface TaskRecoveryPlanPort {
  read(sessionId: string): Promise<RunPlan | null>;
  path(sessionId: string): string;
}

export interface TaskRecoveryPort {
  readonly tasks: TaskRecoveryTaskPort;
  readonly plans: TaskRecoveryPlanPort;
  workspacePath(): string;
  metadataPath(sessionId: string): string;
  sessionLockPath(sessionId: string): string;
  readMetadata(sessionId: string): Promise<SessionSummary | null>;
  writeMetadata(summary: SessionSummary): Promise<void>;
  listChatMessages(sessionId: string): Promise<ChatMessage[]>;
  appendChatMessage(
    sessionId: string,
    message: ChatMessage,
  ): Promise<boolean>;
  withFileLock<T>(
    lockPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  now(): Date;
  ownsProcess(task: SessionTask): boolean;
  isProcessAlive(pid: number): boolean;
  hasValidProcessIdentity(task: SessionTask): boolean;
  findProcessByIdentity(
    processIdentity: string,
  ): LocatedTaskProcess | null;
  /** Every live process carrying the identity marker: none, one, or several. */
  classifyProcessesByIdentity(
    processIdentity: string,
  ): TaskProcessIdentityClassification;
  configuredProviderBrokerIdentity(): string | undefined;
  staleTaskGraceMs(): number;
  /**
   * The workspace journal registry, when the process has one. Terminal
   * reconciliation rewrites authoritative workflow state, so for an enrolled
   * assignment it has to go through the canonical journal rather than
   * straight into the projection (ADR §9).
   */
  executionJournalRegistry(): WorkspaceExecutionJournalRegistry | undefined;
}

/** Whether a cancelled task's process is known to be gone, and why not. */
type CancelledTaskProcessCleanup =
  | { readonly kind: "stopped" }
  | {
      readonly kind: "unverified";
      readonly reason:
        | "ambiguous_marker"
        | "marker_unconfirmed"
        | "unverified_live_process"
        | "termination_unconfirmed";
    };

export interface VerifiedTaskArtifact {
  readonly role: "primary" | "secondary";
  readonly childRunId: string;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type BatchTaskPublicationResolution =
  | { readonly status: "ready"; readonly artifacts: readonly VerifiedTaskArtifact[] }
  | {
      readonly status: "failed";
      readonly code: "verified_publication_missing" | "verified_publication_invalid";
      readonly detail: string;
    };

export class TaskRecoveryManager {
  constructor(private readonly port: TaskRecoveryPort) {}

  async reconcileSession(sessionId: string): Promise<SessionTask[]> {
    if (!isValidSessionId(sessionId)) return [];
    if (!existsSync(this.port.metadataPath(sessionId))) return [];
    const tasks = await this.port.tasks.list(sessionId);
    for (const task of tasks) {
      await this.reconcileTaskRecord(sessionId, task.id, task);
    }
    await this.recomputeSessionLifecycle(sessionId);
    return this.port.tasks.list(sessionId);
  }

  async resolveTaskPublication(
    sessionId: string,
    taskId: string,
    executionAttemptId: string,
  ): Promise<BatchTaskPublicationResolution> {
    const task = await this.port.tasks.get(sessionId, taskId);
    if (!task || task.sessionId !== sessionId || task.id !== taskId) {
      return publicationFailure(
        "verified_publication_invalid",
        "Task publication identity does not match the requested task.",
      );
    }
    if (task.executionAttemptId !== executionAttemptId) {
      return publicationFailure(
        "verified_publication_invalid",
        "Task publication identity does not match the requested execution attempt.",
      );
    }
    if (task.status !== "done" || !task.assignmentPath || !isSafePathSegment(executionAttemptId)) {
      return publicationFailure(
        "verified_publication_invalid",
        "Task publication is not a completed task with a valid assignment.",
      );
    }
    try {
      await this.repairTerminalTaskResult(task);
      const markerPath = path.join(
        getRunRuntimePaths(task.assignmentPath).privateRuntimePath,
        "task-results",
        `${executionAttemptId}.published.json`,
      );
      const lockPath = path.join(
        path.dirname(markerPath),
        `${executionAttemptId}.publication.lock`,
      );
      return await this.port.withFileLock(lockPath, async () => {
        const stat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat) {
          return publicationFailure(
            "verified_publication_missing",
            "Verified task publication marker is missing after terminal repair.",
          );
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
          return publicationFailure(
            "verified_publication_invalid",
            "Verified task publication marker is not an owned regular file.",
          );
        }
        try {
          const artifacts = parseTaskPublicationMarker(
            JSON.parse(await fs.readFile(markerPath, "utf8")),
            { taskId, executionAttemptId },
          );
          return { status: "ready" as const, artifacts };
        } catch (error) {
          return publicationFailure(
            "verified_publication_invalid",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    } catch (error) {
      return publicationFailure(
        "verified_publication_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async reconcileTaskRecord(
    sessionId: string,
    taskId: string,
    knownTask?: SessionTask,
    allowAdmission = false,
  ): Promise<void> {
    let task = knownTask ?? (await this.port.tasks.get(sessionId, taskId));
    if (!task) return;
    if (isTerminalTaskStatus(task.status)) {
      let rootGone = true;
      if (task.status === "cancelled") {
        const cleanup = await this.cleanupCancelledTaskProcess(
          sessionId,
          task,
        );
        task = (await this.port.tasks.get(sessionId, taskId)) ?? task;
        rootGone = cleanup.kind === "stopped";
      }
      // A terminal task that still holds a slot, by its admission or by a
      // recorded hold, releases it only once its attempt's descendants are
      // verified gone, whatever its status.
      if (
        rootGone &&
        (task.admission !== undefined || task.processCleanupHold !== undefined)
      ) {
        const held = await this.holdUnlessOwnedProcessesClosed(sessionId, task);
        if (held === null) return;
        task = held;
      }
      // A child's attempt folder is its working space and holds the
      // attempt's copy of the user's Pi credentials, so it is removed only
      // once the root is gone and the attempt's owned processes are verified
      // gone: its scope closed, which for a task whose slot is already
      // released is closed here. Any finished status: a step abandoned over
      // a held subtree keeps its folder until then.
      if (rootGone && (await this.ownedProcessesVerifiedGone(task))) {
        await this.cleanupTaskTemporaryPaths(task);
      }
      await this.reconcileAuthoritativeTerminalWorkflowJournal(task);
      await this.tryRepairTerminalTaskResult(task);
      return;
    }
    if (task.processCleanupHold !== undefined) {
      // Held before: nothing below may reconcile the task or release its
      // slot until its descendants are verified gone.
      const released = await this.holdUnlessOwnedProcessesClosed(sessionId, task);
      if (released === null) return;
      task = released;
    }
    if (task.admission && !allowAdmission) {
      // Queue startup and dispatch own admission-aware recovery.
      return;
    }
    if (task.status === "interrupted") {
      // A previous attempt whose descendants cannot be verified gone (one an
      // earlier version launched without a scope, for one) is held, so no
      // resume, automatic or manual, starts the next attempt beside them
      // (ADR section 7). Nothing is signalled that cannot be verified.
      if (!(await taskOwnedProcessesClosed(task, this.port.workspacePath()))) {
        const held = await this.holdUnlessOwnedProcessesClosed(sessionId, task);
        if (held === null) return;
        task = held;
      }
      await this.reconcileDeadTaskFromWorkflowJournal({
        sessionId,
        task,
        recoveredQueuedWorker: false,
      });
      return;
    }
    if (
      task.status === "awaiting_input" ||
      task.status === "awaiting_model_choice"
    ) {
      // A wait is not an interruption. Re-admitting it would restart work the
      // user has not authorized — for a model choice, on a model they were
      // only ever asked about.
      await this.reconcileDeadTaskFromWorkflowJournal({
        sessionId,
        task,
        recoveredQueuedWorker: false,
      });
      return;
    }
    if (!isExecutingTaskStatus(task.status)) return;
    if (
      task.status === "queued" &&
      !task.executionAttemptId &&
      taskProcessTarget(task) == null
    ) {
      // Startup recovery owns the pre-reservation launch window.
      return;
    }

    const ageMs = Math.max(
      0,
      this.port.now().getTime() - taskTimestamp(task).getTime(),
    );
    const restarted = !this.port.ownsProcess(task);
    let processTarget = taskProcessTarget(task);
    let recoveredQueuedWorker = false;

    if (restarted && processTarget == null && task.processIdentity) {
      const located = this.port.findProcessByIdentity(task.processIdentity);
      if (located) {
        const attached = await this.port.tasks.compareAndSet(
          sessionId,
          taskId,
          ["queued", "running"],
          {
            pid: located.pid,
            ...whenDefined(located.processGroupId, (definedValue) => ({ processGroupId: definedValue })),
          },
        );
        if (!attached || isTerminalTaskStatus(attached.task.status)) return;
        task = attached.task;
        processTarget = taskProcessTarget(task);
      }
    }

    let processIsAlive =
      processTarget != null && this.port.isProcessAlive(processTarget);
    let processIdentityMatches =
      processIsAlive && this.port.hasValidProcessIdentity(task);
    let configuredProviderBrokerChanged = false;
    const orphanedManagedProcessGroup = Boolean(
      restarted &&
        processIsAlive &&
        !processIdentityMatches &&
        process.platform !== "win32" &&
        task.pid &&
        task.processGroupId &&
        task.pid === task.processGroupId &&
        !this.port.isProcessAlive(task.pid),
    );
    if (orphanedManagedProcessGroup) {
      const termination = await terminateTaskProcess(task, {
        isProcessAlive: (pid) => this.port.isProcessAlive(pid),
        isProcessIdentityValid: () => true,
      });
      if (termination !== "exited") return;
      processIsAlive = false;
      processIdentityMatches = false;
    }
    if (
      restarted &&
      processIdentityMatches &&
      task.configuredProviderBrokerIdentity &&
      task.configuredProviderBrokerIdentity !==
        this.port.configuredProviderBrokerIdentity()
    ) {
      const termination = await terminateTaskProcess(task, {
        isProcessAlive: (pid) => this.port.isProcessAlive(pid),
        isProcessIdentityValid: (candidate) =>
          this.port.hasValidProcessIdentity(candidate),
      });
      if (termination !== "exited") return;
      processIsAlive = false;
      processIdentityMatches = false;
      configuredProviderBrokerChanged = true;
      recoveredQueuedWorker = task.status === "queued";
    }
    if (restarted && processIsAlive && !processIdentityMatches) return;
    if (restarted && processIdentityMatches) {
      if (task.status === "running") return;
      const termination = await terminateTaskProcess(task, {
        isProcessAlive: (pid) => this.port.isProcessAlive(pid),
        isProcessIdentityValid: (candidate) =>
          this.port.hasValidProcessIdentity(candidate),
      });
      if (termination !== "exited") return;
      processIsAlive = false;
      recoveredQueuedWorker = true;
    }
    // The owner reconciles its own task as dead only once the recorded target
    // is gone (kill(target, 0) fails with ESRCH). The target is the process
    // group when one is recorded (taskProcessTarget), so a group whose leader
    // has exited stays live while any member runs. A live target whose
    // identity cannot be verified keeps the task as it is: status, pid,
    // processGroupId, processIdentity and granted admission. A later pass
    // tries again. There is no age limit: elapsed time plus failed identity
    // probes does not prove the worker dead, and clearing the record while it
    // may still run detaches the worker and lets a resume run beside it. This
    // path never signals a process it cannot verify, descendants included.
    // The probe answers false both when ps cannot be read and when ps shows no
    // marker in the group, and both keep the task.
    //
    // Limitation: a live group that is not the worker (a reused PID, or a
    // confirmed identity mismatch) keeps the task and its slot until the group
    // exits, unless a cancel can recover the real worker. TaskQueue sees a
    // live, unverified grant and reserves nothing new in the workspace
    // (dispatch_blocked, ambiguous_process_identity). Cancel sets the task
    // cancelled, which fences the attempt, but terminateTaskProcess refuses an
    // unverified target, so cancelSessionTask throws "process cleanup remains
    // pending" before it releases the admission. If the task's identity marker
    // matches exactly one live process elsewhere, TaskQueue still routes the
    // cancelled task here, and cleanupCancelledTaskProcess moves the record to
    // that worker, stops it once verified and releases the grant without
    // signalling the process at the old PID. With no unique match the queue
    // does not route it, and the grant is released only after the recorded
    // group exits.
    if (
      !restarted &&
      (ageMs < this.port.staleTaskGraceMs() || processIsAlive)
    ) {
      return;
    }

    // The root is gone. Its attempt's descendants run in their own process
    // groups, so the task is reconciled, and its slot released, only once
    // they are verified gone.
    const released = await this.holdUnlessOwnedProcessesClosed(sessionId, task);
    if (released === null) return;
    task = released;

    if (
      await this.reconcileDeadTaskFromWorkflowJournal({
        sessionId,
        task,
        recoveredQueuedWorker,
      })
    ) {
      return;
    }

    // No target is live here. A restarted task with a live target returned
    // above or was terminated first, and an owned one returned at the guard.
    const failed = await this.port.tasks.compareAndSet(
      sessionId,
      taskId,
      ["queued", "running"],
      {
        status: "failed",
        admission: undefined,
        completedAt: this.port.now().toISOString(),
        error: restarted
          ? configuredProviderBrokerChanged
            ? "Task worker used an obsolete configured-provider broker after a service restart"
            : recoveredQueuedWorker
              ? "Task startup was interrupted by a service restart; the recovered worker was terminated"
              : "Task process exited during a service restart"
          : "Task process exited before reporting a terminal status",
      },
      taskAdmissionFence(task),
    );
    if (failed?.updated && failed.task.assignmentPath) {
      logRuntimeEvent(failed.task.assignmentPath, {
        timestamp: failed.task.completedAt ?? this.port.now().toISOString(),
        event: "run.failed",
        session_id: failed.task.runId,
        root_session_id: failed.task.runId,
        assignment_path: failed.task.assignmentPath,
        team: `workflow:${failed.task.workflowId}`,
        workflow_id: failed.task.workflowId,
        product_session_id: failed.task.sessionId,
        task_id: failed.task.id,
        error: failed.task.error,
      });
    }
  }

  private async reconcileDeadTaskFromWorkflowJournal(params: {
    sessionId: string;
    task: SessionTask;
    recoveredQueuedWorker: boolean;
  }): Promise<boolean> {
    const assignmentPath = params.task.assignmentPath;
    if (!assignmentPath) return false;

    let expectedAssignmentPath: string;
    try {
      expectedAssignmentPath = this.resolveCanonicalTaskAssignmentPath(
        params.task,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failUnrecoverableTask(
        params.sessionId,
        params.task,
        `Run assignment ownership is invalid: ${message}`,
      );
      return true;
    }
    if (path.resolve(assignmentPath) !== expectedAssignmentPath) {
      await this.failUnrecoverableTask(
        params.sessionId,
        params.task,
        "Persisted assignment path does not match the task's canonical run path.",
      );
      return true;
    }

    // `workflow-state.json` is a projection of the canonical journal for an
    // enrolled assignment, so recovery reads it through the journal: a
    // projection that is missing, unreadable, or behind is rebuilt rather than
    // treated as an unrecoverable execution (ADR §9, AC9). An unenrolled
    // assignment resolves no recorder and keeps failing closed.
    let journalOptions;
    try {
      journalOptions = await resolveWorkflowJournalRecorder({
        registry: this.port.executionJournalRegistry(),
        task: params.task,
        requestId: `recover-${params.task.status}-${params.task.id}`,
        processIdentity: params.task.executionAttemptId ?? params.task.id,
      });
    } catch (error) {
      // The authority is enrolled but unavailable. Recording a verdict now
      // would decide this task's fate from evidence recovery could not read,
      // so the task is left exactly as it is for a later sweep.
      this.logTaskRecoveryFailure(
        params.task,
        "run.workflow_journal_unavailable",
        error,
      );
      return true;
    }

    let snapshot;
    try {
      snapshot = await new FileSystemWorkflowStateStore(
        assignmentPath,
        journalOptions,
      ).load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failUnrecoverableTask(
        params.sessionId,
        params.task,
        `Durable workflow state is corrupt or incompatible: ${message}`,
      );
      return true;
    }

    if (!snapshot) {
      if (
        params.task.status === "queued" &&
        params.task.executionAttemptId &&
        params.task.executionAttemptNumber
      ) {
        await this.interruptRecoverableTask(
          params.sessionId,
          params.task,
          "automatic",
          params.recoveredQueuedWorker
            ? "Task startup was interrupted by a service restart before the workflow journal was initialized."
            : "Task process exited before the workflow journal was initialized.",
        );
        return true;
      }
      return false;
    }

    if (
      snapshot.manifest.taskId !== params.task.id ||
      snapshot.manifest.sessionId !== params.task.sessionId ||
      snapshot.manifest.rootRunId !== params.task.runId ||
      snapshot.manifest.workflowId !== params.task.workflowId
    ) {
      await this.failUnrecoverableTask(
        params.sessionId,
        params.task,
        "Durable workflow identity does not match the persisted task.",
      );
      return true;
    }

    if (snapshot.state.status === "awaiting_input") {
      await this.restoreAwaitingHumanInputTask(
        params.sessionId,
        params.task,
      );
      return true;
    }

    if (snapshot.state.status === "awaiting_model_choice") {
      // The durable workflow is the authority. A crash between committing the
      // wait and recording it on the task leaves the task saying `running`,
      // and ordinary recovery would read that as interrupted work and admit a
      // worker — restarting the very step the run is waiting to be told how to
      // run. The wait is restored instead, with no worker.
      await this.restoreAwaitingModelChoiceTask(params.sessionId, params.task);
      return true;
    }

    if (snapshot.state.agentQuestions?.interactions.some((interaction) =>
      interaction.status === 'resuming' && interaction.continuation.providerStartedAt)) {
      snapshot = await new FileSystemWorkflowStateStore(assignmentPath, journalOptions)
        .blockIndeterminateAgentContinuation(snapshot.state.ownerExecutionAttemptId)
    }
    const terminalStatus = terminalTaskStatusForWorkflow(
      snapshot.state.status,
    );
    if (terminalStatus) {
      const outcome = snapshot.state.terminalOutcome;
      if (!outcome) {
        await this.failUnrecoverableTask(
          params.sessionId,
          params.task,
          "Terminal workflow journal has no durable publication outcome.",
        );
        return true;
      }
      try {
        await this.verifyWorkflowOutcomeArtifacts(params.task, outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.failUnrecoverableTask(
          params.sessionId,
          params.task,
          `Terminal workflow artifact is missing or invalid: ${message}`,
        );
        return true;
      }
      const completedAt = snapshot.state.updatedAt;
      const repaired = await this.port.tasks.compareAndSet(
        params.sessionId,
        params.task.id,
        ["queued", "running", "interrupted", "awaiting_input", "awaiting_model_choice"],
        {
          status: terminalStatus,
          admission: undefined,
          completedAt,
          pid: undefined,
          processGroupId: undefined,
          ...whenDefined(terminalStatus === "failed" || terminalStatus === "blocked"
              ? outcome.summary
              : undefined, (definedValue) => ({ error: definedValue })),
        },
        taskAdmissionFence(params.task),
      );
      if (repaired?.updated) {
        logRuntimeEvent(assignmentPath, {
          timestamp: completedAt,
          event:
            terminalStatus === "done"
              ? "run.completed"
              : `run.${terminalStatus}`,
          session_id: params.task.runId,
          root_session_id: params.task.runId,
          assignment_path: assignmentPath,
          team: `workflow:${params.task.workflowId}`,
          workflow_id: params.task.workflowId,
          product_session_id: params.task.sessionId,
          task_id: params.task.id,
          execution_attempt_id: params.task.executionAttemptId,
          recovered_from_journal: true,
        });
      }
      return true;
    }

    let recovery;
    try {
      recovery = await classifyWorkflowRecoveryWithReceipts(
        assignmentPath,
        snapshot,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failUnrecoverableTask(
        params.sessionId,
        params.task,
        `Durable workflow receipt is corrupt or incompatible: ${message}`,
      );
      return true;
    }
    await this.interruptRecoverableTask(
      params.sessionId,
      params.task,
      recovery.disposition,
      recovery.reason,
    );
    return true;
  }

  /**
   * A persisted human-input pause has no worker to recover. Keep the task
   * submit-able even when a process died just before or after suspension.
   */
  /**
   * Restores a model-choice wait from the durable workflow.
   *
   * Separate from the human-input restorer on purpose: one wait is for content
   * a person writes and the other for a decision about how to run, and a task
   * left in the wrong one would be answerable by the wrong route.
   */
  private async restoreAwaitingModelChoiceTask(
    sessionId: string,
    task: SessionTask,
  ): Promise<void> {
    const alreadyWaiting =
      task.status === "awaiting_model_choice" &&
      task.admission === undefined &&
      task.pid === undefined &&
      task.processGroupId === undefined &&
      task.processIdentity === undefined &&
      task.recoveryDisposition === undefined &&
      task.recoveryReason === undefined &&
      task.error === undefined;
    if (alreadyWaiting) return;

    const waitingAt = this.port.now().toISOString();
    const restored = await this.port.tasks.compareAndSet(
      sessionId,
      task.id,
      ["queued", "running", "interrupted", "awaiting_model_choice"],
      {
        status: "awaiting_model_choice",
        admission: undefined,
        pid: undefined,
        processGroupId: undefined,
        processIdentity: undefined,
        workerStartedAt: undefined,
        interruptedAt: undefined,
        recoveryDisposition: undefined,
        recoveryReason: undefined,
        error: undefined,
      },
      taskAdmissionFence(task),
    );
    if (restored?.updated && task.assignmentPath) {
      logRuntimeEvent(task.assignmentPath, {
        timestamp: waitingAt,
        event: "run.awaiting_model_choice",
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: task.assignmentPath,
        team: `workflow:${task.workflowId}`,
        workflow_id: task.workflowId,
        product_session_id: task.sessionId,
        task_id: task.id,
        execution_attempt_id: task.executionAttemptId,
        recovered_from_journal: true,
      });
    }
  }

  private async restoreAwaitingHumanInputTask(
    sessionId: string,
    task: SessionTask,
  ): Promise<void> {
    const alreadyWaiting =
      task.status === "awaiting_input" &&
      task.admission === undefined &&
      task.pid === undefined &&
      task.processGroupId === undefined &&
      task.processIdentity === undefined &&
      task.recoveryDisposition === undefined &&
      task.recoveryReason === undefined &&
      task.error === undefined;
    if (alreadyWaiting) return;

    const waitingAt = this.port.now().toISOString();
    const restored = await this.port.tasks.compareAndSet(
      sessionId,
      task.id,
      ["queued", "running", "interrupted", "awaiting_input", "awaiting_model_choice"],
      {
        status: "awaiting_input",
        admission: undefined,
        pid: undefined,
        processGroupId: undefined,
        processIdentity: undefined,
        workerStartedAt: undefined,
        interruptedAt: undefined,
        recoveryDisposition: undefined,
        recoveryReason: undefined,
        error: undefined,
      },
      taskAdmissionFence(task),
    );
    if (restored?.updated && task.assignmentPath) {
      logRuntimeEvent(task.assignmentPath, {
        timestamp: waitingAt,
        event: "run.awaiting_input",
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: task.assignmentPath,
        team: `workflow:${task.workflowId}`,
        workflow_id: task.workflowId,
        product_session_id: task.sessionId,
        task_id: task.id,
        execution_attempt_id: task.executionAttemptId,
        recovered_from_journal: true,
      });
    }
  }

  /**
   * The task, with any hold cleared, once its attempt's descendants are
   * verified gone; otherwise null, after recording why it is held. A held
   * task keeps its status, admission and process record, and nothing is
   * signalled that cannot be verified.
   */
  private async holdUnlessOwnedProcessesClosed(
    sessionId: string,
    task: SessionTask,
  ): Promise<SessionTask | null> {
    const cleanup = await closeTaskOwnedProcesses(
      task,
      this.port.workspacePath(),
      "recovery",
    );
    if (cleanup.kind === "closed") {
      if (task.processCleanupHold === undefined) return task;
      const cleared = await this.port.tasks.compareAndSet(
        sessionId,
        task.id,
        [task.status],
        { processCleanupHold: undefined },
        taskAdmissionFence(task),
      );
      return cleared?.updated ? cleared.task : null;
    }
    const existing = task.processCleanupHold;
    if (existing?.reason === cleanup.reason && existing.detail === cleanup.detail) {
      return null;
    }
    const since = existing?.reason === cleanup.reason
      ? existing.since
      : this.port.now().toISOString();
    const held = await this.port.tasks.compareAndSet(
      sessionId,
      task.id,
      [task.status],
      { processCleanupHold: { reason: cleanup.reason, detail: cleanup.detail, since } },
      taskAdmissionFence(task),
    );
    if (held?.updated && task.assignmentPath && existing?.reason !== cleanup.reason) {
      logRuntimeEvent(task.assignmentPath, {
        timestamp: since,
        event: "run.process_cleanup_held",
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: task.assignmentPath,
        team: `workflow:${task.workflowId}`,
        workflow_id: task.workflowId,
        product_session_id: task.sessionId,
        task_id: task.id,
        execution_attempt_id: task.executionAttemptId,
        reason: cleanup.reason,
      });
    }
    return null;
  }

  private async interruptRecoverableTask(
    sessionId: string,
    task: SessionTask,
    disposition: "automatic" | "manual" | "not_resumable",
    reason: string,
  ): Promise<void> {
    const interruptedAt = this.port.now().toISOString();
    const interrupted = await this.port.tasks.compareAndSet(
      sessionId,
      task.id,
      // Deliberately not `awaiting_model_choice`. Interrupting a wait makes it
      // automatically recoverable, and automatic recovery re-admits it — which
      // would restart work on a model the user was only ever *asked* about.
      // A wait ends by being approved, abandoned, or cancelled.
      ["queued", "running", "awaiting_input"],
      {
        status: "interrupted",
        admission: undefined,
        interruptedAt,
        pid: undefined,
        processGroupId: undefined,
        recoveryDisposition: disposition,
        recoveryReason: reason,
        error: undefined,
      },
      taskAdmissionFence(task),
    );
    if (interrupted?.updated && task.assignmentPath) {
      logRuntimeEvent(task.assignmentPath, {
        timestamp: interruptedAt,
        event: "run.interrupted",
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: task.assignmentPath,
        team: `workflow:${task.workflowId}`,
        workflow_id: task.workflowId,
        product_session_id: task.sessionId,
        task_id: task.id,
        execution_attempt_id: task.executionAttemptId,
        recovery_disposition: disposition,
        recovery_reason: reason,
      });
    }
  }

  private async failUnrecoverableTask(
    sessionId: string,
    task: SessionTask,
    reason: string,
  ): Promise<void> {
    const completedAt = this.port.now().toISOString();
    const failed = await this.port.tasks.compareAndSet(
      sessionId,
      task.id,
      ["queued", "running", "interrupted", "awaiting_input", "awaiting_model_choice"],
      {
        status: "failed",
        admission: undefined,
        completedAt,
        pid: undefined,
        processGroupId: undefined,
        recoveryDisposition: "not_resumable",
        recoveryReason: reason,
        error: reason,
      },
      taskAdmissionFence(task),
    );
    if (failed?.updated && task.assignmentPath) {
      logRuntimeEvent(task.assignmentPath, {
        timestamp: completedAt,
        event: "run.failed",
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: task.assignmentPath,
        team: `workflow:${task.workflowId}`,
        workflow_id: task.workflowId,
        product_session_id: task.sessionId,
        task_id: task.id,
        execution_attempt_id: task.executionAttemptId,
        error: reason,
      });
    }
  }

  /**
   * Finish process cleanup if the service died after persisting cancellation.
   * `stopped` only when no process that may still run the task is alive; a
   * process that cannot be verified as the task's own is never signalled.
   */
  private async cleanupCancelledTaskProcess(
    sessionId: string,
    task: SessionTask,
  ): Promise<CancelledTaskProcessCleanup> {
    let processTask = task;
    let processTarget = taskProcessTarget(processTask);
    let processIsAlive =
      processTarget != null && this.port.isProcessAlive(processTarget);
    let processIdentityMatches =
      processIsAlive && this.port.hasValidProcessIdentity(processTask);
    if (
      processTask.processIdentity &&
      (processTarget == null || !processIsAlive || !processIdentityMatches)
    ) {
      const located = this.port.findProcessByIdentity(
        processTask.processIdentity,
      );
      if (located) {
        const attached = await this.port.tasks.compareAndSet(
          sessionId,
          processTask.id,
          ["cancelled"],
          {
            pid: located.pid,
            ...whenDefined(located.processGroupId, (definedValue) => ({ processGroupId: definedValue })),
          },
          processTask.executionAttemptId
            ? { expectedExecutionAttemptId: processTask.executionAttemptId }
            : undefined,
        );
        processTask = attached?.task ?? processTask;
        processTarget = taskProcessTarget(processTask);
        processIsAlive =
          processTarget != null && this.port.isProcessAlive(processTarget);
        processIdentityMatches =
          processIsAlive && this.port.hasValidProcessIdentity(processTask);
      } else {
        // No unique process was found. A fresh look that still finds any
        // process carrying the marker (several, or one that appeared since)
        // leaves none verified as the task's own, so nothing shows the
        // attempt stopped; the queue's next pass looks again.
        const recheck = this.port.classifyProcessesByIdentity(
          processTask.processIdentity,
        );
        if (recheck.kind !== "absent") {
          return {
            kind: "unverified",
            reason:
              recheck.kind === "ambiguous"
                ? "ambiguous_marker"
                : "marker_unconfirmed",
          };
        }
      }
    }

    if (processTarget != null && processIsAlive) {
      if (!processIdentityMatches) {
        return { kind: "unverified", reason: "unverified_live_process" };
      }
      const termination = await terminateTaskProcess(processTask, {
        isProcessAlive: (pid) => this.port.isProcessAlive(pid),
        isProcessIdentityValid: (candidate) =>
          this.port.hasValidProcessIdentity(candidate),
      });
      if (termination !== "exited") {
        return { kind: "unverified", reason: "termination_unconfirmed" };
      }
    }

    if (
      processTask.pid !== undefined ||
      processTask.processGroupId !== undefined
    ) {
      await this.port.tasks.compareAndSet(
        sessionId,
        processTask.id,
        ["cancelled"],
        { pid: undefined, processGroupId: undefined },
        processTask.executionAttemptId
          ? { expectedExecutionAttemptId: processTask.executionAttemptId }
          : undefined,
      );
    }
    return { kind: "stopped" };
  }

  /**
   * Whether the attempt's owned processes are verified gone, closing its
   * scope if it is not closed yet. Nothing unverifiable is signalled, and an
   * error counts as not verified.
   */
  private async ownedProcessesVerifiedGone(task: SessionTask): Promise<boolean> {
    try {
      const cleanup = await closeTaskOwnedProcesses(
        task,
        this.port.workspacePath(),
        "recovery",
      );
      return cleanup.kind === "closed";
    } catch (error) {
      this.logTaskRecoveryFailure(task, "run.owned_process_cleanup_failed", error);
      return false;
    }
  }

  private async cleanupTaskTemporaryPaths(task: SessionTask): Promise<void> {
    if (!task.assignmentPath) return;
    try {
      const snapshot = await new FileSystemWorkflowStateStore(
        task.assignmentPath,
      ).load();
      for (const step of snapshot?.state.steps ?? []) {
        const childAssignmentPath = this.resolveTaskChildAssignmentPath(
          task,
          step.childRunId,
        );
        const temporaryPath =
          getRunRuntimePaths(childAssignmentPath).temporaryPath;
        const stat = await fs.lstat(temporaryPath).catch(() => null);
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(
            `Temporary path for child '${step.childRunId}' is not an owned directory.`,
          );
        }
        await fs.rm(temporaryPath, { recursive: true, force: true });
      }
    } catch (error) {
      this.logTaskRecoveryFailure(
        task,
        "run.temporary_cleanup_failed",
        error,
      );
    }
    await this.cleanupOwnedTeamTemporaryPaths(task);
  }

  /**
   * Removes the attempt folders of every Team the attempt's own scope
   * records, nested Teams included. A nested Team's folder sits beside the
   * steps' in the run, and only its spawner, inside a step's child, removes
   * it, so a terminated child leaves it with its credential copy. Called only
   * once the scope is verified closed, so every Team it records has ended.
   *
   * The paths come from records on disk, so a folder is removed only when
   * its real path is exactly where the product puts it, below the real
   * workspace with no link on the way. Anything else, or an intent that
   * cannot be read, keeps the folder and is logged; nothing here fails the
   * recovery.
   */
  private async cleanupOwnedTeamTemporaryPaths(task: SessionTask): Promise<void> {
    if (task.ownedProcessScope !== 1 || task.executionAttemptNumber === undefined) return;
    const intentsPath = ownedProcessScopeFolders(ownedProcessScopePath({
      workspacePath: this.port.workspacePath(),
      sessionId: task.sessionId,
      taskId: task.id,
      executionAttemptNumber: task.executionAttemptNumber,
    })).intents;
    let names: string[];
    try {
      names = (await fs.readdir(intentsPath)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      this.logTaskRecoveryFailure(task, "run.temporary_cleanup_failed", error);
      return;
    }
    for (const name of names) {
      try {
        const intent = await readScopeRecord({
          target: path.join(intentsPath, name),
          schema: intentRecordSchema,
        });
        if (intent.kind !== "present") {
          throw new Error(`Intent ${name} could not be read; its Team's folder is kept.`);
        }
        const { kind, childRunId } = intent.record;
        if (kind !== "team" || childRunId === null) continue;
        const temporaryPath = getRunRuntimePaths(
          this.resolveTaskChildAssignmentPath(task, childRunId),
        ).temporaryPath;
        const stat = await fs.lstat(temporaryPath).catch(() => null);
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(
            `Temporary path for Team '${childRunId}' is not an owned directory.`,
          );
        }
        const workspacePath = this.port.workspacePath();
        const canonicalPath = path.join(
          await fs.realpath(workspacePath),
          path.relative(workspacePath, temporaryPath),
        );
        if (
          !isPathInside(workspacePath, temporaryPath) ||
          (await fs.realpath(temporaryPath)) !== canonicalPath
        ) {
          throw new Error(
            `Temporary path for Team '${childRunId}' leads outside its run; it is kept.`,
          );
        }
        await fs.rm(canonicalPath, { recursive: true, force: true });
      } catch (error) {
        this.logTaskRecoveryFailure(task, "run.temporary_cleanup_failed", error);
      }
    }
  }

  /** Converge the journal when a terminal task won before its worker journal. */
  private async reconcileAuthoritativeTerminalWorkflowJournal(
    task: SessionTask,
  ): Promise<void> {
    if (
      !task.assignmentPath ||
      (task.status !== "cancelled" && task.status !== "failed")
    ) {
      return;
    }
    try {
      // Both convergences rewrite authoritative workflow state, so both go
      // through the canonical journal when the assignment is enrolled.
      const store = new FileSystemWorkflowStateStore(
        task.assignmentPath,
        await resolveWorkflowJournalRecorder({
          registry: this.port.executionJournalRegistry(),
          task,
          requestId: `reconcile-${task.status}-${task.id}`,
          processIdentity: task.executionAttemptId ?? task.id,
        }),
      );
      if (task.status === "cancelled") {
        await store.cancelFromAuthoritativeTask({
          taskId: task.id,
          summary: task.error ?? "Cancelled by user",
          ...whenDefined(task.completedAt, (definedValue) => ({ completedAt: definedValue })),
        });
        return;
      }
      const snapshot = await store.load();
      if (
        !snapshot ||
        terminalTaskStatusForWorkflow(snapshot.state.status) !== null
      ) {
        return;
      }
      await store.update({
        expectedRevision: snapshot.state.revision,
        executionAttemptId: snapshot.state.ownerExecutionAttemptId,
        mutate: (state) => {
          const completedAt =
            task.completedAt ?? this.port.now().toISOString();
          const outputStep =
            state.steps.find((step) => step.stepId === state.currentStepId) ??
            state.steps.find(
              (step) =>
                ![
                  "completed",
                  "completed_with_warnings",
                  "blocked",
                  "failed",
                  "cancelled",
                ].includes(step.status),
            ) ??
            state.steps.at(-1);
          if (!outputStep) {
            throw new Error(
              "Workflow journal has no step to carry the failed outcome.",
            );
          }
          const workflowStatus = "failed" as const;
          const summary =
            task.error ??
            "Workflow worker failed before committing a terminal journal.";
          state.status = workflowStatus;
          delete state.currentStepId;
          if (
            ![
              "pending",
              "completed",
              "completed_with_warnings",
              "blocked",
              "failed",
              "cancelled",
            ].includes(outputStep.status) &&
            outputStep.attemptCount > 0
          ) {
            outputStep.status = workflowStatus;
            outputStep.summary = summary;
            outputStep.error = summary;
            outputStep.completedAt = completedAt;
          }
          state.terminalOutcome = buildDurableWorkflowTerminalOutcome({
            workflowId: state.workflowId,
            status: workflowStatus,
            summary,
            requestedResultType: outputStep.requestedResultType,
            outputStepId: outputStep.stepId,
          });
        },
      });
    } catch (error) {
      this.logTaskRecoveryFailure(
        task,
        "run.terminal_journal_repair_failed",
        error,
      );
      // The repair log says a reconciliation failed; it does not say the
      // durable record and the task record now disagree. That is a different
      // fact with a different reader, so it gets its own diagnostic and its
      // own place on the operator report (ADR §7, §9).
      await reportWorkflowJournalDivergence({
        assignmentPath: task.assignmentPath,
        taskId: task.id,
        site: "terminal-reconciliation",
        error,
      });
    }
  }

  private async repairTerminalTaskResult(task: SessionTask): Promise<void> {
    if (
      task.status === "cancelled" ||
      !task.assignmentPath ||
      !task.executionAttemptId ||
      !isSafePathSegment(task.executionAttemptId)
    ) {
      return;
    }
    const assignmentPath = task.assignmentPath;

    const resultPath = resolveRelativePathInside(
      task.assignmentPath,
      `workflow-${task.workflowId}-result.md`,
    );
    if (!resultPath) return;

    const runtimePaths = getRunRuntimePaths(task.assignmentPath);
    const candidateDirectory = path.join(
      runtimePaths.privateRuntimePath,
      "task-results",
    );
    const candidatePath = path.join(
      candidateDirectory,
      `${task.executionAttemptId}.md`,
    );
    const publicationMarkerPath = path.join(
      candidateDirectory,
      `${task.executionAttemptId}.published.json`,
    );
    const publicationLockPath = path.join(
      candidateDirectory,
      `${task.executionAttemptId}.publication.lock`,
    );

    const candidateDirectoryStat = await fs
      .lstat(candidateDirectory)
      .catch(() => null);
    if (
      candidateDirectoryStat &&
      (candidateDirectoryStat.isSymbolicLink() ||
        !candidateDirectoryStat.isDirectory())
    ) {
      throw new Error("Task result staging path is not an owned directory.");
    }

    await this.port.withFileLock(publicationLockPath, async () => {
      const snapshot = await new FileSystemWorkflowStateStore(
        assignmentPath,
      ).load();
      if (
        snapshot &&
        (snapshot.manifest.taskId !== task.id ||
          snapshot.manifest.sessionId !== task.sessionId ||
          snapshot.manifest.rootRunId !== task.runId ||
          snapshot.manifest.workflowId !== task.workflowId)
      ) {
        throw new Error(
          "Durable workflow identity does not match the terminal task.",
        );
      }
      // Ahead of the result artifact, because a run can stop before it has one
      // — no journal, or one left behind on a running step — and telling the
      // user it stopped must not depend on there being something to publish.
      // Idempotency comes from the chat itself, not from the publication
      // marker further down.
      if (task.status === "failed" || task.status === "blocked") {
        await this.appendOutcomeChatMessage(task, task.status, snapshot?.state);
      }
      const outcome = snapshot?.state.terminalOutcome;
      if (
        snapshot &&
        terminalTaskStatusForWorkflow(snapshot.state.status) !== task.status
      ) {
        throw new Error(
          "Durable workflow status does not match the terminal task.",
        );
      }
      const verifiedPublishedArtifacts = outcome
        ? await this.verifyWorkflowOutcomeArtifacts(task, outcome)
        : [];

      const metadata = buildArtifactMetadata({
        filePath: resultPath,
        rootDir: assignmentPath,
        artifactType: "result",
        artifactRole: outcome ? "wrapper" : "final",
        ...whenDefined(task.completedAt ?? task.updatedAt, (definedValue) => ({ createdAt: definedValue })),
        sessionId: task.runId,
        rootSessionId: task.runId,
        team: `workflow:${task.workflowId}`,
        status: outcome?.status ?? task.status,
        title: `Workflow result from ${task.workflowId}`,
      });
      const expectedCandidateContents = outcome
        ? withArtifactFrontmatter(metadata, outcome.rootWrapperBody)
        : undefined;

      const isValidTerminalArtifact = async (
        filePath: string,
      ): Promise<boolean> => {
        const stat = await fs.lstat(filePath).catch(() => null);
        if (!stat) return false;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(
            "Terminal task result must be an owned regular file.",
          );
        }
        if (!resolveExistingPathInside(assignmentPath, filePath)) {
          throw new Error(
            "Terminal task result resolves outside its assignment.",
          );
        }
        const contents = await fs.readFile(filePath, "utf8");
        const parsed = parseMarkdownArtifact(contents);
        if (!parsed.hasFrontmatter) return false;
        if (parsed.metadata.path !== path.basename(resultPath)) return false;
        if (!outcome) return true;
        const body = parsed.body.endsWith("\n")
          ? parsed.body.slice(0, -1)
          : parsed.body;
        return hashWorkflowContent(body) === outcome.rootWrapperSha256;
      };

      let resultIsValid = await isValidTerminalArtifact(resultPath);
      if (!resultIsValid) {
        let candidateIsValid = await isValidTerminalArtifact(candidatePath);
        if (!candidateIsValid && expectedCandidateContents) {
          await writeFileAtomic(
            candidatePath,
            Buffer.from(expectedCandidateContents, "utf8"),
          );
          candidateIsValid = true;
        }
        if (!candidateIsValid) return;

        const resultStat = await fs.lstat(resultPath).catch(() => null);
        if (resultStat?.isSymbolicLink()) {
          throw new Error("Public task result path is a symbolic link.");
        }
        if (resultStat) await fs.rm(resultPath, { force: true });
        await fs.rename(candidatePath, resultPath);
        resultIsValid = await isValidTerminalArtifact(resultPath);
      }
      if (!resultIsValid) return;

      await fs.rm(candidatePath, { force: true }).catch(() => undefined);
      const markerStat = await fs
        .lstat(publicationMarkerPath)
        .catch(() => null);
      if (markerStat?.isSymbolicLink()) {
        throw new Error(
          "Task result publication marker is a symbolic link.",
        );
      }
      if (markerStat && !markerStat.isFile()) {
        throw new Error(
          "Task result publication marker is not a regular file.",
        );
      }

      const resultSha256 = hashWorkflowContent(
        await fs.readFile(resultPath),
      );
      const markerArtifacts = verifiedPublishedArtifacts.map(
        ({ published }) => ({
          stepId: published.stepId,
          role: published.role,
          childRunId: published.artifact.childRunId,
          path: published.artifact.relativePath,
          sha256: published.artifact.sha256,
          byteLength: published.artifact.byteLength,
        }),
      );
      if (markerStat?.isFile()) {
        const existingMarker = await fs
          .readFile(publicationMarkerPath, "utf8")
          .then((value) => JSON.parse(value) as Record<string, unknown>)
          .catch(() => null);
        if (
          existingMarker?.schemaVersion === 2 &&
          existingMarker.taskId === task.id &&
          existingMarker.executionAttemptId === task.executionAttemptId &&
          existingMarker.resultSha256 === resultSha256 &&
          typeof existingMarker.publishedAt === "string" &&
          Number.isFinite(Date.parse(existingMarker.publishedAt)) &&
          JSON.stringify(existingMarker.artifacts) ===
            JSON.stringify(markerArtifacts)
        ) {
          return;
        }
      }

      publishMarkdownArtifactWrittenEvent(resultPath, metadata);
      if (task.status === "done" && outcome) {
        await this.appendDeliveryChatMessage(
          task,
          verifiedPublishedArtifacts,
        );
        const eventPayload = (
          published: WorkflowPublishedArtifactReference,
          sourcePath: string,
        ) => ({
          timestamp: task.completedAt ?? task.updatedAt,
          session_id: task.runId,
          root_session_id: task.runId,
          assignment_path: task.assignmentPath,
          team: `workflow:${task.workflowId}`,
          workflow_id: task.workflowId,
          artifact_run_id: published.artifact.childRunId,
          workflow_artifact_role: published.role,
          path: published.artifact.relativePath,
          source_path: sourcePath,
          artifact_type: "result",
          status: outcome.status,
          title:
            published.label ??
            (published.role === "primary"
              ? "Primary workflow artifact"
              : "Supporting workflow artifact"),
          media_type: published.mediaType,
          label: published.label,
          requested_result_type: outcome.requestedResultType,
          recovered_from_journal:
            snapshot?.state.ownerExecutionAttemptId !==
            task.executionAttemptId,
        });
        for (const { published, sourcePath } of verifiedPublishedArtifacts) {
          if (published.role !== "secondary") continue;
          logRuntimeEvent(assignmentPath, {
            event: "artifact.written",
            artifact_role: "secondary",
            ...eventPayload(published, sourcePath),
          });
        }
        const primary = verifiedPublishedArtifacts.find(
          ({ published }) => published.role === "primary",
        );
        if (primary) {
          logRuntimeEvent(assignmentPath, {
            event: "artifact.delivery_selected",
            artifact_role: "final",
            ...eventPayload(primary.published, primary.sourcePath),
          });
        }
      }
      await writeJsonAtomic(publicationMarkerPath, {
        schemaVersion: 2,
        taskId: task.id,
        executionAttemptId: task.executionAttemptId,
        resultSha256,
        artifacts: markerArtifacts,
        publishedAt: new Date().toISOString(),
      });
    });
  }

  /** Terminal state remains listable when result publication needs repair. */
  async tryRepairTerminalTaskResult(task: SessionTask): Promise<void> {
    try {
      await this.repairTerminalTaskResult(task);
    } catch (error) {
      this.logTaskRecoveryFailure(
        task,
        "run.terminal_result_repair_failed",
        error,
      );
    }
  }

  private async appendDeliveryChatMessage(
    task: SessionTask,
    verifiedPublishedArtifacts: Array<{
      published: WorkflowPublishedArtifactReference;
      sourcePath: string;
    }>,
  ): Promise<void> {
    const primary = verifiedPublishedArtifacts.find(
      ({ published }) => published.role === "primary",
    );
    if (!primary) return;
    try {
      const existing = await this.port.listChatMessages(task.sessionId);
      const alreadyPosted = existing.some(
        (message) =>
          message.delivery?.taskId === task.id &&
          message.delivery.executionAttemptId === task.executionAttemptId,
      );
      if (alreadyPosted) return;
      const toChatArtifact = (
        published: WorkflowPublishedArtifactReference,
        role: ChatDeliveryArtifact["role"],
      ): ChatDeliveryArtifact => ({
        runId: published.artifact.childRunId,
        path: published.artifact.relativePath,
        role,
        ...(published.label ? { title: published.label } : {}),
        ...(published.mediaType ? { mediaType: published.mediaType } : {}),
        // This file's own digest, not the root result wrapper's. A later
        // reader carrying this artifact forward proves its bytes with it.
        ...(published.artifact.sha256
          ? { digest: published.artifact.sha256 }
          : {}),
      });
      const artifacts: ChatDeliveryArtifact[] = [
        toChatArtifact(primary.published, "final"),
        ...verifiedPublishedArtifacts
          .filter(({ published }) => published.role === "secondary")
          .map(({ published }) =>
            toChatArtifact(published, "secondary"),
          ),
      ];
      await this.port.appendChatMessage(task.sessionId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "✅ Done — final delivery below. Ask me anything about it.",
        createdAt: new Date().toISOString(),
        speaker:
          (await this.resolveStepAgentSpeaker(
            task,
            primary.published.artifact.childRunId,
          )) ?? workflowChatSpeaker(task.workflowId),
        delivery: {
          taskId: task.id,
          ...(task.executionAttemptId
            ? { executionAttemptId: task.executionAttemptId }
            : {}),
          artifacts,
        },
      });
    } catch {
      // A missing chat card must not fail task-result publication.
    }
  }

  /**
   * Tell the user in the chat that a run stopped, beside the delivery message.
   *
   * A failed or blocked run used to leave the transcript ending on whatever
   * the agent last said, with the error visible only in the run pane. This is
   * the failure counterpart, deduplicated on the task execution attempt
   * exactly as the delivery is, so a publication repaired twice reports once.
   */
  private async appendOutcomeChatMessage(
    task: SessionTask,
    status: ChatOutcomeStatus,
    state: DurableWorkflowState | undefined,
  ): Promise<void> {
    try {
      const existing = await this.port.listChatMessages(task.sessionId);
      const alreadyPosted = existing.some(
        (message) =>
          message.outcome?.taskId === task.id &&
          message.outcome.executionAttemptId === task.executionAttemptId,
      );
      if (alreadyPosted) return;
      const steps = state?.steps ?? [];
      const outputStepId = state?.terminalOutcome?.outputStepId;
      const endingStep =
        steps.find(
          (step) => step.status === "failed" || step.status === "blocked",
        ) ?? steps.find((step) => step.stepId === outputStepId);
      const content = buildTaskOutcomeChatMessage({
        status,
        workflowId: task.workflowId,
        ...whenDefined(endingStep?.stepId, (definedValue) => ({ stepId: definedValue })),
        // The workflow's own terminal summary, or the task record's error when
        // the journal committed none. Never the child's raw output.
        ...whenDefined(state?.terminalOutcome?.summary ?? task.error, (definedValue) => ({
          summary: definedValue,
        })),
      });
      await this.port.appendChatMessage(task.sessionId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: content.text,
        createdAt: new Date().toISOString(),
        speaker:
          (await this.resolveStepAgentSpeaker(task, endingStep?.childRunId)) ??
          workflowChatSpeaker(task.workflowId),
        outcome: {
          taskId: task.id,
          ...whenDefined(task.executionAttemptId, (definedValue) => ({
            executionAttemptId: definedValue,
          })),
          status,
          workflowId: task.workflowId,
          ...whenDefined(endingStep?.stepId, (definedValue) => ({ stepId: definedValue })),
          ...whenDefined(content.reason, (definedValue) => ({ reason: definedValue })),
        },
      });
    } catch {
      // A missing chat line must not fail task-result publication.
    }
  }

  /**
   * The agent a workflow step ran, read from the child assignment's own log.
   *
   * One distinct agent means the step had a single producer the chat can
   * credit by name. Anything else — a team, an unreadable log, or no log at
   * all — is not one agent, so the caller falls back to the workflow rather
   * than crediting the front-door persona for work it did not do.
   */
  private async resolveStepAgentSpeaker(
    task: SessionTask,
    childRunId: string | undefined,
  ): Promise<ChatMessageSpeaker | undefined> {
    if (!childRunId) return undefined;
    try {
      const logPath = path.join(
        this.resolveTaskChildAssignmentPath(task, childRunId),
        "logs",
        "agent-runs.jsonl",
      );
      const names = new Set<string>();
      for (const line of (await fs.readFile(logPath, "utf8")).split("\n")) {
        if (line.trim().length === 0) continue;
        // A child killed mid-append leaves a half-written last line, which is
        // exactly the run this message exists for. Skip it, do not give up.
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isUnknownRecord(event) || event.agent_type !== "agent") continue;
        if (typeof event.agent_name !== "string" || !event.agent_name) continue;
        names.add(event.agent_name);
      }
      const [name] = [...names];
      if (names.size !== 1 || name === undefined) return undefined;
      return { type: "agent", id: name, name };
    } catch {
      return undefined;
    }
  }

  /** Recovery diagnostics must never make task/session listing unavailable. */
  private logTaskRecoveryFailure(
    task: SessionTask,
    event: string,
    error: unknown,
  ): void {
    if (!task.assignmentPath) return;
    try {
      const expectedAssignmentPath =
        this.resolveCanonicalTaskAssignmentPath(task);
      const logsPath = path.join(expectedAssignmentPath, "logs");
      if (
        path.resolve(task.assignmentPath) !== expectedAssignmentPath ||
        !existsSync(expectedAssignmentPath) ||
        !resolveExistingPathInside(
          path.dirname(expectedAssignmentPath),
          expectedAssignmentPath,
        ) ||
        (existsSync(logsPath) &&
          !resolveExistingPathInside(expectedAssignmentPath, logsPath))
      ) {
        return;
      }
      logRuntimeEvent(expectedAssignmentPath, {
        timestamp: this.port.now().toISOString(),
        event,
        session_id: task.runId,
        root_session_id: task.runId,
        assignment_path: expectedAssignmentPath,
        task_id: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The durable task record remains the observable source of truth.
    }
  }

  async finalizeTerminalTask(
    sessionId: string,
    task: SessionTask,
  ): Promise<void> {
    await this.reconcileAuthoritativeTerminalWorkflowJournal(task);
    await this.tryRepairTerminalTaskResult(task);
    await this.port.withFileLock(
      this.port.sessionLockPath(sessionId),
      async () => {
        const currentPlan = await this.port.plans.read(sessionId);
        if (
          currentPlan?.taskId === task.id &&
          !isTerminalRunPlanStatus(currentPlan.status)
        ) {
          await writeJsonAtomic(
            this.port.plans.path(sessionId),
            markRunPlanTerminal(
              currentPlan,
              taskStatusToRunPlanStatus(task.status),
              task.error,
            ),
          );
        }
        await this.recomputeSessionStatus(sessionId, true);
      },
    );
  }

  async recomputeSessionLifecycle(sessionId: string): Promise<void> {
    await this.port.withFileLock(
      this.port.sessionLockPath(sessionId),
      async () => {
        const currentPlan = await this.port.plans.read(sessionId);
        if (
          currentPlan?.taskId &&
          !isTerminalRunPlanStatus(currentPlan.status)
        ) {
          const task = await this.port.tasks.get(
            sessionId,
            currentPlan.taskId,
          );
          if (task && isTerminalTaskStatus(task.status)) {
            await writeJsonAtomic(
              this.port.plans.path(sessionId),
              markRunPlanTerminal(
                currentPlan,
                taskStatusToRunPlanStatus(task.status),
                task.error,
              ),
            );
          }
        }
        await this.recomputeSessionStatus(sessionId);
      },
    );
  }

  private async recomputeSessionStatus(
    sessionId: string,
    touchUpdatedAt = false,
  ): Promise<void> {
    const summary = await this.port.readMetadata(sessionId);
    if (!summary) return;
    const tasks = await this.port.tasks.list(sessionId);
    const status: SessionStatus = tasks.some((task) =>
      isActiveTaskStatus(task.status),
    )
      ? "active"
      : tasks.length > 0
        ? "done"
        : summary.status === "active"
          ? "idle"
          : summary.status;
    if (summary.status === status && !touchUpdatedAt) return;
    await this.port.writeMetadata({
      ...summary,
      status,
      updatedAt: this.port.now().toISOString(),
    });
  }

  private resolveCanonicalTaskAssignmentPath(task: SessionTask): string {
    if (task.assignmentId || task.runPath) {
      const location = buildSessionRunAssignmentLocation(
        this.port.workspacePath(),
        {
          sessionId: task.sessionId,
          runId: task.runId,
          assignmentId: task.assignmentId ?? task.runId,
        },
      );
      if (!location) throw new Error("Task assignment identity is invalid.");
      if (
        task.runPath &&
        path.resolve(task.runPath) !== path.resolve(location.runPath)
      ) {
        throw new Error(
          "Persisted run path does not match the task identity.",
        );
      }
      return path.resolve(location.assignmentPath);
    }
    return path.resolve(
      resolveAssignmentPath(this.port.workspacePath(), task.runId),
    );
  }

  private resolveTaskChildAssignmentPath(
    task: SessionTask,
    childRunId: string,
  ): string {
    if (task.assignmentId || task.runPath) {
      const location = buildSessionRunAssignmentLocation(
        this.port.workspacePath(),
        {
          sessionId: task.sessionId,
          runId: task.runId,
          assignmentId: childRunId,
        },
      );
      if (!location) {
        throw new Error("Workflow child assignment identity is invalid.");
      }
      return location.assignmentPath;
    }
    return resolveAssignmentPath(this.port.workspacePath(), childRunId);
  }

  async verifyWorkflowOutcomeArtifacts(
    task: SessionTask,
    outcome: DurableWorkflowTerminalOutcome,
  ): Promise<Array<{
    published: WorkflowPublishedArtifactReference;
    sourcePath: string;
  }>> {
    const publishedArtifacts =
      outcome.artifacts ??
      (outcome.primaryArtifact
        ? [
            {
              stepId: outcome.outputStepId,
              role: "primary" as const,
              artifact: outcome.primaryArtifact,
            },
          ]
        : []);
    const verified: Array<{
      published: WorkflowPublishedArtifactReference;
      sourcePath: string;
    }> = [];
    for (const published of publishedArtifacts) {
      const childAssignmentPath = this.resolveTaskChildAssignmentPath(
        task,
        published.artifact.childRunId,
      );
      verified.push({
        published,
        sourcePath: await verifyWorkflowArtifactReference(
          childAssignmentPath,
          published.artifact,
        ),
      });
    }
    return verified;
  }
}

export function parseTaskPublicationMarker(
  value: unknown,
  expected: { readonly taskId: string; readonly executionAttemptId: string },
): readonly VerifiedTaskArtifact[] {
  const marker = strictRecord(value, "Task publication marker must be a JSON object.");
  strictKeys(
    marker,
    ["schemaVersion", "taskId", "executionAttemptId", "resultSha256", "artifacts", "publishedAt"],
    "Task publication marker",
  );
  if (marker.schemaVersion !== 2) throw new Error("Task publication marker schema is unsupported.");
  if (marker.taskId !== expected.taskId || marker.executionAttemptId !== expected.executionAttemptId) {
    throw new Error("Task publication marker identity does not match the requested task and attempt.");
  }
  if (!isSha256(marker.resultSha256)) throw new Error("Task publication result hash is invalid.");
  if (typeof marker.publishedAt !== "string" || !Number.isFinite(Date.parse(marker.publishedAt))) {
    throw new Error("Task publication timestamp is invalid.");
  }
  if (!Array.isArray(marker.artifacts)) throw new Error("Task publication artifacts must be an array.");
  const artifacts = marker.artifacts.map((value) => {
    const artifact = strictRecord(value, "Task publication artifact must be a JSON object.");
    strictKeys(
      artifact,
      ["stepId", "role", "childRunId", "path", "sha256", "byteLength"],
      "Task publication artifact",
    );
    if (artifact.role !== "primary" && artifact.role !== "secondary") {
      throw new Error("Task publication artifact role is invalid.");
    }
    if (typeof artifact.stepId !== "string" || !artifact.stepId || artifact.stepId.length > 300) {
      throw new Error("Task publication artifact step identity is invalid.");
    }
    if (typeof artifact.childRunId !== "string" || !isSafePathSegment(artifact.childRunId)) {
      throw new Error("Task publication artifact run identity is invalid.");
    }
    if (!isSafePublicationPath(artifact.path)) {
      throw new Error("Task publication artifact path is invalid.");
    }
    if (!isSha256(artifact.sha256)) throw new Error("Task publication artifact hash is invalid.");
    if (!Number.isSafeInteger(artifact.byteLength) || (artifact.byteLength as number) < 0) {
      throw new Error("Task publication artifact byte length is invalid.");
    }
    return {
      role: artifact.role as "primary" | "secondary",
      childRunId: artifact.childRunId,
      path: artifact.path,
      byteLength: artifact.byteLength as number,
      sha256: artifact.sha256,
    };
  });
  if (artifacts.filter((artifact) => artifact.role === "primary").length !== 1) {
    throw new Error("Task publication marker must contain exactly one primary artifact.");
  }
  return artifacts;
}

function publicationFailure(
  code: "verified_publication_missing" | "verified_publication_invalid",
  detail: string,
): BatchTaskPublicationResolution {
  return { status: "failed", code, detail };
}

/** How much of a sanitized reason the chat line carries before it is cut. */
const TASK_OUTCOME_REASON_LIMIT = 280;

/**
 * An absolute POSIX path, including the ones whose directories contain spaces.
 *
 * The match may only begin where a word does, so a date such as `2026/09/11`
 * and the tail of a URL such as `https://example.com/a/b` are prose, not
 * paths. A space is absorbed only when two more separators follow it, which
 * `/Users/t/Application Support/x/y.docx` has and `a and/or b` does not.
 */
const ABSOLUTE_PATH_PATTERN =
  /(?<=^|\s)\/[^\s/]+(?:(?:\/| (?=[^\s/]*\/[^\s/]*\/))[^\s/]+)+/g;

/** A drive-letter or UNC path, which the POSIX pattern cannot see. */
const WINDOWS_PATH_PATTERN =
  /(?<=^|\s)(?:[A-Za-z]:\\|\\\\)[^\s\\]+(?:\\[^\s\\]+)+/g;

/**
 * The envelopes `agent-runner` wraps a dead child in, whose payload is stderr.
 *
 * Recognising them is what keeps the child's own output out of the chat: the
 * summary a failed step commits is frequently one of these verbatim, so
 * sanitizing its text would only truncate a secret rather than remove it.
 */
const CHILD_FAILURE_ENVELOPES = [
  "[Child team process failed: exit",
  "[Child team process completed without producing the expected output artifact",
  "[Child team process could not start:",
  "Child stderr:",
];

/** What the chat says in place of a dead child's output. */
const CHILD_FAILURE_REASON =
  "The step's worker exited without producing a result; see the run log.";

/** A credential carried in a URL's userinfo, as a proxy or registry error has it. */
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** An environment assignment whose name says the value is a secret. */
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|authorization)[A-Za-z0-9_.-]*)=\S+/gi;

/**
 * A workflow's terminal summary, made safe for a durable transcript.
 *
 * The summary is written by a worker, so it arrives as several lines, at any
 * length, naming the absolute path of whatever it was reading — and when the
 * worker died it is the child's raw stderr under a machine-written envelope.
 * A chat line is durable and gets shared, so a recognised envelope is dropped
 * whole, credentials are redacted, paths are reduced to the file name, the
 * text is collapsed onto one line, and the result is capped.
 */
export function sanitizeTaskOutcomeReason(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  if (CHILD_FAILURE_ENVELOPES.some((envelope) => collapsed.includes(envelope))) {
    // The runtime's own reason precedes stderr. Reconstruct only static copy
    // from known provider ids; never forward any of the child's raw output.
    const runtimeSummary = value.split(/\r?\nChild stderr:/u)[0] ?? "";
    const quota = /(?:^|\n)Reason: Provider '(claude|codex|gemini|openai|anthropic|openrouter)' failed: You've hit your provider usage limit\./u.exec(runtimeSummary);
    const provider = quota?.[1];
    if (provider) {
      const label = provider === "openai" ? "OpenAI"
        : provider === "openrouter" ? "OpenRouter"
        : `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
      return `${label} usage limit reached. Select a different model or wait for the limit to reset.`;
    }
    return CHILD_FAILURE_REASON;
  }
  const redacted = collapsed
    .replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=<redacted>")
    .replace(ABSOLUTE_PATH_PATTERN, basenameOfSanitizedPath("/"))
    .replace(WINDOWS_PATH_PATTERN, basenameOfSanitizedPath("\\"))
    .trim();
  if (redacted.length === 0) return undefined;
  return redacted.length > TASK_OUTCOME_REASON_LIMIT
    ? `${redacted.slice(0, TASK_OUTCOME_REASON_LIMIT - 1).trimEnd()}…`
    : redacted;
}

/** Keeps the file name a path ends on and discards the directories above it. */
function basenameOfSanitizedPath(
  separator: string,
): (match: string) => string {
  return (match) => match.split(separator).filter(Boolean).at(-1) ?? "";
}

/** The chat line a stopped run leaves, and the reason recorded beside it. */
export interface TaskOutcomeChatMessageContent {
  readonly text: string;
  readonly reason?: string;
}

/**
 * Compose what the chat says when a run ends failed or blocked.
 *
 * It names the workflow and the step, because those are what the user can act
 * on, and adds the workflow's own sanitized summary. A run whose journal
 * recorded no summary says so by omission rather than by a guess.
 */
export function buildTaskOutcomeChatMessage(input: {
  readonly status: ChatOutcomeStatus;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly summary?: string;
}): TaskOutcomeChatMessageContent {
  const reason = sanitizeTaskOutcomeReason(input.summary);
  const headline =
    input.status === "blocked"
      ? `⛔ ${input.workflowId} is blocked`
      : `⚠️ ${input.workflowId} failed`;
  const step = input.stepId ? ` at step ${input.stepId}` : "";
  return {
    text: reason ? `${headline}${step}. ${reason}` : `${headline}${step}.`,
    ...whenDefined(reason, (definedValue) => ({ reason: definedValue })),
  };
}

/** The speaker for a message no single agent can be credited with. */
function workflowChatSpeaker(workflowId: string): ChatMessageSpeaker {
  return { type: "assistant", id: workflowId, name: workflowId };
}

/** A JSON object, narrowed rather than asserted. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function strictKeys(source: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(source).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}.`);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isSafePublicationPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== ".." && !normalized.startsWith("../") && normalized === value;
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

function taskTimestamp(task: SessionTask): Date {
  const value = task.updatedAt ?? task.startedAt ?? task.createdAt;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
