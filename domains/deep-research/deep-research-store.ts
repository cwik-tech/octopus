import { whenDefined } from '../../core/optional-properties.js'
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  acquireProcessFileLock,
  crossProcessFileLockAdapter,
  defaultIsProcessAlive,
  ProcessFileLockError,
} from "../../core/cross-process-file-lock.js";
import {
  DEEP_RESEARCH_SCHEMA_VERSION,
  type ResearchArtifactReceipt,
  type ResearchExecutionManifest,
  type ResearchJournal,
  type ResearchRunSnapshot,
  type ResearchRunStatus,
  type ResearchStoreEvent,
  type ResearchWorkItem,
  type ResearchWorkItemStatus,
} from "../../contracts/deep-research.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import { isSafePathSegment } from "../../core/path-safety.js";
import {
  getRunRuntimePaths,
  resolveOwnedRunRelativePath,
} from "../../domains/runtime/runtime-paths.js";
import type { ResearchJournalRecorder } from "./research-journal.js";

export const RESEARCH_RUNTIME_DIRECTORY = "research" as const;
export const RESEARCH_MANIFEST_FILENAME = "execution-manifest.json" as const;
export const RESEARCH_JOURNAL_FILENAME = "research-journal.json" as const;
export const RESEARCH_EVENTS_FILENAME = "events.jsonl" as const;
export const RESEARCH_WORK_ITEMS_DIRECTORY = "work-items" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const TERMINAL_RUN_STATUSES = new Set<ResearchRunStatus>([
  "approved",
  "escalated",
  "cancelled",
  "timed_out",
]);
const RUN_TRANSITIONS: Readonly<
  Record<ResearchRunStatus, ReadonlySet<ResearchRunStatus>>
> = {
  planned: new Set(["running", "cancelled"]),
  running: new Set([
    "correcting",
    "synthesizing",
    "reviewing",
    "escalated",
    "cancelled",
    "timed_out",
  ]),
  correcting: new Set([
    "running",
    "synthesizing",
    "escalated",
    "cancelled",
    "timed_out",
  ]),
  synthesizing: new Set(["reviewing", "escalated", "cancelled", "timed_out"]),
  reviewing: new Set([
    "approved",
    "correcting",
    "escalated",
    "cancelled",
    "timed_out",
  ]),
  approved: new Set(),
  escalated: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

export type ResearchRunStoreErrorCode =
  | "already_exists"
  | "artifact_invalid"
  | "corrupt"
  | "identity_mismatch"
  | "invalid_state"
  | "lock_timeout"
  | "not_found"
  | "ownership_conflict"
  | "revision_conflict";

export class ResearchRunStoreError extends Error {
  constructor(
    readonly code: ResearchRunStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResearchRunStoreError";
  }
}

export interface ResearchRunStorePaths {
  readonly runtimePath: string;
  readonly manifestPath: string;
  readonly journalPath: string;
  readonly eventsPath: string;
  readonly workItemsPath: string;
  readonly lockPath: string;
}

export interface ResearchRunStoreOptions {
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly processId?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
  /**
   * When provided, every mutation is journaled first and the on-disk
   * research files become a projection of the canonical journal (Phase 8
   * ADR §10). Legacy runs omit this and keep the events.jsonl authority.
   */
  readonly journal?: ResearchJournalRecorder;
}

export interface ResearchWorkItemSeed {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly workerSpecHash: string;
}

export interface InitializeResearchRunInput {
  readonly manifest: Omit<
    ResearchExecutionManifest,
    "schemaVersion" | "createdAt"
  > & {
    readonly createdAt?: string;
  };
  readonly executionAttemptId: string;
  readonly workItems: readonly ResearchWorkItemSeed[];
}

export interface UpdateResearchJournalInput {
  readonly expectedRevision: number;
  readonly executionAttemptId: string;
  readonly mutate: (
    draft: MutableResearchJournal,
  ) => void | MutableResearchJournal;
}

export type MutableResearchJournal = {
  -readonly [Key in keyof ResearchJournal]: ResearchJournal[Key];
};

export interface BeginResearchWorkItemInput {
  readonly taskId: string;
  readonly expectedAttempt: number;
  readonly executionAttemptId: string;
}

export interface CommitResearchReceiptInput {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly attempt: number;
  readonly workerSpecHash: string;
  readonly relativePath: string;
  readonly completedAt?: string;
}

interface LockOptions {
  readonly processId: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly timeoutMs: number;
  readonly retryMs: number;
}

export class FileSystemResearchRunStore {
  readonly paths: ResearchRunStorePaths;

  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly lockOptions: LockOptions;
  private readonly journal: ResearchJournalRecorder | undefined;

  constructor(
    readonly assignmentPath: string,
    options: ResearchRunStoreOptions = {},
  ) {
    const normalizedAssignmentPath = path.resolve(assignmentPath);
    const { privateRuntimePath } = getRunRuntimePaths(normalizedAssignmentPath);
    const runtimePath = path.join(
      privateRuntimePath,
      RESEARCH_RUNTIME_DIRECTORY,
    );
    this.assignmentPath = normalizedAssignmentPath;
    this.paths = {
      runtimePath,
      manifestPath: path.join(runtimePath, RESEARCH_MANIFEST_FILENAME),
      journalPath: path.join(runtimePath, RESEARCH_JOURNAL_FILENAME),
      eventsPath: path.join(runtimePath, RESEARCH_EVENTS_FILENAME),
      workItemsPath: path.join(runtimePath, RESEARCH_WORK_ITEMS_DIRECTORY),
      lockPath: path.join(runtimePath, "research.lock"),
    };
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.lockOptions = {
      processId: options.processId ?? process.pid,
      isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      retryMs: options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    };
    this.journal = options.journal;
  }

  async initialize(
    input: InitializeResearchRunInput,
  ): Promise<ResearchRunSnapshot> {
    return this.withLock(async () => {
      assertSafeId(input.executionAttemptId, "Execution attempt ID");
      const existingManifest = await readJson(this.paths.manifestPath);
      const existingJournal = await readJson(this.paths.journalPath);
      const validatedExistingManifest = existingManifest
        ? validateManifest(existingManifest)
        : undefined;
      const manifest = buildManifest(
        {
          ...input.manifest,
          ...whenDefined(input.manifest.createdAt ?? validatedExistingManifest?.createdAt, (definedValue) => ({ createdAt: definedValue })),
        },
        this.now,
      );
      if (existingManifest || existingJournal) {
        if (!existingManifest || !existingJournal)
          corrupt("Research run initialization is incomplete.");
        const snapshot = await this.loadUnlocked();
        if (!sameJson(snapshot.manifest, manifest)) {
          throw new ResearchRunStoreError(
            "already_exists",
            "A different research manifest already owns this run.",
          );
        }
        if (
          snapshot.journal.ownerExecutionAttemptId !== input.executionAttemptId
        ) {
          throw new ResearchRunStoreError(
            "ownership_conflict",
            "Research run is owned by another execution attempt.",
          );
        }
        assertSeedsMatch(snapshot.workItems, input.workItems);
        return snapshot;
      }
      const workItems = buildWorkItems(input.workItems);
      const timestamp = manifest.createdAt;
      const journal: ResearchJournal = {
        schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
        revision: 0,
        ownerExecutionAttemptId: input.executionAttemptId,
        status: "planned",
        correctionWave: 0,
        workItemIds: workItems.map((item) => item.taskId),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.journalSnapshot({ manifest, journal, workItems }, true);
      await ensurePrivateDirectories(this.paths);
      await writeJsonAtomic(this.paths.manifestPath, manifest);
      for (const workItem of workItems) await this.writeWorkItem(workItem);
      await writeJsonAtomic(this.paths.journalPath, journal);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.initialized",
          journal.revision,
          undefined,
          {},
        );
      return cloneJson({ manifest, journal, workItems });
    });
  }

  async load(): Promise<ResearchRunSnapshot | null> {
    const manifest = await readJson(this.paths.manifestPath);
    const journal = await readJson(this.paths.journalPath);
    if (!manifest && !journal) return null;
    if (!manifest || !journal)
      corrupt("Research run requires both manifest and journal files.");
    return this.loadUnlocked();
  }

  async requireSnapshot(): Promise<ResearchRunSnapshot> {
    const snapshot = await this.load();
    if (!snapshot)
      throw new ResearchRunStoreError(
        "not_found",
        "Research run was not found.",
      );
    return snapshot;
  }

  /**
   * Publish the research files as a derived projection (Phase 8 ADR §10).
   * Used by journal replay; it never appends to the journal itself.
   */
  async writeResearchProjection(snapshot: ResearchRunSnapshot): Promise<void> {
    const manifest = validateManifest(snapshot.manifest);
    const journal = validateJournal(snapshot.journal);
    const workItems = snapshot.workItems.map((item) => validateWorkItem(item));
    await ensurePrivateDirectories(this.paths);
    await writeJsonAtomic(this.paths.manifestPath, manifest);
    for (const workItem of workItems) await this.writeWorkItem(workItem);
    await writeJsonAtomic(this.paths.journalPath, journal);
  }

  /**
   * Journal-first publication (Phase 8 ADR §10): when a journal recorder is
   * attached, the full validated snapshot is durably appended before the
   * on-disk research files are (re)written. Without a recorder the legacy
   * events.jsonl append path is preserved unchanged.
   */
  private async journalSnapshot(
    snapshot: ResearchRunSnapshot,
    includeManifest: boolean,
  ): Promise<void> {
    if (!this.journal) return;
    await this.journal.recordSnapshot(
      snapshot,
      includeManifest ? { includeManifest: true } : {},
    );
  }

  async updateJournal(
    input: UpdateResearchJournalInput,
  ): Promise<ResearchJournal> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      assertRevision(snapshot.journal, input.expectedRevision);
      assertOwner(snapshot.journal, input.executionAttemptId);
      if (TERMINAL_RUN_STATUSES.has(snapshot.journal.status)) {
        throw new ResearchRunStoreError(
          "invalid_state",
          "Terminal research journals are immutable.",
        );
      }
      const draft = cloneJson(snapshot.journal) as MutableResearchJournal;
      const candidate = input.mutate(draft) ?? draft;
      assertJournalControlledFields(snapshot.journal, candidate);
      candidate.revision = snapshot.journal.revision + 1;
      candidate.updatedAt = this.now().toISOString();
      validateJournalTransition(snapshot.journal, candidate);
      validateJournal(candidate);
      await this.journalSnapshot(
        { manifest: snapshot.manifest, journal: candidate, workItems: snapshot.workItems },
        false,
      );
      await writeJsonAtomic(this.paths.journalPath, candidate);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.journal.updated",
          candidate.revision,
          undefined,
          {
            status: candidate.status,
            correctionWave: candidate.correctionWave,
          },
        );
      return cloneJson(candidate);
    });
  }

  async addWorkItems(input: {
    readonly expectedRevision: number;
    readonly executionAttemptId: string;
    readonly workItems: readonly ResearchWorkItemSeed[];
  }): Promise<ResearchRunSnapshot> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      assertRevision(snapshot.journal, input.expectedRevision);
      assertOwner(snapshot.journal, input.executionAttemptId);
      if (snapshot.journal.status !== "correcting") {
        throw new ResearchRunStoreError(
          "invalid_state",
          "New research tasks may be added only during correction.",
        );
      }
      const existingIds = new Set(
        snapshot.workItems.map((item) => item.taskId),
      );
      const additions = buildWorkItems(input.workItems);
      if (additions.some((item) => existingIds.has(item.taskId))) {
        throw new ResearchRunStoreError(
          "already_exists",
          "Correction task ID already exists.",
        );
      }
      const journal: ResearchJournal = {
        ...snapshot.journal,
        revision: snapshot.journal.revision + 1,
        workItemIds: [
          ...snapshot.journal.workItemIds,
          ...additions.map((item) => item.taskId),
        ],
        updatedAt: this.now().toISOString(),
      };
      validateJournal(journal);
      const nextWorkItems = [...snapshot.workItems, ...additions];
      await this.journalSnapshot(
        { manifest: snapshot.manifest, journal, workItems: nextWorkItems },
        false,
      );
      for (const workItem of additions) await this.writeWorkItem(workItem);
      await writeJsonAtomic(this.paths.journalPath, journal);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.work_items.added",
          journal.revision,
          undefined,
          {
            count: additions.length,
          },
        );
      return cloneJson({
        manifest: snapshot.manifest,
        journal,
        workItems: nextWorkItems,
      });
    });
  }

  async beginWorkItem(
    input: BeginResearchWorkItemInput,
  ): Promise<ResearchWorkItem> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      assertOwner(snapshot.journal, input.executionAttemptId);
      if (!["running", "correcting"].includes(snapshot.journal.status)) {
        throw new ResearchRunStoreError(
          "invalid_state",
          "Research work can start only while the run is active.",
        );
      }
      const item = requireWorkItem(snapshot, input.taskId);
      if (item.attempt !== input.expectedAttempt) {
        throw new ResearchRunStoreError(
          "revision_conflict",
          "Research work-item attempt changed.",
        );
      }
      if (!["pending", "interrupted", "failed"].includes(item.status)) {
        throw new ResearchRunStoreError(
          "invalid_state",
          `Cannot start work item from '${item.status}'.`,
        );
      }
      const {
        completedAt: _completedAt,
        errorCode: _errorCode,
        ...restartableItem
      } = item;
      const candidate: ResearchWorkItem = {
        ...restartableItem,
        attempt: item.status === "failed" ? item.attempt + 1 : item.attempt,
        status: "running",
        startedAt: this.now().toISOString(),
      };
      validateWorkItem(candidate);
      await this.journalSnapshot(
        {
          manifest: snapshot.manifest,
          journal: snapshot.journal,
          workItems: replaceWorkItem(snapshot.workItems, candidate),
        },
        false,
      );
      await this.writeWorkItem(candidate);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.work_item.started",
          snapshot.journal.revision,
          candidate.taskId,
          {
            attempt: candidate.attempt,
          },
        );
      return cloneJson(candidate);
    });
  }

  async markWorkItemFailed(input: {
    readonly taskId: string;
    readonly expectedAttempt: number;
    readonly executionAttemptId: string;
    readonly errorCode: string;
  }): Promise<ResearchWorkItem> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      assertOwner(snapshot.journal, input.executionAttemptId);
      const item = requireWorkItem(snapshot, input.taskId);
      if (item.attempt !== input.expectedAttempt) {
        throw new ResearchRunStoreError(
          "revision_conflict",
          "Research work-item attempt changed.",
        );
      }
      if (item.status !== "running")
        throw new ResearchRunStoreError(
          "invalid_state",
          "Only running work can fail.",
        );
      assertSafeId(input.errorCode, "Research error code");
      const candidate: ResearchWorkItem = {
        ...item,
        status: "failed",
        completedAt: this.now().toISOString(),
        errorCode: input.errorCode,
      };
      await this.journalSnapshot(
        {
          manifest: snapshot.manifest,
          journal: snapshot.journal,
          workItems: replaceWorkItem(snapshot.workItems, candidate),
        },
        false,
      );
      await this.writeWorkItem(candidate);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.work_item.failed",
          snapshot.journal.revision,
          candidate.taskId,
          {
            attempt: candidate.attempt,
            errorCode: input.errorCode,
          },
        );
      return cloneJson(candidate);
    });
  }

  async commitWorkItemReceipt(
    input: CommitResearchReceiptInput,
  ): Promise<ResearchArtifactReceipt> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      const item = requireWorkItem(snapshot, input.taskId);
      assertReceiptIdentity(item, input);
      const receipt = await this.buildReceipt(input);
      if (item.receipt) {
        if (!sameJson(item.receipt, receipt)) {
          throw new ResearchRunStoreError(
            "artifact_invalid",
            "A different immutable receipt already exists.",
          );
        }
        return cloneJson(item.receipt);
      }
      if (item.status !== "running") {
        throw new ResearchRunStoreError(
          "invalid_state",
          "Only running work can commit an artifact receipt.",
        );
      }
      const completed: ResearchWorkItem = {
        ...item,
        status: "completed",
        completedAt: receipt.completedAt,
        receipt,
      };
      validateWorkItem(completed);
      await this.journalSnapshot(
        {
          manifest: snapshot.manifest,
          journal: snapshot.journal,
          workItems: replaceWorkItem(snapshot.workItems, completed),
        },
        false,
      );
      await this.writeWorkItem(completed);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.work_item.completed",
          snapshot.journal.revision,
          completed.taskId,
          {
            attempt: completed.attempt,
            byteLength: receipt.byteLength,
          },
        );
      return cloneJson(receipt);
    });
  }

  async claimExecutionAttempt(input: {
    readonly expectedRevision: number;
    readonly expectedOwnerExecutionAttemptId: string;
    readonly nextExecutionAttemptId: string;
  }): Promise<ResearchRunSnapshot> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      assertRevision(snapshot.journal, input.expectedRevision);
      assertOwner(snapshot.journal, input.expectedOwnerExecutionAttemptId);
      assertSafeId(input.nextExecutionAttemptId, "Next execution attempt ID");
      if (
        input.nextExecutionAttemptId === input.expectedOwnerExecutionAttemptId
      ) {
        throw new ResearchRunStoreError(
          "ownership_conflict",
          "Recovery requires a new execution attempt ID.",
        );
      }
      if (TERMINAL_RUN_STATUSES.has(snapshot.journal.status)) {
        throw new ResearchRunStoreError(
          "invalid_state",
          "A terminal research run cannot be claimed.",
        );
      }
      const workItems = snapshot.workItems.map((item): ResearchWorkItem =>
        item.status === "running"
          ? { ...item, status: "interrupted", attempt: item.attempt + 1 }
          : item,
      );
      const journal: ResearchJournal = {
        ...snapshot.journal,
        revision: snapshot.journal.revision + 1,
        ownerExecutionAttemptId: input.nextExecutionAttemptId,
        updatedAt: this.now().toISOString(),
      };
      validateJournal(journal);
      await this.journalSnapshot(
        { manifest: snapshot.manifest, journal, workItems },
        false,
      );
      for (const item of workItems) await this.writeWorkItem(item);
      await writeJsonAtomic(this.paths.journalPath, journal);
      if (!this.journal)
        await this.appendEventUnlocked(
          "research.recovery.claimed",
          journal.revision,
          undefined,
          {
            interruptedCount: workItems.filter(
              (item) => item.status === "interrupted",
            ).length,
          },
        );
      return cloneJson({ manifest: snapshot.manifest, journal, workItems });
    });
  }

  async appendEvent(input: {
    readonly type: string;
    readonly taskId?: string;
    readonly details?: ResearchStoreEvent["details"];
  }): Promise<ResearchStoreEvent> {
    return this.withLock(async () => {
      const snapshot = await this.loadUnlocked();
      if (input.taskId !== undefined) requireWorkItem(snapshot, input.taskId);
      return this.appendEventUnlocked(
        input.type,
        snapshot.journal.revision,
        input.taskId,
        input.details ?? {},
      );
    });
  }

  async readEvents(): Promise<readonly ResearchStoreEvent[]> {
    let raw: string;
    try {
      await assertOwnedPrivateFile(
        this.paths.eventsPath,
        "Research event journal",
      );
      raw = await fs.readFile(this.paths.eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!raw.trim()) return [];
    return raw
      .trimEnd()
      .split("\n")
      .map((line) => {
        try {
          return validateEvent(JSON.parse(line) as unknown);
        } catch (error) {
          throw new ResearchRunStoreError(
            "corrupt",
            "Research event journal contains invalid JSON.",
            { cause: error },
          );
        }
      });
  }

  private async loadUnlocked(): Promise<ResearchRunSnapshot> {
    const manifest = validateManifest(
      await readJsonRequired(this.paths.manifestPath, "manifest"),
    );
    const journal = validateJournal(
      await readJsonRequired(this.paths.journalPath, "journal"),
    );
    const workItems = await Promise.all(
      journal.workItemIds.map(async (taskId) => {
        const workItem = validateWorkItem(
          await readJsonRequired(
            this.workItemPath(taskId),
            `work item '${taskId}'`,
          ),
        );
        if (workItem.taskId !== taskId)
          corrupt("Research work-item filename and identity disagree.");
        return workItem;
      }),
    );
    return cloneJson({ manifest, journal, workItems });
  }

  private async buildReceipt(
    input: CommitResearchReceiptInput,
  ): Promise<ResearchArtifactReceipt> {
    const artifactPath = resolveOwnedRunRelativePath({
      assignmentPath: this.assignmentPath,
      relativePath: input.relativePath,
      label: "Research artifact",
    });
    const stat = await fs.lstat(artifactPath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new ResearchRunStoreError(
        "artifact_invalid",
        "Research artifact must be a regular owned file.",
      );
    }
    const contents = await fs.readFile(artifactPath);
    return {
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      attempt: input.attempt,
      workerSpecHash: input.workerSpecHash,
      relativePath: input.relativePath,
      sha256: hashBuffer(contents),
      byteLength: contents.byteLength,
      completedAt: input.completedAt ?? this.now().toISOString(),
    };
  }

  private async writeWorkItem(item: ResearchWorkItem): Promise<void> {
    validateWorkItem(item);
    await writeJsonAtomic(this.workItemPath(item.taskId), item);
  }

  private workItemPath(taskId: string): string {
    assertSafeId(taskId, "Research task ID");
    return path.join(this.paths.workItemsPath, `${taskId}.json`);
  }

  private async appendEventUnlocked(
    type: string,
    revision: number,
    taskId: string | undefined,
    details: ResearchStoreEvent["details"],
  ): Promise<ResearchStoreEvent> {
    assertSafeId(type, "Research event type");
    if (taskId !== undefined) assertSafeId(taskId, "Research event task ID");
    const event = validateEvent({
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      eventId: this.randomUUID(),
      timestamp: this.now().toISOString(),
      type,
      taskId,
      revision,
      details,
    });
    await fs.mkdir(this.paths.runtimePath, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(
      this.paths.runtimePath,
      "Research runtime directory",
    );
    const existingEventFile = await fs
      .lstat(this.paths.eventsPath)
      .catch(() => null);
    if (existingEventFile) {
      await assertOwnedPrivateFile(
        this.paths.eventsPath,
        "Research event journal",
      );
    }
    const handle = await fs.open(this.paths.eventsPath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return cloneJson(event);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.paths.runtimePath, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(
      this.paths.runtimePath,
      "Research runtime directory",
    );
    let lock;
    try {
      lock = await acquireProcessFileLock({
        lockPath: this.paths.lockPath,
        record: {
          pid: this.lockOptions.processId,
          nonce: crypto.randomUUID(),
          createdAt: this.now().toISOString(),
        },
        adapter: crossProcessFileLockAdapter,
        timeoutMs: this.lockOptions.timeoutMs,
        retryMs: this.lockOptions.retryMs,
        waitDescription: "research run lock",
        corruptBehavior: "wait",
        isProcessAlive: this.lockOptions.isProcessAlive,
      });
    } catch (error) {
      if (error instanceof ProcessFileLockError) {
        throw new ResearchRunStoreError(
          "lock_timeout",
          "Timed out waiting for the research run lock.",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }
}

function buildManifest(
  input: InitializeResearchRunInput["manifest"],
  now: () => Date,
): ResearchExecutionManifest {
  return validateManifest({
    ...input,
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    createdAt: input.createdAt ?? now().toISOString(),
  });
}

function buildWorkItems(
  seeds: readonly ResearchWorkItemSeed[],
): ResearchWorkItem[] {
  const taskIds = new Set<string>();
  return seeds.map((seed) => {
    assertSafeId(seed.taskId, "Research task ID");
    assertSafeId(seed.assignmentId, "Research assignment ID");
    assertSha256(seed.workerSpecHash, "Worker specification hash");
    if (taskIds.has(seed.taskId))
      throw new ResearchRunStoreError(
        "already_exists",
        "Research task IDs must be unique.",
      );
    taskIds.add(seed.taskId);
    return {
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      taskId: seed.taskId,
      assignmentId: seed.assignmentId,
      workerSpecHash: seed.workerSpecHash,
      attempt: 1,
      status: "pending",
    };
  });
}

function replaceWorkItem(
  workItems: readonly ResearchWorkItem[],
  candidate: ResearchWorkItem,
): ResearchWorkItem[] {
  return workItems.map((item) =>
    item.taskId === candidate.taskId ? candidate : item,
  );
}

export function validateManifest(value: unknown): ResearchExecutionManifest {
  const input = requireRecord(value, "Research manifest");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "sessionId",
      "runId",
      "planId",
      "approvedPlanHash",
      "maxDurationMinutes",
      "maxResearcherAgents",
      "authenticatedDomains",
      "createdAt",
    ],
    "Research manifest",
  );
  assertVersion(input.schemaVersion, "Research manifest");
  assertSafeId(input.sessionId, "Session ID");
  assertSafeId(input.runId, "Run ID");
  assertSafeId(input.planId, "Plan ID");
  assertSha256(input.approvedPlanHash, "Approved plan hash");
  assertIntegerRange(input.maxDurationMinutes, 5, 120, "Maximum duration");
  assertIntegerRange(
    input.maxResearcherAgents,
    1,
    8,
    "Maximum researcher agents",
  );
  assertDomainArray(input.authenticatedDomains, "Authenticated domains");
  assertIso(input.createdAt, "Manifest creation time");
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    sessionId: input.sessionId,
    runId: input.runId,
    planId: input.planId,
    approvedPlanHash: input.approvedPlanHash,
    maxDurationMinutes: input.maxDurationMinutes,
    maxResearcherAgents: input.maxResearcherAgents,
    authenticatedDomains: [...input.authenticatedDomains],
    createdAt: input.createdAt,
  };
}

export function validateJournal(value: unknown): ResearchJournal {
  const input = requireRecord(value, "Research journal");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "revision",
      "ownerExecutionAttemptId",
      "status",
      "correctionWave",
      "workItemIds",
      "createdAt",
      "updatedAt",
    ],
    "Research journal",
  );
  assertVersion(input.schemaVersion, "Research journal");
  assertNonNegativeInteger(input.revision, "Journal revision");
  assertSafeId(input.ownerExecutionAttemptId, "Journal owner");
  assertEnum(
    input.status,
    [
      "planned",
      "running",
      "correcting",
      "synthesizing",
      "reviewing",
      "approved",
      "escalated",
      "cancelled",
      "timed_out",
    ],
    "Journal status",
  );
  assertIntegerRange(input.correctionWave, 0, 2, "Correction wave");
  assertSafeIdArray(input.workItemIds, "Work-item IDs");
  assertIso(input.createdAt, "Journal creation time");
  assertIso(input.updatedAt, "Journal update time");
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    revision: input.revision,
    ownerExecutionAttemptId: input.ownerExecutionAttemptId,
    status: input.status,
    correctionWave: asCorrectionWave(input.correctionWave),
    workItemIds: [...input.workItemIds],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

export function validateWorkItem(value: unknown): ResearchWorkItem {
  const input = requireRecord(value, "Research work item");
  assertAllowedKeys(
    input,
    [
      "schemaVersion",
      "taskId",
      "assignmentId",
      "workerSpecHash",
      "attempt",
      "status",
      "startedAt",
      "completedAt",
      "receipt",
      "errorCode",
    ],
    "Research work item",
  );
  for (const required of [
    "schemaVersion",
    "taskId",
    "assignmentId",
    "workerSpecHash",
    "attempt",
    "status",
  ]) {
    if (!(required in input))
      corrupt(`Research work item is missing '${required}'.`);
  }
  assertVersion(input.schemaVersion, "Research work item");
  assertSafeId(input.taskId, "Work-item task ID");
  assertSafeId(input.assignmentId, "Work-item assignment ID");
  assertSha256(input.workerSpecHash, "Work-item worker hash");
  assertIntegerRange(
    input.attempt,
    1,
    Number.MAX_SAFE_INTEGER,
    "Work-item attempt",
  );
  assertEnum(
    input.status,
    [
      "pending",
      "running",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "timed_out",
    ],
    "Work-item status",
  );
  if (input.startedAt !== undefined)
    assertIso(input.startedAt, "Work-item start time");
  if (input.completedAt !== undefined)
    assertIso(input.completedAt, "Work-item completion time");
  if (input.errorCode !== undefined)
    assertSafeId(input.errorCode, "Work-item error code");
  if (input.receipt !== undefined) validateReceipt(input.receipt);
  if (input.status === "completed" && (!input.receipt || !input.completedAt))
    corrupt("Completed work requires a receipt and completion time.");
  if (input.receipt && input.status !== "completed")
    corrupt("Only completed work may own a receipt.");
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    workerSpecHash: input.workerSpecHash,
    attempt: input.attempt,
    status: input.status,
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.completedAt === undefined
      ? {}
      : { completedAt: input.completedAt }),
    ...(input.receipt === undefined
      ? {}
      : { receipt: validateReceipt(input.receipt) }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
}

function validateReceipt(value: unknown): ResearchArtifactReceipt {
  const input = requireRecord(value, "Research receipt");
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "taskId",
      "assignmentId",
      "attempt",
      "workerSpecHash",
      "relativePath",
      "sha256",
      "byteLength",
      "completedAt",
    ],
    "Research receipt",
  );
  assertVersion(input.schemaVersion, "Research receipt");
  assertSafeId(input.taskId, "Receipt task ID");
  assertSafeId(input.assignmentId, "Receipt assignment ID");
  assertIntegerRange(
    input.attempt,
    1,
    Number.MAX_SAFE_INTEGER,
    "Receipt attempt",
  );
  assertSha256(input.workerSpecHash, "Receipt worker hash");
  if (typeof input.relativePath !== "string" || !input.relativePath)
    corrupt("Receipt relative path is invalid.");
  assertSha256(input.sha256, "Receipt artifact hash");
  assertNonNegativeInteger(input.byteLength, "Receipt byte length");
  assertIso(input.completedAt, "Receipt completion time");
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    attempt: input.attempt,
    workerSpecHash: input.workerSpecHash,
    relativePath: input.relativePath,
    sha256: input.sha256,
    byteLength: input.byteLength,
    completedAt: input.completedAt,
  };
}

function validateEvent(value: unknown): ResearchStoreEvent {
  const input = requireRecord(value, "Research event");
  assertAllowedKeys(
    input,
    [
      "schemaVersion",
      "eventId",
      "timestamp",
      "type",
      "taskId",
      "revision",
      "details",
    ],
    "Research event",
  );
  for (const required of [
    "schemaVersion",
    "eventId",
    "timestamp",
    "type",
    "revision",
    "details",
  ]) {
    if (!(required in input))
      corrupt(`Research event is missing '${required}'.`);
  }
  assertVersion(input.schemaVersion, "Research event");
  assertSafeId(input.eventId, "Event ID");
  assertIso(input.timestamp, "Event time");
  assertSafeId(input.type, "Event type");
  if (input.taskId !== undefined) assertSafeId(input.taskId, "Event task ID");
  assertNonNegativeInteger(input.revision, "Event revision");
  const details = requireRecord(input.details, "Event details");
  if (
    Object.values(details).some(
      (entry) =>
        !["string", "number", "boolean"].includes(typeof entry) &&
        entry !== null,
    )
  ) {
    corrupt("Event details may contain only scalar JSON values.");
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    eventId: input.eventId,
    timestamp: input.timestamp,
    type: input.type,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    revision: input.revision,
    details: Object.fromEntries(
      Object.entries(details).map(([key, entry]) => [key, scalarDetail(entry)]),
    ),
  };
}

function asCorrectionWave(value: number): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  corrupt("Correction wave is invalid.");
}

function scalarDetail(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return value;
  corrupt("Event details may contain only scalar JSON values.");
}

function validateJournalTransition(
  previous: ResearchJournal,
  next: ResearchJournal,
): void {
  if (
    next.status !== previous.status &&
    !RUN_TRANSITIONS[previous.status].has(next.status)
  ) {
    throw new ResearchRunStoreError(
      "invalid_state",
      `Research status cannot move from '${previous.status}' to '${next.status}'.`,
    );
  }
  if (
    next.correctionWave < previous.correctionWave ||
    next.correctionWave > previous.correctionWave + 1
  ) {
    throw new ResearchRunStoreError(
      "invalid_state",
      "Correction wave must remain stable or advance by one.",
    );
  }
  if (
    next.correctionWave > previous.correctionWave &&
    next.status !== "correcting"
  ) {
    throw new ResearchRunStoreError(
      "invalid_state",
      "A correction-wave advance must enter correcting status.",
    );
  }
}

function assertJournalControlledFields(
  previous: ResearchJournal,
  next: ResearchJournal,
): void {
  if (
    next.schemaVersion !== previous.schemaVersion ||
    next.revision !== previous.revision ||
    next.ownerExecutionAttemptId !== previous.ownerExecutionAttemptId ||
    next.createdAt !== previous.createdAt ||
    next.updatedAt !== previous.updatedAt ||
    !sameJson(next.workItemIds, previous.workItemIds)
  ) {
    throw new ResearchRunStoreError(
      "invalid_state",
      "Journal mutation changed runtime-controlled fields.",
    );
  }
}

function assertReceiptIdentity(
  item: ResearchWorkItem,
  input: CommitResearchReceiptInput,
): void {
  assertSafeId(input.taskId, "Receipt task ID");
  assertSafeId(input.assignmentId, "Receipt assignment ID");
  assertSha256(input.workerSpecHash, "Receipt worker hash");
  if (
    item.assignmentId !== input.assignmentId ||
    item.attempt !== input.attempt ||
    item.workerSpecHash !== input.workerSpecHash
  ) {
    throw new ResearchRunStoreError(
      "identity_mismatch",
      "Receipt does not match the authorized work-item identity.",
    );
  }
}

function requireWorkItem(
  snapshot: ResearchRunSnapshot,
  taskId: string,
): ResearchWorkItem {
  assertSafeId(taskId, "Research task ID");
  const item = snapshot.workItems.find(
    (candidate) => candidate.taskId === taskId,
  );
  if (!item)
    throw new ResearchRunStoreError(
      "not_found",
      `Research task '${taskId}' was not found.`,
    );
  return item;
}

function assertSeedsMatch(
  items: readonly ResearchWorkItem[],
  seeds: readonly ResearchWorkItemSeed[],
): void {
  const expected = buildWorkItems(seeds);
  if (
    items.length !== expected.length ||
    items.some((item, index) => {
      const seed = expected[index];
      return (
        !seed ||
        item.taskId !== seed.taskId ||
        item.assignmentId !== seed.assignmentId ||
        item.workerSpecHash !== seed.workerSpecHash
      );
    })
  ) {
    throw new ResearchRunStoreError(
      "already_exists",
      "Research work-item definitions changed after initialization.",
    );
  }
}

function assertRevision(journal: ResearchJournal, expected: number): void {
  if (journal.revision !== expected)
    throw new ResearchRunStoreError(
      "revision_conflict",
      "Research journal revision changed.",
    );
}

function assertOwner(
  journal: ResearchJournal,
  executionAttemptId: string,
): void {
  if (journal.ownerExecutionAttemptId !== executionAttemptId) {
    throw new ResearchRunStoreError(
      "ownership_conflict",
      "Research journal belongs to another execution attempt.",
    );
  }
}

async function ensurePrivateDirectories(
  paths: ResearchRunStorePaths,
): Promise<void> {
  await fs.mkdir(paths.runtimePath, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(paths.runtimePath, "Research runtime directory");
  await fs.mkdir(paths.workItemsPath, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(
    paths.workItemsPath,
    "Research work-items directory",
  );
  await fs.chmod(paths.runtimePath, 0o700);
  await fs.chmod(paths.workItemsPath, 0o700);
}

async function assertOwnedDirectory(
  directoryPath: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new ResearchRunStoreError(
      "corrupt",
      `${label} must be an owned directory.`,
    );
  }
}

async function assertOwnedPrivateFile(
  filePath: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new ResearchRunStoreError(
      "corrupt",
      `${label} must be an owned private file.`,
    );
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      corrupt(`'${path.basename(filePath)}' must be an owned private file.`);
    }
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError)
      corrupt(`Could not parse '${path.basename(filePath)}'.`);
    throw error;
  }
}

async function readJsonRequired(
  filePath: string,
  label: string,
): Promise<unknown> {
  const value = await readJson(filePath);
  if (value === null) corrupt(`Research ${label} is missing.`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    corrupt(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  assertAllowedKeys(input, keys, label);
  const missing = keys.find((key) => !(key in input));
  if (missing) corrupt(`${label} is missing '${missing}'.`);
}

function assertAllowedKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) corrupt(`${label} contains unknown field '${unknown}'.`);
}

function assertVersion(value: unknown, label: string): void {
  if (value !== DEEP_RESEARCH_SCHEMA_VERSION)
    corrupt(`${label} uses an unsupported schema version.`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !isSafePathSegment(value))
    corrupt(`${label} must be a safe identifier.`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value))
    corrupt(`${label} must be a SHA-256 digest.`);
}

function assertIso(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    corrupt(`${label} must be a canonical ISO timestamp.`);
  }
}

function assertIntegerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    corrupt(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  assertIntegerRange(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function assertStringArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry)
  )
    corrupt(`${label} must be a string array.`);
}

function assertSafeIdArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  assertStringArray(value, label);
  if (
    value.some((entry) => !isSafePathSegment(entry)) ||
    new Set(value).size !== value.length
  ) {
    corrupt(`${label} must contain unique safe identifiers.`);
  }
}

function assertDomainArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  assertStringArray(value, label);
  if (
    value.some(
      (entry) => entry !== entry.toLowerCase() || !DOMAIN_PATTERN.test(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    corrupt(`${label} must contain unique lowercase hostname-only domains.`);
  }
}

function assertEnum<const T extends readonly string[]>(
  value: unknown,
  options: T,
  label: string,
): asserts value is T[number] {
  if (typeof value !== "string" || !options.includes(value))
    corrupt(`${label} contains an unsupported value.`);
}

function hashBuffer(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function corrupt(message: string): never {
  throw new ResearchRunStoreError("corrupt", message);
}
