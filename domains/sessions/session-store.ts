import { closeSessionWork } from './session-work-lifecycle.js'
import * as crypto from "node:crypto";
import * as z from "zod/v4";
import { constants as fsConstants, existsSync, lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  isValidSessionId,
  isActiveTaskStatus,
  isSessionOrigin,
  type ChatMessage,
  type SessionDetails,
  type SessionFile,
  type SessionSummary,
  type SessionTask,
  type SessionTitleAttempt,
  type TaskStatus,
} from "./session-types.js";
import type { RunPlan } from "../../contracts/run-plan.js";
import { chatMessageCutOffSchema } from "../../contracts/sessions.js";
import {
  sessionTitleAttemptSchema,
  sessionTitleAttemptsSchema,
} from "../../contracts/schemas/session-title-attempts.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import {
  classifyTaskProcessesByIdentity,
  defaultIsProcessAlive,
  findTaskProcessByIdentity,
  isTaskProcessIdentityValid,
  taskProcessTarget,
  type LocatedTaskProcess,
  type TaskProcessIdentityClassification,
} from "./task-process-supervisor.js";
import {
  withFileMutationLock,
  writeFileAtomic,
} from "../../core/file-mutation.js";
import {
  buildSessionRunAssignmentLocation,
  removeRunAssignmentLocator,
  writeRunAssignmentLocator,
  type SessionRunAssignmentLocation,
} from "../run/run-location.js";
import {
  removeRunAssignmentAuthorityGrant,
} from "../run/run-assignment-authority-store.js";
import { McpResourceImportStore } from "../mcp/mcp-resource-import-store.js";
import { syncDirectoryOf } from "../../services/safe-workspace-directory.js";
import type {
  DurableWorkflowTerminalOutcome,
  WorkflowPublishedArtifactReference,
} from "../../workflows/types.js";
import { configuredProviderBrokerIdentity } from "./provider-broker-identity.js";
import type { WorkspaceExecutionJournalRegistry } from "../../services/workspace-execution-journal-registry.js";
import { withFileLock } from "./session-file-locks.js";
import {
  parseResultReference,
  type ResultReference,
} from "../../contracts/schemas/result-reference.js";
import {
  inferSessionActivityType,
  isChatMessageDelivery,
  isChatMessageOutcome,
  isChatMessageSpeaker,
  readChatTurnRequest,
  isConversationMessageKind,
  isConversationMessageSource,
  readChatMessageConversationReference,
  readChatMessageExecutionReference,
  normalizeActivityType,
  normalizeStatus,
  normalizeTitle,
  sanitizeUploadFilename,
} from "./session-normalizers.js";
import { makeSessionRunSnapshotsWritable } from "./session-snapshots.js";
import {
  SessionTaskRepository,
  type TaskRecordCompareAndSetOptions,
  type TaskRecordCompareAndSetResult,
  type SessionTaskPatch,
} from "./session-task-repository.js";
import {
  RunPlanCoordinator,
  type RunPlanApplyClaimResult,
  type RunPlanRevisionResult,
} from "./run-plan-coordinator.js";
import {
  TaskAdmissionManager,
  type CreateTaskInput,
  type CreateTaskRecordOptions,
} from "./task-admission-manager.js";
import {
  TaskRecoveryManager,
  type BatchTaskPublicationResolution,
} from "./task-recovery-manager.js";
import { FileSourceRepository } from "../file-sources/file-source-repository.js";
import { sessionActivityClaimInputSchema, type SessionActivityClaim, type SessionActivityClaimInput, type SessionActivityClaimResult } from '../../contracts/session-activity.js';
import { SessionActivityClaimsFile, SessionActivityConflictError, releaseSessionActivityAfterFailure, sameSessionActivityClaim, sessionActivityConflict } from './session-activity-claims.js';

/**
 * Where a session is assembled before it is published. Not a session id, so
 * both scans over the sessions directory already skip it, the way they skip
 * the lock directory beside it.
 */
const PENDING_SESSIONS_DIR = ".pending";
/**
 * Who minted this session's id. Kept out of `session.json` on purpose: that
 * file is rewritten from a `SessionSummary` on every title or status change,
 * which would erase the token, and anything inside a summary is answered to
 * every caller of list and get.
 */
const CLAIM_FILENAME = "claim.json";

/**
 * The claim file is input from the filesystem, so its parse stays `unknown`
 * until this guard says what it is. A file that does not carry a string token
 * proves no ownership, which is the same answer as having no file at all.
 */
const claimFileSchema = z.object({ creationToken: z.string().min(1) });

/**
 * The `code` a filesystem rejection carries, when it carries one. A thrown
 * value is `unknown` here like anywhere else, so this reads the field rather
 * than asserting the shape it hopes for.
 */
function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function readClaimedCreationToken(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const claim = claimFileSchema.safeParse(parsed);
  return claim.success ? claim.data.creationToken : null;
}

export type {
  TaskRecordCompareAndSetOptions,
  TaskRecordCompareAndSetResult,
} from "./session-task-repository.js";
export type {
  RunPlanApplyClaimResult,
  RunPlanRevisionResult,
} from "./run-plan-coordinator.js";
export type {
  CreateTaskInput,
  CreateTaskRecordOptions,
} from "./task-admission-manager.js";

export interface CreateSessionInput {
  title?: string;
  origin?: import('../../contracts/sessions.js').SessionOrigin;
  /**
   * The id the caller has already committed to, paired with the token that
   * proves who minted it. Supplied by a client that keeps a draft conversation
   * on screen before it exists here, so the id it has been keying state by
   * survives the moment the session becomes durable.
   */
  id?: string;
  creationToken?: string;
}

/**
 * Whether this call is what made the session, or found the one it had already
 * made. A retry after a lost response is the second case, and the caller has to
 * be able to tell: it owns the session either way, but only one of them is news.
 */
export type SessionCreateOutcome = "created" | "replayed";

export interface SessionCreateResult {
  session: SessionSummary;
  outcome: SessionCreateOutcome;
}

export type SessionStoreErrorCode = "session_id_conflict";

/** A create that cannot proceed, named so a route can answer it precisely. */
export class SessionStoreError extends Error {
  constructor(
    readonly code: SessionStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export interface UploadFileInput {
  filename: string;
  contents: Buffer;
}

export type SessionFileDeleteResult = "deleted" | "not_found" | "locked";
export type EmptySessionDiscardResult = "deleted" | "not_found" | "not_empty";

export interface DeleteSessionResult {
  deleted: boolean;
  reason?: "not_found" | SessionDeletionBlocker;
}

export interface DeleteSessionsResult {
  deleted: boolean;
  deletedSessionIds: string[];
  reason?: SessionDeletionBlocker;
}

export interface FileSystemSessionStoreOptions {
  instanceId?: string;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  isProcessIdentityValid?: (task: SessionTask) => boolean;
  findProcessByIdentity?: (processIdentity: string) => LocatedTaskProcess | null;
  classifyProcessesByIdentity?: (processIdentity: string) => TaskProcessIdentityClassification;
  now?: () => Date;
  staleTaskGraceMs?: number;
  applyClaimLeaseMs?: number;
  mcpResourceImportStore?: McpResourceImportStore;
  configuredProviderBrokerUrl?: string;
  /**
   * Flush the directory entry that names a file.
   *
   * Injected because no later filesystem call reports whether this happened,
   * so it is the one durability boundary a caller cannot otherwise observe or
   * exercise. The default is the real flush.
   */
  syncDirectoryOfFile?: (filePath: string) => Promise<void>;
}

export interface SessionTaskTerminalAssignment {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
}

export type SessionTaskTerminalListener = (
  scope: SessionTaskTerminalAssignment,
) => void | Promise<void>;

export interface SessionStore {
  /**
   * Adopt the workspace's journal registry. Terminal reconciliation runs
   * inside this store and rewrites authoritative workflow state, so for an
   * enrolled assignment it has to append to the canonical journal rather than
   * writing straight into the projection (ADR §9). The registry is owned by
   * whoever composed the process, and is bound after construction because the
   * store is built before the composition that resolves it.
   */
  useExecutionJournalRegistry?(
    registry: WorkspaceExecutionJournalRegistry,
  ): void;
  createSession(input?: CreateSessionInput): Promise<SessionSummary>;
  /**
   * Records one title attempt, answering whether it was recorded.
   *
   * Answers `false` for a session that is gone, an attempt that is not valid,
   * or a history that cannot be read. A filesystem failure still rejects — this
   * does not swallow I/O, and the optional caller that asked for the title is
   * where that is caught, because it is the one that knows the work is
   * optional.
   */
  appendSessionTitleAttempt(
    id: string,
    attempt: SessionTitleAttempt,
  ): Promise<boolean>;
  /**
   * Create, or recognise the create this caller already made. Only a claimed
   * create can be replayed, so this is the entry point a client-minted id uses.
   *
   * Required, not optional: a store that quietly fell back to `createSession`
   * would accept a claimed request, mint a different id, and report it as a
   * create the caller made — success for a contract it never honoured.
   */
  createSessionWithClaim(
    input?: CreateSessionInput,
  ): Promise<SessionCreateResult>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetails | null>;
  claimSessionActivity(id: string, claim: SessionActivityClaimInput): Promise<SessionActivityClaimResult>;
  promoteSessionChatToDialogue(id: string, chat: SessionActivityClaimInput, dialogue: SessionActivityClaimInput): Promise<SessionActivityClaimResult>;
  restoreSessionChatFromDialogue(id: string, dialogue: SessionActivityClaimInput, chat: SessionActivityClaimInput): Promise<boolean>;
  releaseSessionActivity(id: string, claim: SessionActivityClaimInput): Promise<void>;
  listSessionActivityClaims(id: string): Promise<SessionActivityClaim[]>;
  isSessionActivityOwnerAlive(id: string, claim: SessionActivityClaimInput): Promise<boolean>;
  reconcileOrphanedDialogueClaims(id: string, recordedDialogueIds: readonly string[]): Promise<void>;
  dialogueRecordDirectory(id: string): string | undefined;
  updateSessionTitle(id: string, title: string): Promise<SessionSummary | null>;
  deleteSession(id: string): Promise<boolean>;
  /** Roll back a new blank chat without stopping work or deleting saved state. */
  discardSessionIfEmpty?(id: string): Promise<EmptySessionDiscardResult>;
  deleteSessionIfNoActiveTasks?(id: string): Promise<DeleteSessionResult>;
  deleteSessionsIfNoActiveTasks?(
    ids: readonly string[],
  ): Promise<DeleteSessionsResult>;
  appendChatMessage(id: string, message: ChatMessage): Promise<boolean>;
  /**
   * Append only if that message id is absent. See the implementation for the
   * outcomes; this is the append a replay-safe turn must use.
   */
  appendChatMessageIfAbsent(
    id: string,
    message: ChatMessage,
  ): Promise<
    | "appended"
    | "already-present"
    | "conflict"
    | "unknown-session"
    /** The line would not survive a reload, so it was not written. */
    | "invalid-message"
  >;
  listChatMessages(id: string): Promise<ChatMessage[]>;
  /**
   * The completed results this session may offer as continuation context.
   *
   * Empty for every session written before results were recorded, which is
   * exactly what those sessions have always had.
   */
  listResultReferences(id: string): Promise<ResultReference[]>;
  /**
   * Record one completed result, or do nothing when its id is already held.
   *
   * Idempotent by `reference.id`, which is derived from the producer and its
   * execution attempt, so a recovery sweep revisiting a finished run and a
   * replay of the turn that started it both write nothing new.
   */
  publishResultReference(
    id: string,
    reference: ResultReference,
  ): Promise<boolean>;
  saveUploadedFile(
    id: string,
    input: UploadFileInput,
  ): Promise<SessionFile | null>;
  listFiles(id: string): Promise<SessionFile[]>;
  deleteFile(id: string, filename: string): Promise<boolean>;
  deleteFileIfUnused?(
    id: string,
    filename: string,
  ): Promise<SessionFileDeleteResult>;
  lockFilesForChat?(id: string): Promise<SessionFile[]>;
  readParsedText(id: string, outputName: string): Promise<string | null>;
  inputsDir(id: string): string;
  ensureAgentChatAssignment(
    id: string,
    runId: string,
    assignmentId: string,
  ): Promise<SessionRunAssignmentLocation | null>;
  createTaskRecord(
    id: string,
    input: CreateTaskInput,
    options?: CreateTaskRecordOptions,
  ): Promise<SessionTask | null>;
  updateTaskRecord(
    id: string,
    taskId: string,
    patch: SessionTaskPatch,
  ): Promise<SessionTask | null>;
  compareAndSetTaskRecord(
    id: string,
    taskId: string,
    expectedStatuses: readonly TaskStatus[],
    patch: SessionTaskPatch,
    options?: TaskRecordCompareAndSetOptions,
  ): Promise<TaskRecordCompareAndSetResult | null>;
  getTaskRecord(id: string, taskId: string): Promise<SessionTask | null>;
  listTaskRecords(id: string): Promise<SessionTask[]>;
  listTaskRecordsStrict?(): Promise<SessionTask[]>;
  repairStagedTaskAdmission?(
    id: string,
    taskId: string,
  ): Promise<SessionTask | null>;
  recoverOrphanedRunPlanApplies?(): Promise<boolean>;
  reconcileTaskRecords(id: string): Promise<SessionTask[]>;
  resolveTaskPublication(
    id: string,
    taskId: string,
    executionAttemptId: string,
  ): Promise<BatchTaskPublicationResolution>;
  reconcileAdmittedTaskRecord?(
    id: string,
    taskId: string,
  ): Promise<SessionTask | null>;
  ownsTaskProcess(task: SessionTask): boolean;
  isTaskProcessAlive?(task: SessionTask): boolean;
  hasValidTaskProcessIdentity?(task: SessionTask): boolean;
  isTaskProviderBrokerCompatible?(task: SessionTask): boolean;
  getInstanceId(): string;
  taskDir(sessionId: string, taskId: string): string;
  getRunPlan(id: string): Promise<RunPlan | null>;
  saveRunPlan(id: string, plan: RunPlan): Promise<boolean>;
  reviseRunPlan(
    id: string,
    expectedPlanId: string | null,
    nextPlan: RunPlan,
  ): Promise<RunPlanRevisionResult | null>;
  claimRunPlanForApply(
    id: string,
    planId: string,
  ): Promise<RunPlanApplyClaimResult | null>;
  recoverRunPlanApply(id: string, planId: string): Promise<RunPlan | null>;
  finalizeRunPlanApply(
    id: string,
    planId: string,
    claimId: string,
    nextPlan: RunPlan,
  ): Promise<RunPlan | null>;
  markRunPlanRunningIfQueued?(
    id: string,
    planId: string,
    taskId: string,
    executionAttemptId: string,
  ): Promise<RunPlan | null>;
  subscribeTaskTerminal?(
    listener: SessionTaskTerminalListener,
  ): () => void;
}

/**
 * Whether a new record adds provenance the held one lacks.
 *
 * The only reason to write an id twice. Everything else about a result is
 * derived from the same immutable run, so a second write that added nothing
 * would be noise in an append-only log.
 */
function upgradesProvenance(
  held: ResultReference,
  incoming: ResultReference,
): boolean {
  if (held.producerTaskId === undefined && incoming.producerTaskId !== undefined) {
    return true;
  }
  const heldDigest =
    held.source.kind === "artifact" ? held.source.digest : undefined;
  const incomingDigest =
    incoming.source.kind === "artifact" ? incoming.source.digest : undefined;
  return heldDigest === undefined && incomingDigest !== undefined;
}

export class FileSystemSessionStore implements SessionStore {
  private readonly instanceId: string;
  private readonly processId: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly isProcessIdentityValid: (task: SessionTask) => boolean;
  private readonly findProcessByIdentity: (
    processIdentity: string,
  ) => LocatedTaskProcess | null;
  private readonly classifyProcessesByIdentity: (
    processIdentity: string,
  ) => TaskProcessIdentityClassification;
  private readonly now: () => Date;
  private readonly syncDirectoryOfFile: (filePath: string) => Promise<void>;
  private readonly staleTaskGraceMs: number;
  private readonly applyClaimLeaseMs: number;
  private readonly mcpResourceImportStore: McpResourceImportStore;
  private readonly taskRepository: SessionTaskRepository;
  private readonly runPlanCoordinator: RunPlanCoordinator;
  private readonly taskAdmissionManager: TaskAdmissionManager;
  private readonly taskRecoveryManager: TaskRecoveryManager;
  private readonly terminalTaskListeners = new Set<SessionTaskTerminalListener>();
  private currentConfiguredProviderBrokerIdentity: string | undefined;
  private executionJournalRegistry:
    | WorkspaceExecutionJournalRegistry
    | undefined;

  constructor(
    private readonly workspacePath: string,
    options: FileSystemSessionStoreOptions = {},
  ) {
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.syncDirectoryOfFile = options.syncDirectoryOfFile ?? syncDirectoryOf;
    this.isProcessIdentityValid =
      options.isProcessIdentityValid ?? isTaskProcessIdentityValid;
    this.findProcessByIdentity =
      options.findProcessByIdentity ?? findTaskProcessByIdentity;
    this.classifyProcessesByIdentity =
      options.classifyProcessesByIdentity ?? classifyTaskProcessesByIdentity;
    this.now = options.now ?? (() => new Date());
    this.staleTaskGraceMs = options.staleTaskGraceMs ?? 5_000;
    this.applyClaimLeaseMs = options.applyClaimLeaseMs ?? 30_000;
    this.mcpResourceImportStore =
      options.mcpResourceImportStore ??
      new McpResourceImportStore({ workspacePath: this.workspacePath });
    this.taskRepository = new SessionTaskRepository({
      sessionDir: (sessionId) => this.sessionDir(sessionId),
      now: () => this.now(),
      withTaskLock: (lockPath, operation) =>
        withFileLock(lockPath, operation),
      verifyWorkflowOutcomeArtifacts: (task, outcome) =>
        this.verifyWorkflowOutcomeArtifacts(task, outcome),
      tryRepairTerminalTaskResult: (task) =>
        this.tryRepairTerminalTaskResult(task),
      finalizeTerminalTask: (sessionId, task) =>
        this.finalizeTerminalTask(sessionId, task),
    });
    this.runPlanCoordinator = new RunPlanCoordinator({
      sessionsDir: () => this.sessionsDir,
      sessionDir: (sessionId) => this.sessionDir(sessionId),
      metadataPath: (sessionId) => this.metadataPath(sessionId),
      runPlanPath: (sessionId) => this.runPlanPath(sessionId),
      sessionLockPath: (sessionId) => this.sessionLockPath(sessionId),
      ensureBaseDir: () => this.ensureBaseDir(),
      readMetadata: (sessionId) => this.readMetadata(sessionId),
      writeMetadata: (summary) => this.writeMetadata(summary),
      readTaskRecords: (sessionId) => this.readTaskRecords(sessionId),
      readTaskRecordsStrictForSession: (sessionId) =>
        this.readTaskRecordsStrictForSession(sessionId),
      readTaskRecord: (sessionId, taskId) =>
        this.readTaskRecord(sessionId, taskId),
      writeTaskRecord: (sessionId, taskId, task) =>
        this.writeTaskRecord(sessionId, taskId, task),
      withSessionLock: (lockPath, operation) =>
        withFileLock(lockPath, operation),
      findProcessByIdentity: (processIdentity) =>
        this.findProcessByIdentity(processIdentity),
      isProcessAlive: (pid) => this.isProcessAlive(pid),
      now: () => this.now(),
      instanceId: () => this.instanceId,
      processId: () => this.processId,
      applyClaimLeaseMs: () => this.applyClaimLeaseMs,
    });
    this.taskAdmissionManager = new TaskAdmissionManager({
      workspacePath: () => this.workspacePath,
      instanceId: () => this.instanceId,
      mcpResourceSnapshots: () => this.mcpResourceImportStore,
      sessionDir: (sessionId) => this.sessionDir(sessionId),
      inputsDir: (sessionId) => this.inputsDir(sessionId),
      taskDir: (sessionId, taskId) => this.taskDir(sessionId, taskId),
      metadataPath: (sessionId) => this.metadataPath(sessionId),
      runPlanPath: (sessionId) => this.runPlanPath(sessionId),
      sessionLockPath: (sessionId) => this.sessionLockPath(sessionId),
      readMetadata: (sessionId) => this.readMetadata(sessionId),
      writeMetadata: (summary) => this.writeMetadata(summary),
      readRunPlanRecord: (sessionId) =>
        this.readRunPlanRecord(sessionId),
      readTaskRecordsStrictForSession: (sessionId) =>
        this.readTaskRecordsStrictForSession(sessionId),
      readTaskRecord: (sessionId, taskId) =>
        this.readTaskRecord(sessionId, taskId),
      writeTaskRecord: (sessionId, taskId, task) =>
        this.writeTaskRecord(sessionId, taskId, task),
      withSessionLock: (lockPath, operation) =>
        withFileLock(lockPath, operation),
      reconcileAdmittedTask: (sessionId, taskId) =>
        this.reconcileTaskRecord(sessionId, taskId, undefined, true),
      recomputeSessionLifecycle: (sessionId) =>
        this.recomputeSessionLifecycle(sessionId),
      now: () => this.now(),
    });
    this.taskRecoveryManager = new TaskRecoveryManager({
      tasks: {
        get: (sessionId, taskId) =>
          this.readTaskRecord(sessionId, taskId),
        list: (sessionId) => this.readTaskRecords(sessionId),
        compareAndSet: (
          sessionId,
          taskId,
          expectedStatuses,
          patch,
          compareOptions,
        ) =>
          this.compareAndSetTaskRecord(
            sessionId,
            taskId,
            expectedStatuses,
            patch,
            compareOptions,
          ),
      },
      plans: {
        read: (sessionId) => this.readRunPlanRecord(sessionId),
        path: (sessionId) => this.runPlanPath(sessionId),
      },
      workspacePath: () => this.workspacePath,
      metadataPath: (sessionId) => this.metadataPath(sessionId),
      sessionLockPath: (sessionId) => this.sessionLockPath(sessionId),
      readMetadata: (sessionId) => this.readMetadata(sessionId),
      writeMetadata: (summary) => this.writeMetadata(summary),
      listChatMessages: (sessionId) => this.listChatMessages(sessionId),
      appendChatMessage: (sessionId, message) =>
        this.appendChatMessage(sessionId, message),
      withFileLock: (lockPath, operation) =>
        withFileLock(lockPath, operation),
      now: () => this.now(),
      ownsProcess: (task) => this.ownsTaskProcess(task),
      isProcessAlive: (pid) => this.isProcessAlive(pid),
      hasValidProcessIdentity: (task) =>
        this.hasValidTaskProcessIdentity(task),
      findProcessByIdentity: (processIdentity) =>
        this.findProcessByIdentity(processIdentity),
      classifyProcessesByIdentity: (processIdentity) =>
        this.classifyProcessesByIdentity(processIdentity),
      configuredProviderBrokerIdentity: () =>
        this.currentConfiguredProviderBrokerIdentity,
      staleTaskGraceMs: () => this.staleTaskGraceMs,
      executionJournalRegistry: () => this.executionJournalRegistry,
    });
    this.currentConfiguredProviderBrokerIdentity =
      configuredProviderBrokerIdentity(
        options.configuredProviderBrokerUrl,
      );
  }

  useExecutionJournalRegistry(
    registry: WorkspaceExecutionJournalRegistry,
  ): void {
    this.executionJournalRegistry = registry;
  }

  subscribeTaskTerminal(listener: SessionTaskTerminalListener): () => void {
    this.terminalTaskListeners.add(listener);
    return () => {
      this.terminalTaskListeners.delete(listener);
    };
  }

  async createSession(input?: CreateSessionInput): Promise<SessionSummary> {
    return (await this.createSessionWithClaim(input)).session;
  }

  async createSessionWithClaim(
    input?: CreateSessionInput,
  ): Promise<SessionCreateResult> {
    await this.ensureBaseDir();
    const id = input?.id ?? crypto.randomUUID();
    if (!isValidSessionId(id)) throw new Error("Invalid session id");
    const now = this.now().toISOString();
    const title = normalizeTitle(input?.title) ?? "Untitled session";
    if (input?.origin !== undefined && !isSessionOrigin(input.origin)) {
      throw new Error("Session origin is invalid");
    }
    const summary: SessionSummary = {
      id,
      title,
      status: "idle",
      activityType: "chat",
      ...(input?.origin ? { origin: structuredClone(input.origin) } : {}),
      createdAt: now,
      updatedAt: now,
    };

    // Build the whole session somewhere else, then move it in. Rename is the
    // one atomic step, and what it publishes is already complete: a process
    // that dies mid-create leaves an unreferenced staging directory, never a
    // session directory that exists without the claim that says whose it is.
    const stagingDir = path.join(
      this.sessionsDir,
      PENDING_SESSIONS_DIR,
      crypto.randomUUID(),
    );
    await fs.mkdir(stagingDir, { recursive: true });
    try {
      if (input?.creationToken !== undefined) {
        await writeJsonAtomic(path.join(stagingDir, CLAIM_FILENAME), {
          creationToken: input.creationToken,
        });
      }
      await writeJsonAtomic(path.join(stagingDir, "session.json"), summary);
      const sessionDir = this.sessionDir(id);
      return await withFileLock(this.sessionLockPath(id), async () => {
        try {
          await fs.lstat(sessionDir);
          return await this.replayClaimedSession(id, input?.creationToken);
        } catch (error) {
          if (errnoCodeOf(error) !== "ENOENT") throw error;
        }

        try {
          await fs.rename(stagingDir, sessionDir);
          return { session: summary, outcome: "created" };
        } catch (error) {
          const code = errnoCodeOf(error);
          if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
          return await this.replayClaimedSession(id, input?.creationToken);
        }
      });
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }

  /**
   * Someone already holds this id. Whether that someone was us is the only
   * question, and the claim file is the only thing that can answer it.
   */
  private async replayClaimedSession(
    id: string,
    creationToken: string | undefined,
  ): Promise<SessionCreateResult> {
    const conflict = new SessionStoreError(
      "session_id_conflict",
      `Session id is already in use: ${id}`,
    );
    if (creationToken === undefined) throw conflict;
    const claimed = await this.readClaimToken(id);
    // An absent or unreadable claim means a session made by a path that never
    // claimed one. It belongs to whoever made it, and this create cannot show
    // that was us.
    if (claimed === null || claimed !== creationToken) throw conflict;
    const summary = await this.readMetadata(id);
    if (!summary) throw conflict;
    return { session: summary, outcome: "replayed" };
  }

  /**
   * The token this session was published with, or `null` when there is none to
   * read. A missing file and a malformed one both answer "not ours"; anything
   * else — a permission error, a failing disk — is a fault, and is rethrown
   * rather than quietly downgraded into a conflict the caller cannot diagnose.
   */
  private async readClaimToken(id: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await fs.readFile(
        path.join(this.sessionDir(id), CLAIM_FILENAME),
        "utf8",
      );
    } catch (error) {
      if (errnoCodeOf(error) === "ENOENT") return null;
      throw error;
    }
    return readClaimedCreationToken(raw);
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.ensureBaseDir();
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessions: SessionSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isValidSessionId(entry.name)) continue;
      const tasks = await this.readTaskRecords(entry.name);
      const summary = await this.readMetadata(entry.name);
      if (summary) {
        sessions.push({
          ...summary,
          activityType: inferSessionActivityType(summary, tasks),
        });
      }
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions;
  }

  async getSession(id: string): Promise<SessionDetails | null> {
    if (!isValidSessionId(id)) return null;
    const tasks = await this.readTaskRecords(id);
    const summary = await this.readMetadata(id);
    if (!summary) return null;
    return {
      ...summary,
      activityType: inferSessionActivityType(summary, tasks),
    };
  }

  async updateSessionTitle(
    id: string,
    title: string,
  ): Promise<SessionSummary | null> {
    if (!isValidSessionId(id)) return null;
    if (!existsSync(this.metadataPath(id))) return null;
    const normalized = normalizeTitle(title);
    if (!normalized) return null;
    return withFileLock(this.sessionLockPath(id), async () => {
      const summary = await this.readMetadata(id);
      if (!summary) return null;
      const next: SessionSummary = {
        ...summary,
        title: normalized,
        updatedAt: this.now().toISOString(),
      };
      await this.writeMetadata(next);
      return next;
    });
  }

  async claimSessionActivity(id: string, input: SessionActivityClaimInput): Promise<SessionActivityClaimResult> {
    if (!isValidSessionId(id)) return 'not_found';
    const claim = sessionActivityClaimInputSchema.parse(input);
    return withFileLock(this.sessionLockPath(id), async () => {
      const directory = this.sessionActivityDirectory(id);
      if (!directory) return 'not_found';
      if (!await this.readMetadata(id)) return 'not_found';
      const file = new SessionActivityClaimsFile(directory);
      const held = await file.read();
      // A dead chat or task request can no longer produce work. Dialogue
      // claims remain until record/transcript recovery explicitly releases them.
      const claims = held.filter((entry) => entry.kind === 'dialogue' || this.isProcessAlive(entry.processId));
      const conflict = sessionActivityConflict(claims, claim);
      if (conflict) return conflict;
      if (claim.kind === 'dialogue') {
        const tasks = await this.readTaskRecordsStrictForSession(id);
        const plan = await this.readRunPlanRecord(id);
        if (sessionDeletionBlockerFor(tasks) || plan?.status === 'applying') return 'tasks_active';
      }
      await file.write([...claims, { ...claim, processId: this.processId }]);
      return 'claimed';
    });
  }

  async releaseSessionActivity(id: string, input: SessionActivityClaimInput): Promise<void> {
    if (!isValidSessionId(id)) return;
    const claim = sessionActivityClaimInputSchema.parse(input);
    await withFileLock(this.sessionLockPath(id), async () => {
      const directory = this.sessionActivityDirectory(id);
      if (!directory) return;
      if (!await this.readMetadata(id)) return;
      const file = new SessionActivityClaimsFile(directory);
      const claims = await file.read();
      const remaining = claims.filter((entry) => !sameSessionActivityClaim(entry, claim));
      if (remaining.length !== claims.length) await file.write(remaining);
    });
  }

  async promoteSessionChatToDialogue(id: string, chatInput: SessionActivityClaimInput, dialogueInput: SessionActivityClaimInput): Promise<SessionActivityClaimResult> {
    if (!isValidSessionId(id)) return 'not_found';
    const chat = sessionActivityClaimInputSchema.parse(chatInput);
    const dialogue = sessionActivityClaimInputSchema.parse(dialogueInput);
    if (chat.kind !== 'chat' || dialogue.kind !== 'dialogue') return 'chat_active';
    return withFileLock(this.sessionLockPath(id), async () => {
      const directory = this.sessionActivityDirectory(id);
      if (!directory || !await this.readMetadata(id)) return 'not_found';
      const file = new SessionActivityClaimsFile(directory);
      const claims = (await file.read()).filter((entry) => entry.kind === 'dialogue' || this.isProcessAlive(entry.processId));
      const conflict = sessionActivityConflict(claims, dialogue);
      if (conflict && conflict !== 'chat_active') return conflict;
      const owner = claims[0];
      if (claims.length !== 1 || !owner || owner.processId !== this.processId || !sameSessionActivityClaim(owner, chat)) return 'chat_active';
      const tasks = await this.readTaskRecordsStrictForSession(id);
      const plan = await this.readRunPlanRecord(id);
      if (sessionDeletionBlockerFor(tasks) || plan?.status === 'applying') return 'tasks_active';
      await file.write([{ ...dialogue, processId: this.processId }]);
      return 'claimed';
    });
  }

  async restoreSessionChatFromDialogue(id: string, dialogueInput: SessionActivityClaimInput, chatInput: SessionActivityClaimInput): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    const dialogue = sessionActivityClaimInputSchema.parse(dialogueInput);
    const chat = sessionActivityClaimInputSchema.parse(chatInput);
    if (dialogue.kind !== 'dialogue' || chat.kind !== 'chat') return false;
    return withFileLock(this.sessionLockPath(id), async () => {
      const directory = this.sessionActivityDirectory(id);
      if (!directory || !await this.readMetadata(id)) return false;
      const file = new SessionActivityClaimsFile(directory);
      const claims = await file.read();
      const owner = claims[0];
      if (claims.length !== 1 || !owner || owner.processId !== this.processId || !sameSessionActivityClaim(owner, dialogue)) return false;
      await file.write([{ ...chat, processId: this.processId }]);
      return true;
    });
  }

  async listSessionActivityClaims(id: string): Promise<SessionActivityClaim[]> {
    if (!isValidSessionId(id)) return [];
    return withFileLock(this.sessionLockPath(id), async () => {
      const directory = this.sessionActivityDirectory(id);
      if (!directory) return [];
      if (!await this.readMetadata(id)) return [];
      return new SessionActivityClaimsFile(directory).read();
    });
  }

  async isSessionActivityOwnerAlive(id: string, input: SessionActivityClaimInput): Promise<boolean> {
    const claim = sessionActivityClaimInputSchema.parse(input);
    const claims = await this.listSessionActivityClaims(id);
    return claims.some((entry) => sameSessionActivityClaim(entry, claim) && this.isProcessAlive(entry.processId));
  }

  async reconcileOrphanedDialogueClaims(id: string, recordedDialogueIds: readonly string[]): Promise<void> {
    if (!isValidSessionId(id)) return;
    const recorded = new Set(z.array(z.uuid()).parse(recordedDialogueIds));
    await withFileLock(this.sessionLockPath(id), async () => {
      const directory = this.sessionActivityDirectory(id);
      if (!directory || !await this.readMetadata(id)) return;
      const file = new SessionActivityClaimsFile(directory);
      const claims = await file.read();
      const remaining = claims.filter((claim) =>
        claim.kind !== 'dialogue' || recorded.has(claim.claimId) || this.isProcessAlive(claim.processId));
      if (remaining.length !== claims.length) await file.write(remaining);
    });
  }

  dialogueRecordDirectory(id: string): string | undefined {
    const session = this.sessionActivityDirectory(id);
    if (!session) return undefined;
    if (!existsSync(this.metadataPath(id))) return undefined;
    const directory = path.join(session, 'dialogues');
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !resolveExistingPathInside(session, directory)) return undefined;
    } catch (error) {
      if (errnoCodeOf(error) !== 'ENOENT') throw error;
    }
    return directory;
  }

  private sessionActivityDirectory(id: string): string | undefined {
    if (!isValidSessionId(id)) return undefined;
    const directory = resolveRelativePathInside(this.sessionsDir, id);
    if (!directory) return undefined;
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    } catch (error) {
      if (errnoCodeOf(error) === 'ENOENT') return undefined;
      throw error;
    }
    return resolveExistingPathInside(this.sessionsDir, directory) ? directory : undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    return this.withOwnedWorkStopped([id], false, () => withFileLock(this.sessionLockPath(id), () => this.deleteSessionAfterWork(id)));
  }

  private async deleteSessionAfterWork(id: string): Promise<boolean> {
    if (!isValidSessionId(id)) return false;

    const dir = this.sessionDir(id);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) return false;
    } catch {
      return false;
    }

    const ownedAssignmentIds = await this.listOwnedRunAssignmentIds(id);
    await makeSessionRunSnapshotsWritable(dir);
    await fs.rm(dir, { recursive: true, force: true });
    await this.removeRunAssignmentIndexEntries(ownedAssignmentIds);
    return true;
  }

  async discardSessionIfEmpty(id: string): Promise<EmptySessionDiscardResult> {
    if (!isValidSessionId(id)) return "not_found";
    // The input lock is also used by REST uploads and MCP materialization.
    // The lifecycle lock excludes transcript appends, activity admission and
    // task publication throughout the empty check and deletion.
    return withFileMutationLock(this.inputsDir(id), () =>
      withFileLock(this.sessionLockPath(id), async () => {
        const directory = this.sessionActivityDirectory(id);
        if (!directory) return "not_found";
        const summary = await this.readMetadata(id);
        if (!summary) return "not_found";
        if (
          summary.status !== "idle" || summary.activityType !== "chat" ||
          summary.updatedAt !== summary.createdAt || summary.titleAttempts?.length || summary.origin
        ) return "not_empty";
        if ((await new SessionActivityClaimsFile(directory).read()).length > 0) return "not_empty";
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) return "not_empty";
          if (entry.name === "session.json" || entry.name === "activity-claims.json") continue;
          // Preserve even malformed transcript bytes. Every other entry,
          // including inputs, tasks, runs, folders and drafts, is saved work.
          if (entry.name !== "chat.jsonl") return "not_empty";
          const transcript = await fs.stat(path.join(directory, entry.name));
          if (transcript.size !== 0) return "not_empty";
        }
        await fs.rm(directory, { recursive: true, force: true });
        return "deleted";
      }),
    );
  }

  async deleteSessionIfNoActiveTasks(id: string): Promise<DeleteSessionResult> {
    return this.withOwnedWorkStopped<DeleteSessionResult>([id], { deleted: false, reason: 'process_cleanup_pending' }, () => this.deleteSessionAfterOwnedWork(id));
  }

  private async deleteSessionAfterOwnedWork(id: string): Promise<DeleteSessionResult> {
    if (!isValidSessionId(id)) return { deleted: false, reason: "not_found" };
    const dir = this.sessionDir(id);
    const exists = await fs.stat(dir).then((stat) => stat.isDirectory()).catch(() => false);
    if (!exists) return { deleted: false, reason: "not_found" };

    let ownedAssignmentIds: string[] = [];
    const result = await withFileLock(this.sessionLockPath(id), async () => {
      if (!await this.readMetadata(id)) return { deleted: false, reason: 'not_found' } as const;
      const claims = await new SessionActivityClaimsFile(this.sessionDir(id)).read();
      if (claims.some((claim) => claim.kind === 'dialogue')) return { deleted: false, reason: 'dialogue_active' } as const;
      const tasks = await this.readTaskRecordsStrictForSession(id);
      const blocker = sessionDeletionBlockerFor(tasks);
      if (blocker) return { deleted: false, reason: blocker } as const;
      ownedAssignmentIds = await this.listOwnedRunAssignmentIds(id);
      await makeSessionRunSnapshotsWritable(dir);
      await fs.rm(dir, { recursive: true, force: true });
      return { deleted: true } as const;
    });
    if (result.deleted) {
      await this.removeRunAssignmentIndexEntries(ownedAssignmentIds);
    }
    return result;
  }

  async deleteSessionsIfNoActiveTasks(ids: readonly string[]): Promise<DeleteSessionsResult> {
    return this.withOwnedWorkStopped<DeleteSessionsResult>(ids, { deleted: false, deletedSessionIds: [], reason: 'process_cleanup_pending' }, () => this.deleteSessionsAfterOwnedWork(ids));
  }

  private async withOwnedWorkStopped<T>(ids: readonly string[], blocked: T, run: () => Promise<T>): Promise<T> {
    const selected = [...new Set(ids)].filter(isValidSessionId).sort();
    const gates = await this.withSessionDeletionLocks(selected, 0, async () => selected.map((id) => closeSessionWork(this.workspacePath, id)));
    let clean = true;
    try {
      for (const gate of gates) if (!await gate.drain()) clean = false;
      return clean ? await run() : blocked;
    } finally { if (clean) for (const gate of gates) gate.reopen(); }
  }

  private async deleteSessionsAfterOwnedWork(
    ids: readonly string[],
  ): Promise<DeleteSessionsResult> {
    const sessionIds = [...new Set(ids)]
      .filter(isValidSessionId)
      .sort((left, right) => left.localeCompare(right));
    const assignmentIds = new Set<string>();
    const result = await this.withSessionDeletionLocks(
      sessionIds,
      0,
      async (): Promise<DeleteSessionsResult> => {
        const existingSessionIds: string[] = [];
        let cleanupPending = false;
        for (const sessionId of sessionIds) {
          const exists = await fs.stat(this.sessionDir(sessionId))
            .then((stat) => stat.isDirectory())
            .catch(() => false);
          if (!exists) continue;
          existingSessionIds.push(sessionId);
          const claims = await new SessionActivityClaimsFile(this.sessionDir(sessionId)).read();
          if (claims.some((claim) => claim.kind === 'dialogue')) return { deleted: false, deletedSessionIds: [], reason: 'dialogue_active' };
          const tasks = await this.readTaskRecordsStrictForSession(sessionId);
          const blocker = sessionDeletionBlockerFor(tasks);
          if (blocker === "active_tasks") {
            return {
              deleted: false,
              deletedSessionIds: [],
              reason: "active_tasks",
            };
          }
          if (blocker === "process_cleanup_pending") cleanupPending = true;
        }
        // Reported only once no session has an active task, which the person
        // can act on and is told about first.
        if (cleanupPending) {
          return {
            deleted: false,
            deletedSessionIds: [],
            reason: "process_cleanup_pending",
          };
        }

        for (const sessionId of existingSessionIds) {
          for (const assignmentId of await this.listOwnedRunAssignmentIds(sessionId)) {
            assignmentIds.add(assignmentId);
          }
          const directory = this.sessionDir(sessionId);
          await makeSessionRunSnapshotsWritable(directory);
          await fs.rm(directory, { recursive: true, force: true });
        }
        return {
          deleted: true,
          deletedSessionIds: existingSessionIds,
        };
      },
    );
    if (result.deleted) {
      await this.removeRunAssignmentIndexEntries(assignmentIds);
    }
    return result;
  }

  private withSessionDeletionLocks<T>(
    sessionIds: readonly string[],
    index: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const sessionId = sessionIds[index];
    if (!sessionId) return operation();
    return withFileLock(this.sessionLockPath(sessionId), () =>
      this.withSessionDeletionLocks(sessionIds, index + 1, operation),
    );
  }

  private async listOwnedRunAssignmentIds(id: string): Promise<string[]> {
    const runsDir = path.join(this.sessionDir(id), "runs");
    if (!existsSync(runsDir)) return [];
    if (!resolveExistingPathInside(this.sessionDir(id), runsDir)) return [];

    const assignmentIds = new Set<string>();
    const runEntries = await fs.readdir(runsDir, { withFileTypes: true });
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || !isSafePathSegment(runEntry.name)) continue;
      const assignmentsDir = path.join(runsDir, runEntry.name, "assignments");
      if (
        !existsSync(assignmentsDir) ||
        !resolveExistingPathInside(runsDir, assignmentsDir)
      ) {
        continue;
      }
      const assignmentEntries = await fs.readdir(assignmentsDir, {
        withFileTypes: true,
      });
      for (const assignmentEntry of assignmentEntries) {
        if (
          !assignmentEntry.isDirectory() ||
          !isSafePathSegment(assignmentEntry.name)
        ) {
          continue;
        }
        const location = buildSessionRunAssignmentLocation(this.workspacePath, {
          sessionId: id,
          runId: runEntry.name,
          assignmentId: assignmentEntry.name,
        });
        if (
          location &&
          resolveExistingPathInside(location.runPath, location.assignmentPath)
        ) {
          assignmentIds.add(assignmentEntry.name);
        }
      }
    }
    return [...assignmentIds];
  }

  private async removeRunAssignmentIndexEntries(
    assignmentIds: Iterable<string>,
  ): Promise<void> {
    const authorityWorkspacePath = await fs.realpath(this.workspacePath);
    await Promise.all(
      [...assignmentIds].map(async (assignmentId) => {
        await Promise.all([
          removeRunAssignmentLocator(this.workspacePath, assignmentId),
          removeRunAssignmentAuthorityGrant(
            authorityWorkspacePath,
            assignmentId,
          ),
        ]);
      }),
    );
  }

  async appendChatMessage(id: string, message: ChatMessage): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    const summary = await this.readMetadata(id);
    if (!summary) return false;

    await fs.mkdir(this.sessionDir(id), { recursive: true });
    const line = `${JSON.stringify(message)}\n`;
    await fs.appendFile(this.chatPath(id), line, "utf8");

    await withFileLock(this.sessionLockPath(id), async () => {
      const current = (await this.readMetadata(id)) ?? summary;
      await this.writeMetadata({
        ...current,
        updatedAt: message.createdAt,
      });
    });
    return true;
  }

  /**
   * Append a message only if that message id is not already on the transcript.
   *
   * `appendChatMessage` is a bare append: it neither checks for a duplicate nor
   * flushes, so a retry writes a second copy and a crash can lose a line the
   * caller was told was durable. Replay safety cannot rest on that, so a turn
   * that must be idempotent uses this instead.
   *
   * The whole operation runs under the session lock, so a concurrent duplicate
   * cannot read "absent" and then both write. The line is flushed with fsync
   * before the lock is released, so a caller told `appended` can rely on it
   * surviving a crash.
   *
   * - `appended` — the line is durable.
   * - `already-present` — the same id already holds the same content; the
   *   caller is replaying and must not write again.
   * - `conflict` — the same id already holds *different* content. That is a
   *   reused identity, and it fails closed rather than overwriting history.
   */
  async appendChatMessageIfAbsent(
    id: string,
    message: ChatMessage,
  ): Promise<
    | "appended"
    | "already-present"
    | "conflict"
    | "unknown-session"
    | "invalid-message"
  > {
    if (!isValidSessionId(id)) return "unknown-session";
    // Checked before anything is written. The reader refuses a version-2 line
    // it cannot understand whole, so writing one means telling the caller
    // `appended` — after an fsync — for a line that vanishes on the next
    // reload. Reporting durability for something no reader will return is the
    // worst of the available outcomes.
    if (readTranscriptMessage(JSON.parse(JSON.stringify(message))) === undefined) {
      return "invalid-message";
    }
    const chatPath = this.chatPath(id);
    const line = `${JSON.stringify(message)}\n`;

    return withFileLock(this.sessionLockPath(id), async () => {
      // Decided under the lock, not before it. Reading the metadata outside
      // meant an append could establish that a session existed, wait for the
      // lock while a deletion took it away, and then act on an answer that had
      // stopped being true — recreating the directory and rewriting the
      // metadata of a session someone had deleted. What came back was a
      // transcript with no session and a session with no history.
      const summary = await this.readMetadata(id);
      if (!summary) return "unknown-session";
      await fs.mkdir(this.sessionDir(id), { recursive: true });

      const existing = await readTranscriptLine(chatPath, message.id);
      if (existing !== undefined) {
        // Compared on canonical content rather than raw bytes so that key
        // order alone never reads as a conflict.
        if (canonicalMessage(existing) !== canonicalMessage(message)) {
          return "conflict";
        }
        // Visible is not durable. The attempt that wrote this line may have
        // failed at its barrier, and this retry is the acknowledgement the
        // caller acts on — so it clears the barrier itself rather than
        // inheriting an answer nobody checked.
        await this.flushTranscript(chatPath);
        return "already-present";
      }

      // Whether this append is the one that creates the transcript. Decided
      // under the session lock, so nothing can create it in between.
      const creating = !(await fs
        .lstat(chatPath)
        .then(() => true)
        .catch(() => false));

      // Opened without following a symlink: the transcript is private content
      // and must not be redirected by one.
      const handle = await fs.open(chatPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (creating) {
        // Flushing a file's contents does not flush the directory entry that
        // names it: after a crash the first message can be on disk with
        // nothing pointing at it, and the transcript reads as a session that
        // never said anything. Only the append that creates the file pays for
        // this — the entry is made once. The metadata write below happens to
        // flush the same directory today, but a durability guarantee that
        // depends on an unrelated write staying where it is, is not one.
        await this.syncDirectoryOfFile(chatPath);
      }

      const current = (await this.readMetadata(id)) ?? summary;
      await this.writeMetadata({
        ...current,
        updatedAt: message.createdAt,
      });
      return "appended";
    });
  }

  async saveUploadedFile(
    id: string,
    input: UploadFileInput,
  ): Promise<SessionFile | null> {
    if (!isValidSessionId(id)) return null;
    const summary = await this.readMetadata(id);
    if (!summary) return null;

    const filename = sanitizeUploadFilename(input.filename);
    if (!filename) return null;

    const repository = this.fileRepository(id);
    const existing = (await repository.list()).find(
      (file) => file.name === filename,
    );
    if (existing?.usedAt) return null;

    const result = await repository.save(
      filename,
      input.contents,
      { overwrite: true },
    );
    return result.status === "saved" ? result.file : null;
  }

  async listFiles(id: string): Promise<SessionFile[]> {
    if (!isValidSessionId(id)) return [];
    return this.fileRepository(id).list();
  }

  async deleteFile(id: string, filename: string): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    const summary = await this.readMetadata(id);
    if (!summary) return false;
    return this.fileRepository(id).delete(filename);
  }

  async deleteFileIfUnused(
    id: string,
    filename: string,
  ): Promise<SessionFileDeleteResult> {
    if (!isValidSessionId(id)) return "not_found";
    const summary = await this.readMetadata(id);
    if (!summary) return "not_found";
    return withFileMutationLock(this.inputsDir(id), () =>
      this.fileRepository(id).deleteIfUnused(filename),
    );
  }

  async lockFilesForChat(id: string): Promise<SessionFile[]> {
    if (!isValidSessionId(id)) return [];
    const summary = await this.readMetadata(id);
    if (!summary) return [];
    return withFileMutationLock(this.inputsDir(id), () =>
      this.fileRepository(id).markCurrentFilesUsed(),
    );
  }

  async readParsedText(
    id: string,
    outputName: string,
  ): Promise<string | null> {
    if (!isValidSessionId(id)) return null;
    return this.fileRepository(id).readParsedText(outputName);
  }

  async ensureAgentChatAssignment(
    id: string,
    runId: string,
    assignmentId: string,
  ): Promise<SessionRunAssignmentLocation | null> {
    if (
      !isValidSessionId(id) ||
      !isValidSessionId(runId) ||
      !isValidSessionId(assignmentId)
    ) {
      return null;
    }
    const location = buildSessionRunAssignmentLocation(this.workspacePath, {
      sessionId: id,
      runId,
      assignmentId,
    });
    if (!location) return null;

    return withFileLock(this.sessionLockPath(id), async () => {
      if (!await this.readMetadata(id)) return null;
      const directoryChain = [
        path.dirname(location.runPath),
        location.runPath,
        path.join(location.runPath, "assignments"),
        location.assignmentPath,
      ];
      let parentPath = this.sessionDir(id);
      for (const directoryPath of directoryChain) {
        const existing = await fs.lstat(directoryPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
          return null;
        }
        if (!existing) await fs.mkdir(directoryPath, { mode: 0o700 });
        const stat = await fs.lstat(directoryPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        await fs.chmod(directoryPath, 0o700);
        if (!resolveExistingPathInside(parentPath, directoryPath)) return null;
        parentPath = directoryPath;
      }
      await writeRunAssignmentLocator(this.workspacePath, location);
      return location;
    });
  }

  inputsDir(id: string): string {
    return path.join(this.sessionDir(id), "inputs");
  }

  private fileRepository(id: string): FileSourceRepository {
    return new FileSourceRepository({
      rootDir: this.inputsDir(id),
      containmentRoot: this.sessionDir(id),
    });
  }

  async createTaskRecord(
    id: string,
    input: CreateTaskInput,
    options: CreateTaskRecordOptions = {},
  ): Promise<SessionTask | null> {
    return this.withTaskPreparationClaim(id, () => this.taskAdmissionManager.createTaskRecord(id, input, options));
  }

  async updateTaskRecord(
    id: string,
    taskId: string,
    patch: SessionTaskPatch,
  ): Promise<SessionTask | null> {
    if (!isValidSessionId(id) || !isValidSessionId(taskId)) return null;
    const result = await this.compareAndSetTaskRecord(
      id,
      taskId,
      ["queued", "running", "awaiting_input", "awaiting_model_choice", "interrupted", "done", "failed", "blocked", "cancelled"],
      patch,
    );
    return result?.task ?? null;
  }

  async compareAndSetTaskRecord(
    id: string,
    taskId: string,
    expectedStatuses: readonly TaskStatus[],
    patch: SessionTaskPatch,
    options: TaskRecordCompareAndSetOptions = {},
  ): Promise<TaskRecordCompareAndSetResult | null> {
    return this.taskRepository.compareAndSetTaskRecord(
      id,
      taskId,
      expectedStatuses,
      patch,
      options,
    );
  }

  async getTaskRecord(id: string, taskId: string): Promise<SessionTask | null> {
    if (!isValidSessionId(id) || !isValidSessionId(taskId)) return null;
    return this.readTaskRecord(id, taskId);
  }

  async listTaskRecords(id: string): Promise<SessionTask[]> {
    if (!isValidSessionId(id)) return [];
    return this.reconcileTaskRecords(id);
  }

  async listTaskRecordsStrict(): Promise<SessionTask[]> {
    await this.ensureBaseDir();
    const sessionEntries = await fs.readdir(this.sessionsDir, {
      withFileTypes: true,
    });
    const tasks: SessionTask[] = [];
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || !isValidSessionId(sessionEntry.name)) {
        continue;
      }
      const summary = await this.readMetadata(sessionEntry.name);
      if (!summary || summary.id !== sessionEntry.name) {
        throw new Error(
          `Session metadata cannot be decoded: ${sessionEntry.name}`,
        );
      }
      tasks.push(...await this.readTaskRecordsStrictForSession(sessionEntry.name));
    }
    tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return tasks;
  }

  async repairStagedTaskAdmission(
    id: string,
    taskId: string,
  ): Promise<SessionTask | null> {
    return this.taskAdmissionManager.repairStagedTaskAdmission(id, taskId);
  }

  async recoverOrphanedRunPlanApplies(): Promise<boolean> {
    return this.runPlanCoordinator.recoverOrphanedRunPlanApplies();
  }

  async reconcileTaskRecords(id: string): Promise<SessionTask[]> {
    return this.taskRecoveryManager.reconcileSession(id);
  }

  async resolveTaskPublication(
    id: string,
    taskId: string,
    executionAttemptId: string,
  ): Promise<BatchTaskPublicationResolution> {
    return this.taskRecoveryManager.resolveTaskPublication(id, taskId, executionAttemptId);
  }

  async reconcileAdmittedTaskRecord(
    id: string,
    taskId: string,
  ): Promise<SessionTask | null> {
    return this.taskAdmissionManager.reconcileAdmittedTaskRecord(id, taskId);
  }

  ownsTaskProcess(task: SessionTask): boolean {
    return Boolean(
      task.ownerInstanceId && task.ownerInstanceId === this.instanceId,
    );
  }

  isTaskProcessAlive(task: SessionTask): boolean {
    const target = taskProcessTarget(task);
    return target != null && this.isProcessAlive(target);
  }

  hasValidTaskProcessIdentity(task: SessionTask): boolean {
    return this.isProcessIdentityValid(task);
  }

  isTaskProviderBrokerCompatible(task: SessionTask): boolean {
    return !task.configuredProviderBrokerIdentity ||
      task.configuredProviderBrokerIdentity ===
        this.currentConfiguredProviderBrokerIdentity;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  setConfiguredProviderBrokerUrl(url: string | undefined): void {
    this.currentConfiguredProviderBrokerIdentity =
      configuredProviderBrokerIdentity(url);
  }

  private async verifyWorkflowOutcomeArtifacts(
    task: SessionTask,
    outcome: DurableWorkflowTerminalOutcome,
  ): Promise<Array<{
    published: WorkflowPublishedArtifactReference;
    sourcePath: string;
  }>> {
    return this.taskRecoveryManager.verifyWorkflowOutcomeArtifacts(
      task,
      outcome,
    );
  }

  private async readTaskRecords(id: string): Promise<SessionTask[]> {
    return this.taskRepository.readTaskRecords(id);
  }

  private async readTaskRecordsStrictForSession(
    id: string,
  ): Promise<SessionTask[]> {
    return this.taskRepository.readTaskRecordsStrictForSession(id);
  }

  taskDir(sessionId: string, taskId: string): string {
    return this.taskRepository.taskDir(sessionId, taskId);
  }

  async getRunPlan(id: string): Promise<RunPlan | null> {
    return this.runPlanCoordinator.getRunPlan(id);
  }

  async saveRunPlan(id: string, plan: RunPlan): Promise<boolean> {
    return this.runPlanCoordinator.saveRunPlan(id, plan);
  }

  async reviseRunPlan(
    id: string,
    expectedPlanId: string | null,
    nextPlan: RunPlan,
  ): Promise<RunPlanRevisionResult | null> {
    return this.runPlanCoordinator.reviseRunPlan(
      id,
      expectedPlanId,
      nextPlan,
    );
  }

  async claimRunPlanForApply(
    id: string,
    planId: string,
  ): Promise<RunPlanApplyClaimResult | null> {
    return this.withTaskPreparationClaim(id, () => this.runPlanCoordinator.claimRunPlanForApply(id, planId));
  }

  private async withTaskPreparationClaim<T>(id: string, prepare: () => Promise<T | null>): Promise<T | null> {
    const claim = { kind: 'task' as const, claimId: crypto.randomUUID(), ownerLaunchId: this.instanceId };
    const result = await this.claimSessionActivity(id, claim);
    if (result === 'not_found') return null;
    if (result !== 'claimed') throw new SessionActivityConflictError(result);
    let failure: { cause: unknown } | undefined;
    try { return await prepare(); } catch (cause) { failure = { cause }; throw cause; } finally {
      if (!failure) await this.releaseSessionActivity(id, claim);
      else await releaseSessionActivityAfterFailure({
        sessionId: id,
        claimId: claim.claimId,
        cause: failure.cause,
        release: () => this.releaseSessionActivity(id, claim),
      });
    }
  }

  async recoverRunPlanApply(
    id: string,
    planId: string,
  ): Promise<RunPlan | null> {
    return this.runPlanCoordinator.recoverRunPlanApply(id, planId);
  }

  async finalizeRunPlanApply(
    id: string,
    planId: string,
    claimId: string,
    nextPlan: RunPlan,
  ): Promise<RunPlan | null> {
    return this.runPlanCoordinator.finalizeRunPlanApply(
      id,
      planId,
      claimId,
      nextPlan,
    );
  }

  async markRunPlanRunningIfQueued(
    id: string,
    planId: string,
    taskId: string,
    executionAttemptId: string,
  ): Promise<RunPlan | null> {
    return this.runPlanCoordinator.markRunPlanRunningIfQueued(
      id,
      planId,
      taskId,
      executionAttemptId,
    );
  }

  private async reconcileTaskRecord(
    id: string,
    taskId: string,
    knownTask?: SessionTask,
    allowAdmission = false,
  ): Promise<void> {
    await this.taskRecoveryManager.reconcileTaskRecord(
      id,
      taskId,
      knownTask,
      allowAdmission,
    );
  }

  private async tryRepairTerminalTaskResult(
    task: SessionTask,
  ): Promise<void> {
    await this.taskRecoveryManager.tryRepairTerminalTaskResult(task);
  }

  private async finalizeTerminalTask(
    id: string,
    task: SessionTask,
  ): Promise<void> {
    await this.taskRecoveryManager.finalizeTerminalTask(id, task);
    // `assignmentId` is optional on a task record, and a task without one is
    // not a task without an assignment: the worker is launched with
    // `task.assignmentId ?? task.runId` (`services/task-service.ts`) and
    // recovery resolves the same scope the same way, so a journal exists
    // under `runId`. Returning here instead — which is what this used to do —
    // left that journal open, and its index in memory, for the lifetime of
    // the process, with nothing to surface it (AC18).
    const scope: SessionTaskTerminalAssignment = {
      sessionId: task.sessionId,
      runId: task.runId,
      assignmentId: task.assignmentId ?? task.runId,
    };
    await Promise.allSettled(
      [...this.terminalTaskListeners].map((listener) => listener(scope)),
    );
  }

  private async recomputeSessionLifecycle(id: string): Promise<void> {
    await this.taskRecoveryManager.recomputeSessionLifecycle(id);
  }

  private async readRunPlanRecord(id: string): Promise<RunPlan | null> {
    return this.runPlanCoordinator.readRunPlanRecord(id);
  }

  private async readTaskRecord(
    id: string,
    taskId: string,
  ): Promise<SessionTask | null> {
    return this.taskRepository.readTaskRecord(id, taskId);
  }

  private async writeTaskRecord(
    id: string,
    taskId: string,
    record: SessionTask,
  ): Promise<void> {
    await this.taskRepository.writeTaskRecord(id, taskId, record);
  }

  async listChatMessages(id: string): Promise<ChatMessage[]> {
    if (!isValidSessionId(id)) return [];
    try {
      const raw = await fs.readFile(this.chatPath(id), "utf8");
      const messages: ChatMessage[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const message = readTranscriptMessage(JSON.parse(trimmed));
          if (message) messages.push(message);
        } catch {
          // Skip malformed lines.
        }
      }
      return messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listResultReferences(id: string): Promise<ResultReference[]> {
    if (!isValidSessionId(id)) return [];
    try {
      const raw = await fs.readFile(this.resultsPath(id), "utf8");
      const references: ResultReference[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          // A record this build cannot read is skipped rather than fatal. One
          // unreadable reference costs a continuation nobody is offered; a
          // throw here would cost the session.
          const reference = parseResultReference(JSON.parse(trimmed));
          if (reference && reference.sessionId === id) references.push(reference);
          // Appended, not replaced: the log stays append-only, and the reader
          // below keeps the last record for an id. That is what lets a record
          // written before provenance existed be upgraded in place.
        } catch {
          // Skip malformed lines.
        }
      }
      // Last record for an id wins, in first-seen order, so an upgraded record
      // supersedes the one it repaired without the reader seeing both.
      const latest = new Map<string, ResultReference>();
      for (const reference of references) latest.set(reference.id, reference);
      return [...latest.values()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async publishResultReference(
    id: string,
    reference: ResultReference,
  ): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    if (reference.sessionId !== id) return false;
    if (!(await this.readMetadata(id))) return false;
    // Under the session lock so two processes finishing the same run cannot
    // both find the id absent and both append it.
    return withFileLock(this.sessionLockPath(id), async () => {
      const existing = await this.listResultReferences(id);
      const held = existing.find((candidate) => candidate.id === reference.id);
      // An id already held is written again only to repair it: a record from
      // before provenance was recorded cannot be re-verified at use time, and
      // refusing the upgrade would leave it permanently unusable.
      if (held && !upgradesProvenance(held, reference)) return false;
      await fs.mkdir(this.sessionDir(id), { recursive: true });
      await fs.appendFile(
        this.resultsPath(id),
        `${JSON.stringify(reference)}\n`,
        "utf8",
      );
      return true;
    });
  }

  private resultsPath(id: string): string {
    return path.join(this.sessionDir(id), "results.jsonl");
  }

  private get sessionsDir(): string {
    return path.join(this.workspacePath, "sessions");
  }

  private sessionDir(id: string): string {
    if (!isValidSessionId(id)) throw new Error("Invalid session id");
    const sessionDir = resolveRelativePathInside(this.sessionsDir, id);
    if (!sessionDir) throw new Error("Session path must stay inside sessions");
    if (
      existsSync(sessionDir) &&
      !resolveExistingPathInside(this.sessionsDir, sessionDir)
    ) {
      throw new Error("Session path must stay inside sessions");
    }
    return sessionDir;
  }

  private metadataPath(id: string): string {
    return path.join(this.sessionDir(id), "session.json");
  }

  private chatPath(id: string): string {
    return path.join(this.sessionDir(id), "chat.jsonl");
  }

  private runPlanPath(id: string): string {
    return path.join(this.sessionDir(id), "run-plan.json");
  }

  private sessionLockPath(id: string): string {
    if (!isValidSessionId(id)) throw new Error("Invalid session id");
    return path.join(this.sessionsDir, ".locks", `${id}.lock`);
  }

  private async ensureBaseDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  private async readMetadata(id: string): Promise<SessionSummary | null> {
    try {
      const raw = await fs.readFile(this.metadataPath(id), "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSummary>;
      if (typeof parsed.id !== "string" || typeof parsed.title !== "string") {
        return null;
      }
      if (parsed.origin !== undefined && !isSessionOrigin(parsed.origin)) {
        return null;
      }
      // Refused whole rather than filtered. Dropping the entries this cannot
      // rebuild and carrying on would let the next unrelated title or status
      // update write the survivors back, silently erasing the account of a
      // model that really was used. Absent is not corrupt: a session written
      // before this existed knows nothing, and keeps knowing nothing.
      let titleAttempts: readonly SessionTitleAttempt[] | undefined;
      if (parsed.titleAttempts !== undefined) {
        const read = sessionTitleAttemptsSchema.safeParse(parsed.titleAttempts);
        if (!read.success) return null;
        titleAttempts = read.data;
      }

      return {
        id: parsed.id,
        title: parsed.title,
        status: normalizeStatus(parsed.status),
        activityType: normalizeActivityType(parsed.activityType),
        ...(parsed.origin ? { origin: parsed.origin } : {}),
        ...(titleAttempts === undefined ? {} : { titleAttempts }),
        createdAt:
          typeof parsed.createdAt === "string"
            ? parsed.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof parsed.updatedAt === "string"
            ? parsed.updatedAt
            : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Appends one title attempt to a session, under that session's own lock.
   *
   * Written immediately before the send it describes, so a record exists even
   * when the provider then fails or returns nothing usable. Appending rather
   * than replacing is the point: an earlier attempt on a different default is
   * an account of a model that really was used, and must survive a later one.
   *
   * The attempt is validated against the same schema the read uses, before
   * anything is written. A value this accepted but the read could not rebuild
   * would make the whole session unreadable on its next reload.
   *
   * Answers `false` when the session is gone, the attempt is not valid, or the
   * history already there cannot be read. A filesystem failure rejects instead:
   * swallowing I/O here would hide a broken workspace from every caller, and
   * the one that knows this work is optional is the one that catches it.
   */
  async appendSessionTitleAttempt(
    id: string,
    attempt: SessionTitleAttempt,
  ): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    if (!existsSync(this.metadataPath(id))) return false;
    const validated = sessionTitleAttemptSchema.safeParse(attempt);
    if (!validated.success) return false;
    return withFileLock(this.sessionLockPath(id), async () => {
      const summary = await this.readMetadata(id);
      if (!summary) return false;
      const existing = summary.titleAttempts ?? [];
      // One identity is one attempt. Two entries sharing one could not be told
      // apart afterwards, so the history would stop being able to say how many
      // attempts there were.
      if (existing.some((entry) => entry.attemptId === validated.data.attemptId)) {
        return false;
      }
      const next: SessionSummary = {
        ...summary,
        titleAttempts: [...existing, validated.data],
        updatedAt: this.now().toISOString(),
      };
      await this.writeMetadata(next);
      return true;
    });
  }

  private async writeMetadata(summary: SessionSummary): Promise<void> {
    await writeJsonAtomic(this.metadataPath(summary.id), summary);
  }

  /**
   * Make an existing transcript durable, contents and name both.
   *
   * Opened for append rather than for reading, because flushing a descriptor
   * that was never opened for writing is not portable. Nothing is written.
   */
  private async flushTranscript(chatPath: string): Promise<void> {
    const handle = await fs.open(
      chatPath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectoryOfFile(chatPath);
  }
}

/** Why a session cannot be deleted yet. */
export type SessionDeletionBlocker = "active_tasks" | "process_cleanup_pending" | 'dialogue_active';

/**
 * What keeps a task's session from being deleted, if anything.
 *
 * A task that is active or interrupted, or that still holds an admission, is
 * an active task. One that has otherwise ended, but whose descendants cannot
 * be verified gone, keeps its record while its `processCleanupHold` stands:
 * the record carries the hold, its scope lives in the task's folder, and an
 * earlier-version task's legacy-active slot is released once the queue no
 * longer finds the record. Nobody can cancel that away, so it is reported as
 * pending cleanup rather than as an active task, even when the hold kept its
 * admission. Project deletion uses this same rule.
 */
export function sessionDeletionBlocker(task: SessionTask): SessionDeletionBlocker | undefined {
  if (isActiveTaskStatus(task.status) || task.status === "interrupted") return "active_tasks";
  if (task.processCleanupHold !== undefined) return "process_cleanup_pending";
  if (
    task.admission?.phase === "staged" ||
    task.admission?.phase === "pending" ||
    task.admission?.phase === "granted"
  ) {
    return "active_tasks";
  }
  return undefined;
}

/**
 * What keeps these tasks' sessions from being deleted: an active task first,
 * since the person can act on it, then pending cleanup.
 */
export function sessionDeletionBlockerFor(
  tasks: readonly SessionTask[],
): SessionDeletionBlocker | undefined {
  const blockers = tasks.map(sessionDeletionBlocker);
  if (blockers.includes("active_tasks")) return "active_tasks";
  if (blockers.includes("process_cleanup_pending")) return "process_cleanup_pending";
  return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
  );
}

/**
 * The single transcript line carrying one message id, if it is there.
 *
 * Reads the file rather than an index because the transcript is the authority
 * and an index could disagree with it. Malformed lines are skipped: one bad
 * line must not make a whole transcript unappendable.
 */
async function readTranscriptLine(
  chatPath: string,
  messageId: string,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(chatPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Narrowed through the same guard the message reader uses, so the two
      // readers of this file cannot disagree about what a line even is.
      if (isTranscriptRecord(parsed) && parsed.id === messageId) return parsed;
    } catch {
      // Skip malformed lines.
    }
  }
  return undefined;
}

/** Key-order-independent content, so ordering alone never reads as a conflict. */
function canonicalMessage(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isTranscriptRecord(value)) return value;
  const record = value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeysDeep(record[key]);
  }
  return sorted;
}

/**
 * One transcript line, or nothing when this build cannot read it whole.
 *
 * Two versions, told apart explicitly rather than by which fields happen to be
 * present. A line with no `schemaVersion` was written before conversations
 * existed and stays exactly as readable as it was — as long as it really is
 * one. A line carrying a field a v1 writer could not have produced has not
 * declared what it is: an old build ignores the pointer, this one would follow
 * it, and two builds reading one line differently is the disagreement a version
 * exists to prevent. Such a line is refused rather than half-trusted, and the
 * writer refuses to create one in the first place.
 *
 * A version-2 line is all-or-nothing. Dropping the fields nobody understood and
 * keeping the message was the dangerous half-measure: every reader downstream
 * selects by role, so a line whose `kind` said it was not ordinary chat came
 * back looking exactly like ordinary chat and went into the next prompt — the
 * silent context change that `kind` exists to prevent. So the whole
 * relationship is required, and a line missing any of it is not read at all.
 *
 * A version this build has never heard of is the same problem stated plainly:
 * whatever it means, it is not something to guess at.
 */
function readTranscriptMessage(raw: unknown): ChatMessage | undefined {
  // A guard, not an assertion. This is an external file boundary: the bytes
  // were written by some other build, or by nobody in particular, and a cast
  // here would be a promise about them that nothing checks.
  if (!isTranscriptRecord(raw)) return undefined;
  const fields = raw;
  const id = fields.id;
  const text = fields.text;
  const createdAt = fields.createdAt;
  const role = fields.role;
  if (
    typeof id !== "string" ||
    typeof text !== "string" ||
    typeof createdAt !== "string"
  ) {
    return undefined;
  }
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return undefined;
  }

  const turnId = typeof fields.turnId === "string" ? fields.turnId : undefined;
  // Validated from `unknown` rather than asserted. Each is kept beside the raw
  // field so the two questions stay separate: whether the line carried it, and
  // whether what it carried can be read.
  const speaker = isChatMessageSpeaker(fields.speaker) ? fields.speaker : undefined;
  const turnRequest = readChatTurnRequest(fields.turnRequest);
  const delivery = isChatMessageDelivery(fields.delivery)
    ? fields.delivery
    : undefined;
  const outcome = isChatMessageOutcome(fields.outcome)
    ? fields.outcome
    : undefined;
  // These two pointers are what lead an operator from a message to the durable
  // evidence for it.
  const execution = readChatMessageExecutionReference(raw);
  const conversation = readChatMessageConversationReference(raw);
  const parsedCutOff = fields.cutOff === undefined ? undefined : chatMessageCutOffSchema.safeParse(fields.cutOff);
  const cutOff = parsedCutOff?.success ? parsedCutOff.data : undefined;
  const base: ChatMessage = {
    id,
    role,
    text,
    createdAt,
    ...whenPresent(speaker, (present) => ({ speaker: present })),
    ...(turnId === undefined ? {} : { turnId }),
    ...whenPresent(turnRequest, (present) => ({ turnRequest: present })),
    ...whenPresent(delivery, (present) => ({ delivery: present })),
    ...whenPresent(outcome, (present) => ({ outcome: present })),
    ...whenPresent(execution, (present) => ({ execution: present })),
    ...whenPresent(conversation, (present) => ({ conversation: present })),
    ...whenPresent(cutOff, (present) => ({ cutOff: present })),
  };

  // Fields a version-1 reader could not have understood. A line carrying one
  // without declaring the version is not a version-1 line — it is a line two
  // builds read differently, one ignoring a pointer the other follows — so it
  // is refused rather than half-read.
  const claimsConversation =
    fields.conversationId !== undefined ||
    fields.kind !== undefined ||
    fields.source !== undefined ||
    fields.conversation !== undefined ||
    fields.cutOff !== undefined;

  if (fields.schemaVersion === undefined) {
    return claimsConversation ? undefined : base;
  }
  if (fields.schemaVersion !== 2) return undefined;

  // All-or-nothing means present-and-unreadable too. Dropping a field the line
  // really carried and keeping the rest hands on a message that is missing
  // exactly the part nobody could check — a reply whose evidence pointer was
  // silently discarded reads as a reply that has none.
  if (fields.turnId !== undefined && turnId === undefined) return undefined;
  if (fields.speaker !== undefined && speaker === undefined) return undefined;
  if (fields.turnRequest !== undefined && turnRequest === undefined) {
    return undefined;
  }
  if (fields.delivery !== undefined && delivery === undefined) return undefined;
  if (fields.outcome !== undefined && outcome === undefined) return undefined;
  if (fields.execution !== undefined && execution === undefined) return undefined;
  if (fields.conversation !== undefined && conversation === undefined) {
    return undefined;
  }
  if (fields.cutOff !== undefined && cutOff === undefined) return undefined;

  if (!isConversationMessageKind(fields.kind)) return undefined;
  if (!isConversationMessageSource(fields.source)) return undefined;
  if (fields.source.kind === "agent-dialogue") {
    if (fields.conversationId !== undefined || conversation !== undefined || role === "system") return undefined;
    if (role === "assistant" && (speaker === undefined || turnId === undefined || turnId.length === 0)) return undefined;
    if (role !== "assistant" && cutOff !== undefined) return undefined;
    return { ...base, schemaVersion: 2, kind: fields.kind, source: fields.source };
  }
  if (cutOff !== undefined) return undefined;

  const conversationId = fields.conversationId;
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return undefined;
  }
  // The line, its source and its turn have to agree. A source naming a
  // different turn than the line claims describes two turns at once, and there
  // is no reading of that which is safe to hand to a replay.
  if (turnId === undefined || fields.source.turnId !== turnId) return undefined;

  // The pointer stays optional, as the ADR has it. But when it is there it is
  // what an operator follows from a message to its durable evidence, so a
  // pointer that disagrees with the line it sits on is worse than none: it
  // leads somewhere, and somewhere is the wrong turn.
  if (base.conversation) {
    const pointer = base.conversation;
    if (
      pointer.conversationId !== conversationId ||
      pointer.activityId !== turnId ||
      pointer.turnId !== turnId
    ) {
      return undefined;
    }
  }

  return {
    ...base,
    schemaVersion: 2 as const,
    conversationId,
    kind: fields.kind,
    source: fields.source,
  };
}

/** Spread a value only when it is there, without an intermediate cast. */
function whenPresent<TValue, TShape extends object>(
  value: TValue | undefined,
  shape: (value: TValue) => TShape,
): TShape | Record<string, never> {
  return value === undefined ? {} : shape(value);
}

/** A JSON object read from the transcript, narrowed rather than asserted. */
function isTranscriptRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
