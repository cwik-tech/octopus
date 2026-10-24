import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  McpAuditEventView,
  McpContentHash,
  McpToolResultEvidenceContentView,
} from "../../contracts/mcp.js";
import {
  isMcpApprovalArgumentsHash,
  isMcpApprovalStatus,
  isMcpApprovalToolRisk,
  type McpApprovalArgumentsHash,
  type McpApprovalStatus,
} from "./mcp-approval.js";
import { canonicalizeMcpJson } from "./mcp-broker-policy.js";
import {
  isMcpElicitationAction,
  isMcpElicitationStatus,
  type McpElicitationAction,
  type McpElicitationStatus,
} from "./mcp-elicitation.js";
import { withFileMutationLock } from "../../core/file-mutation.js";
import { isSafePathSegment } from "../../core/path-safety.js";
import {
  MCP_SANITIZED_ERROR_CODES,
  type McpEvidenceRecord,
  type McpSanitizedErrorCode,
  type McpToolResultContent,
  type McpToolRisk,
} from "./mcp-runtime.js";
import { normalizeMcpAgentPath } from "./mcp-settings.js";
import {
  buildSessionRunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from "../run/run-location.js";

export const MCP_AUDIT_EVENT_VERSION = 1 as const;
export const MCP_TOOL_RESULT_EVIDENCE_VERSION = 1 as const;

export type {
  McpAuditEventView,
  McpContentHash,
  McpToolResultEvidenceContentView,
};

export const MCP_AUDIT_EVENT_TYPES = [
  "mcp.tool.requested",
  "mcp.approval.requested",
  "mcp.approval.resolved",
  "mcp.elicitation.requested",
  "mcp.elicitation.resolved",
  "mcp.tool.started",
  "mcp.tool.completed",
  "mcp.tool.failed",
  "mcp.tool.cancelled",
  "mcp.resource.imported",
] as const;

export type McpAuditEventType = (typeof MCP_AUDIT_EVENT_TYPES)[number];
export type McpAuditStatus =
  | "requested"
  | "pending"
  | Exclude<McpApprovalStatus, "pending">
  | Exclude<McpElicitationStatus, "pending">
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "imported";

export interface McpAuditScopeInput {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly agentPath: string;
  readonly serverId: string;
}

export interface McpAuditToolBindingInput extends McpAuditScopeInput {
  /** Stable parent-broker request identity; persisted but omitted from views. */
  readonly requestId: string;
  readonly toolCallId: string;
  readonly namespacedToolName: string;
  readonly toolRisk: McpToolRisk;
  readonly argumentNames: readonly string[];
  readonly argumentsHash: McpApprovalArgumentsHash;
}

export interface McpAuditElicitationBindingInput extends McpAuditScopeInput {
  /** Stable parent-broker request identity; persisted but omitted from views. */
  readonly requestId: string;
  readonly toolCallId: string;
  readonly namespacedToolName: string;
  readonly interactionId: string;
  readonly elicitationMode: "form" | "url";
}

export type McpAuditEventInput =
  | (McpAuditToolBindingInput & {
      readonly type: "mcp.tool.requested" | "mcp.tool.started";
    })
  | (McpAuditToolBindingInput & {
      readonly type: "mcp.approval.requested";
      readonly interactionId: string;
    })
  | (McpAuditToolBindingInput & {
      readonly type: "mcp.approval.resolved";
      readonly interactionId: string;
      readonly approvalStatus: Exclude<McpApprovalStatus, "pending">;
    })
  | (McpAuditElicitationBindingInput & {
      readonly type: "mcp.elicitation.requested";
    })
  | (McpAuditElicitationBindingInput & {
      readonly type: "mcp.elicitation.resolved";
      readonly elicitationStatus: Exclude<McpElicitationStatus, "pending">;
      readonly elicitationAction?: McpElicitationAction;
    })
  | (McpAuditToolBindingInput & {
      readonly type: "mcp.tool.completed";
      readonly durationMs: number;
      readonly resultByteCount: number;
      readonly resultHash: McpContentHash;
    })
  | (McpAuditToolBindingInput & {
      readonly type: "mcp.tool.failed";
      readonly durationMs: number;
      readonly errorCode: McpSanitizedErrorCode;
    })
  | (McpAuditToolBindingInput & {
      readonly type: "mcp.tool.cancelled";
      readonly durationMs: number;
    })
  | (McpAuditScopeInput & {
      readonly type: "mcp.resource.imported";
      readonly snapshotId: string;
      readonly resultByteCount: number;
      readonly resultHash: McpContentHash;
    });

export interface McpToolResultEvidenceImportInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly agentPath: string;
  readonly serverId: string;
  /** Stable parent-broker request identity; persisted but omitted from views. */
  readonly requestId: string;
  readonly toolCallId: string;
  readonly namespacedToolName: string;
  readonly content: readonly McpToolResultContent[];
}

export interface McpToolResultEvidenceView {
  readonly evidencePath: string;
  readonly record: McpEvidenceRecord;
  readonly totalBytes: number;
  readonly aggregateHash: McpContentHash;
  readonly contents: readonly McpToolResultEvidenceContentView[];
}

export type McpEvidenceStoreErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "result_too_large"
  | "capacity_exceeded"
  | "corrupt_store"
  | "io_error";

export class McpEvidenceStoreError extends Error {
  readonly code: McpEvidenceStoreErrorCode;

  constructor(code: McpEvidenceStoreErrorCode) {
    super(evidenceStoreErrorMessage(code));
    this.name = "McpEvidenceStoreError";
    this.code = code;
  }
}

export interface McpEvidenceStoreOptions {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly now?: () => Date;
  readonly maxAuditEvents?: number;
  readonly maxAuditBytes?: number;
  readonly maxContentBytes?: number;
  readonly maxAggregateBytes?: number;
}

interface PersistedAuditEvent extends McpAuditEventView {
  readonly requestId?: string;
}

interface ToolResultManifestContent extends McpToolResultEvidenceContentView {}

interface ToolResultManifest {
  readonly version: typeof MCP_TOOL_RESULT_EVIDENCE_VERSION;
  readonly evidenceId: string;
  readonly kind: "tool-result";
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly workflowId?: string;
  readonly workflowStepId?: string;
  readonly agentPath: string;
  readonly serverId: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly namespacedToolName: string;
  readonly recordedAt: string;
  readonly totalBytes: number;
  readonly aggregateHash: McpContentHash;
  readonly contents: readonly ToolResultManifestContent[];
}

interface PreparedContent {
  readonly manifest: ToolResultManifestContent;
  readonly buffer: Buffer;
}

interface PreparedEvidence {
  readonly identity: Omit<ToolResultManifest, "recordedAt">;
  readonly contents: readonly PreparedContent[];
}

const DEFAULT_MAX_AUDIT_EVENTS = 10_000;
const DEFAULT_MAX_AUDIT_BYTES = 16 * 1_024 * 1_024;
const DEFAULT_MAX_CONTENT_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_MAX_AGGREGATE_BYTES = 4 * 1_024 * 1_024;
const MAX_CONFIGURED_BYTES = 64 * 1_024 * 1_024;
const MAX_CONTENT_ITEMS = 64;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ARGUMENT_NAMES = 1_024;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MANIFEST_BYTES = 1 * 1_024 * 1_024;
const AUDIT_FILENAME = "events.jsonl";
const MANIFEST_FILENAME = "manifest.json";
const CONTENTS_DIRECTORY = "contents";
const SHA256 = /^[a-f0-9]{64}$/;
const AUDIT_ID = /^mcp_audit_[a-f0-9]{64}$/;
const EVIDENCE_ID = /^mcp_tool_result_[a-f0-9]{64}$/;
const CONTENT_PATH = /^contents\/(\d{2})\.(txt|json)$/;
const TEMP_EVIDENCE_DIRECTORY =
  /^\.tool-result-mcp_tool_result_[a-f0-9]{64}-[a-f0-9]{16}\.tmp$/;
const SANITIZED_ERROR_CODES = new Set<string>(MCP_SANITIZED_ERROR_CODES);

export class McpEvidenceStore {
  private readonly workspacePath: string;
  private readonly location: SessionRunAssignmentLocation;
  private readonly now: () => Date;
  private readonly maxAuditEvents: number;
  private readonly maxAuditBytes: number;
  private readonly maxContentBytes: number;
  private readonly maxAggregateBytes: number;
  private readonly mcpPath: string;
  private readonly auditPath: string;
  private readonly auditFilePath: string;
  private readonly evidencePath: string;
  private readonly evidenceMcpPath: string;
  private readonly toolResultsPath: string;

  constructor(options: McpEvidenceStoreOptions) {
    if (!options || typeof options.workspacePath !== "string") {
      throw new McpEvidenceStoreError("invalid_request");
    }
    this.workspacePath = path.resolve(options.workspacePath);
    const location = buildSessionRunAssignmentLocation(this.workspacePath, {
      sessionId: options.sessionId,
      runId: options.runId,
      assignmentId: options.assignmentId,
    });
    if (!location) throw new McpEvidenceStoreError("invalid_request");
    this.location = location;
    this.now = options.now ?? (() => new Date());
    this.maxAuditEvents = boundedPositiveInteger(
      options.maxAuditEvents,
      DEFAULT_MAX_AUDIT_EVENTS,
      100_000,
    );
    this.maxAuditBytes = boundedPositiveInteger(
      options.maxAuditBytes,
      DEFAULT_MAX_AUDIT_BYTES,
      MAX_CONFIGURED_BYTES,
    );
    this.maxContentBytes = boundedPositiveInteger(
      options.maxContentBytes,
      DEFAULT_MAX_CONTENT_BYTES,
      MAX_CONFIGURED_BYTES,
    );
    this.maxAggregateBytes = boundedPositiveInteger(
      options.maxAggregateBytes,
      DEFAULT_MAX_AGGREGATE_BYTES,
      MAX_CONFIGURED_BYTES,
    );
    if (this.maxAggregateBytes < this.maxContentBytes) {
      throw new McpEvidenceStoreError("invalid_request");
    }
    this.mcpPath = path.join(location.assignmentPath, "mcp");
    this.auditPath = path.join(this.mcpPath, "audit");
    this.auditFilePath = path.join(this.auditPath, AUDIT_FILENAME);
    this.evidencePath = path.join(location.assignmentPath, "evidence");
    this.evidenceMcpPath = path.join(this.evidencePath, "mcp");
    this.toolResultsPath = path.join(this.evidenceMcpPath, "tool-results");
  }

  async appendAuditEvent(
    input: McpAuditEventInput,
  ): Promise<McpAuditEventView> {
    const event = normalizeAuditEvent(input, "invalid_request");
    this.requireAssignmentScope(event);
    return this.runLocked(this.auditFilePath, async () => {
      await this.ensureAuditStorage();
      const events = await this.readAuditEventsInternal();
      const existing = events.find(
        (candidate) => candidate.eventId === event.eventId,
      );
      if (existing) {
        if (canonicalizeMcpJson(existing) !== canonicalizeMcpJson(event)) {
          throw new McpEvidenceStoreError("conflict");
        }
        return redactAuditEvent(existing);
      }
      if (events.length >= this.maxAuditEvents) {
        throw new McpEvidenceStoreError("capacity_exceeded");
      }
      const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
      const existingBytes = await fileSizeOrZero(this.auditFilePath);
      if (existingBytes + line.byteLength > this.maxAuditBytes) {
        throw new McpEvidenceStoreError("capacity_exceeded");
      }
      await appendSecureFile(this.auditFilePath, line);
      await syncDirectory(this.auditPath);
      return redactAuditEvent(event);
    });
  }

  async listAuditEvents(): Promise<readonly McpAuditEventView[]> {
    return this.runLocked(this.auditFilePath, async () =>
      (await this.readAuditEventsInternal()).map(redactAuditEvent),
    );
  }

  async importToolResultEvidence(
    input: McpToolResultEvidenceImportInput,
  ): Promise<McpToolResultEvidenceView> {
    const prepared = prepareEvidence(
      input,
      this.maxContentBytes,
      this.maxAggregateBytes,
    );
    this.requireAssignmentScope(prepared.identity);
    return this.runLocked(this.toolResultsPath, async () => {
      await this.ensureEvidenceStorage();
      const publishedPath = path.join(
        this.toolResultsPath,
        prepared.identity.evidenceId,
      );
      if (await pathExists(publishedPath)) {
        const existing = await this.readPublishedEvidence(
          prepared.identity.evidenceId,
        );
        if (!samePreparedEvidence(existing, prepared.identity)) {
          throw new McpEvidenceStoreError("conflict");
        }
        return existing;
      }

      const manifest: ToolResultManifest = {
        ...prepared.identity,
        recordedAt: requireIsoTimestamp(this.now().toISOString(), "io_error"),
      };
      await publishEvidence(this.toolResultsPath, manifest, prepared.contents);
      return this.readPublishedEvidence(manifest.evidenceId);
    });
  }

  async listToolResultEvidence(): Promise<
    readonly McpToolResultEvidenceView[]
  > {
    return this.runLocked(this.toolResultsPath, async () => {
      const exists = await this.validateOptionalDirectoryChain([
        [this.evidencePath, this.location.assignmentPath],
        [this.evidenceMcpPath, this.evidencePath],
        [this.toolResultsPath, this.evidenceMcpPath],
      ]);
      if (!exists) return [];
      const entries = await fs.readdir(this.toolResultsPath, {
        withFileTypes: true,
      });
      const evidence: McpToolResultEvidenceView[] = [];
      for (const entry of entries) {
        if (TEMP_EVIDENCE_DIRECTORY.test(entry.name) && entry.isDirectory()) {
          continue;
        }
        if (!EVIDENCE_ID.test(entry.name) || !entry.isDirectory()) {
          throw new McpEvidenceStoreError("corrupt_store");
        }
        evidence.push(await this.readPublishedEvidence(entry.name));
      }
      return evidence.sort(compareEvidenceViews);
    });
  }

  private async readAuditEventsInternal(): Promise<PersistedAuditEvent[]> {
    const chainExists = await this.validateOptionalDirectoryChain([
      [this.mcpPath, this.location.assignmentPath],
      [this.auditPath, this.mcpPath],
    ]);
    if (!chainExists) return [];
    const entries = await fs.readdir(this.auditPath, { withFileTypes: true });
    if (
      entries.some((entry) => entry.name !== AUDIT_FILENAME || !entry.isFile())
    ) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    if (entries.length === 0) return [];

    const buffer = await readSecureFile(
      this.auditFilePath,
      this.auditPath,
      this.maxAuditBytes,
      0o600,
    );
    if (buffer.byteLength === 0) return [];
    const content = buffer.toString("utf8");
    if (!content.endsWith("\n")) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    const lines = content.slice(0, -1).split("\n");
    if (lines.length > this.maxAuditEvents || lines.some((line) => !line)) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    const events = lines.map(parsePersistedAuditEvent);
    if (new Set(events.map((event) => event.eventId)).size !== events.length) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    for (const event of events)
      this.requireAssignmentScope(event, "corrupt_store");
    return events;
  }

  private async readPublishedEvidence(
    evidenceId: string,
  ): Promise<McpToolResultEvidenceView> {
    if (!EVIDENCE_ID.test(evidenceId)) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    const evidencePath = path.join(this.toolResultsPath, evidenceId);
    await requireSecureDirectory(evidencePath, this.toolResultsPath, 0o700);
    const entries = await fs.readdir(evidencePath, { withFileTypes: true });
    if (
      entries.length !== 2 ||
      !entries.some(
        (entry) => entry.name === MANIFEST_FILENAME && entry.isFile(),
      ) ||
      !entries.some(
        (entry) => entry.name === CONTENTS_DIRECTORY && entry.isDirectory(),
      )
    ) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    const manifestBuffer = await readSecureFile(
      path.join(evidencePath, MANIFEST_FILENAME),
      evidencePath,
      MAX_MANIFEST_BYTES,
      0o400,
    );
    const manifest = parseToolResultManifest(manifestBuffer, {
      evidenceId,
      sessionId: this.location.sessionId,
      runId: this.location.runId,
      assignmentId: this.location.assignmentId,
    });
    await verifyEvidenceContents(
      evidencePath,
      manifest,
      this.maxContentBytes,
      this.maxAggregateBytes,
    );
    return toolResultEvidenceView(evidencePath, manifest);
  }

  private async ensureAuditStorage(): Promise<void> {
    await ensurePrivateDirectory(this.mcpPath, this.location.assignmentPath);
    await ensurePrivateDirectory(this.auditPath, this.mcpPath);
  }

  private async ensureEvidenceStorage(): Promise<void> {
    await ensurePrivateDirectory(
      this.evidencePath,
      this.location.assignmentPath,
    );
    await ensurePrivateDirectory(this.evidenceMcpPath, this.evidencePath);
    await ensurePrivateDirectory(this.toolResultsPath, this.evidenceMcpPath);
  }

  private async validateOptionalDirectoryChain(
    chain: ReadonlyArray<readonly [string, string]>,
  ): Promise<boolean> {
    for (const [directoryPath, parentPath] of chain) {
      const stat = await fs.lstat(directoryPath).catch((error) => {
        if (isFileSystemError(error, "ENOENT")) return null;
        throw error;
      });
      if (!stat) return false;
      await requireSecureDirectory(directoryPath, parentPath, 0o700);
    }
    return true;
  }

  private async runLocked<T>(
    lockPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      await this.assertCanonicalAssignment();
      const canonicalLockPath = path.join(
        await fs.realpath(this.location.assignmentPath),
        path.relative(this.location.assignmentPath, lockPath),
      );
      return await withFileMutationLock(canonicalLockPath, async () => {
        await this.assertCanonicalAssignment();
        return operation();
      });
    } catch (error) {
      if (error instanceof McpEvidenceStoreError) throw error;
      throw new McpEvidenceStoreError("io_error");
    }
  }

  private async assertCanonicalAssignment(): Promise<void> {
    const workspaceStat = await fs.stat(this.workspacePath).catch(() => null);
    const assignmentStat = await fs
      .lstat(this.location.assignmentPath)
      .catch(() => null);
    if (
      !workspaceStat?.isDirectory() ||
      !assignmentStat?.isDirectory() ||
      assignmentStat.isSymbolicLink()
    ) {
      throw new McpEvidenceStoreError("not_found");
    }
    const [realWorkspace, realAssignment] = await Promise.all([
      fs.realpath(this.workspacePath),
      fs.realpath(this.location.assignmentPath),
    ]);
    const expected = path.resolve(
      realWorkspace,
      ...this.location.relativeAssignmentPath.split("/"),
    );
    if (realAssignment !== expected) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
  }

  private requireAssignmentScope(
    scope: {
      readonly sessionId: string;
      readonly runId: string;
      readonly assignmentId: string;
    },
    code: McpEvidenceStoreErrorCode = "invalid_request",
  ): void {
    if (
      scope.sessionId !== this.location.sessionId ||
      scope.runId !== this.location.runId ||
      scope.assignmentId !== this.location.assignmentId
    ) {
      throw new McpEvidenceStoreError(code);
    }
  }
}

function normalizeAuditEvent(
  input: unknown,
  code: McpEvidenceStoreErrorCode,
): PersistedAuditEvent {
  const record = requireRecord(input, code);
  if (!MCP_AUDIT_EVENT_TYPES.includes(record.type as McpAuditEventType)) {
    throw new McpEvidenceStoreError(code);
  }
  const type = record.type as McpAuditEventType;
  const commonKeys = [
    "type",
    "timestamp",
    "sessionId",
    "runId",
    "assignmentId",
    "workflowId",
    "workflowStepId",
    "agentPath",
    "serverId",
  ];
  const requiredCommon = commonKeys.filter(
    (key) => key !== "workflowId" && key !== "workflowStepId",
  );
  const scope = normalizeAuditScope(record, code);

  if (type === "mcp.resource.imported") {
    requireExactShape(
      record,
      [...commonKeys, "snapshotId", "resultByteCount", "resultHash"],
      [...requiredCommon, "snapshotId", "resultByteCount", "resultHash"],
      code,
    );
    const payload: Omit<PersistedAuditEvent, "version" | "eventId"> = {
      ...scope,
      type,
      status: "imported",
      snapshotId: requireIdentifier(record.snapshotId, code),
      resultByteCount: requireByteCount(record.resultByteCount, code),
      resultHash: requireContentHash(record.resultHash, code),
    };
    return withAuditIdentity(payload);
  }

  if (
    type === "mcp.elicitation.requested" ||
    type === "mcp.elicitation.resolved"
  ) {
    const interactionKeys = [
      "requestId",
      "toolCallId",
      "namespacedToolName",
      "interactionId",
      "elicitationMode",
    ];
    const resolvedKeys =
      type === "mcp.elicitation.resolved"
        ? ["elicitationStatus", "elicitationAction"]
        : [];
    const requiredResolved =
      type === "mcp.elicitation.resolved" ? ["elicitationStatus"] : [];
    requireExactShape(
      record,
      [...commonKeys, ...interactionKeys, ...resolvedKeys],
      [...requiredCommon, ...interactionKeys, ...requiredResolved],
      code,
    );
    if (
      typeof record.namespacedToolName !== "string" ||
      !record.namespacedToolName.startsWith("mcp__") ||
      (record.elicitationMode !== "form" && record.elicitationMode !== "url")
    ) {
      throw new McpEvidenceStoreError(code);
    }
    const elicitationMode = record.elicitationMode as "form" | "url";
    const base = {
      ...scope,
      type,
      requestId: requireIdentifier(record.requestId, code),
      toolCallId: requireIdentifier(record.toolCallId, code),
      namespacedToolName: requireIdentifier(record.namespacedToolName, code),
      interactionId: requireIdentifier(record.interactionId, code),
      elicitationMode,
    };
    if (type === "mcp.elicitation.requested") {
      return withAuditIdentity({ ...base, status: "pending" });
    }
    if (
      !isMcpElicitationStatus(record.elicitationStatus) ||
      record.elicitationStatus === "pending" ||
      (record.elicitationAction !== undefined &&
        !isMcpElicitationAction(record.elicitationAction)) ||
      ((record.elicitationStatus === "accepted" ||
        record.elicitationStatus === "declined" ||
        record.elicitationStatus === "cancelled") &&
        record.elicitationAction === undefined) ||
      ((record.elicitationStatus === "expired" ||
        record.elicitationStatus === "interrupted") &&
        record.elicitationAction !== undefined)
    ) {
      throw new McpEvidenceStoreError(code);
    }
    return withAuditIdentity({
      ...base,
      status: record.elicitationStatus,
      elicitationStatus: record.elicitationStatus,
      ...(record.elicitationAction
        ? { elicitationAction: record.elicitationAction }
        : {}),
    });
  }

  const toolKeys = [
    "requestId",
    "toolCallId",
    "namespacedToolName",
    "toolRisk",
    "argumentNames",
    "argumentsHash",
  ];
  const tool = normalizeAuditToolBinding(record, code);
  let extras: readonly string[] = [];
  let requiredExtras: readonly string[] = [];
  let status: McpAuditStatus;
  let details: Partial<PersistedAuditEvent> = {};

  switch (type) {
    case "mcp.tool.requested":
      status = "requested";
      break;
    case "mcp.tool.started":
      status = "started";
      break;
    case "mcp.approval.requested":
      extras = ["interactionId"];
      requiredExtras = extras;
      status = "pending";
      details = {
        interactionId: requireIdentifier(record.interactionId, code),
      };
      break;
    case "mcp.approval.resolved": {
      extras = ["interactionId", "approvalStatus"];
      requiredExtras = extras;
      const approvalStatus = requireTerminalApprovalStatus(
        record.approvalStatus,
        code,
      );
      status = approvalStatus;
      details = {
        interactionId: requireIdentifier(record.interactionId, code),
        approvalStatus,
      };
      break;
    }
    case "mcp.tool.completed":
      extras = ["durationMs", "resultByteCount", "resultHash"];
      requiredExtras = extras;
      status = "completed";
      details = {
        durationMs: requireDuration(record.durationMs, code),
        resultByteCount: requireByteCount(record.resultByteCount, code),
        resultHash: requireContentHash(record.resultHash, code),
      };
      break;
    case "mcp.tool.failed":
      extras = ["durationMs", "errorCode"];
      requiredExtras = extras;
      status = "failed";
      details = {
        durationMs: requireDuration(record.durationMs, code),
        errorCode: requireSanitizedErrorCode(record.errorCode, code),
      };
      break;
    case "mcp.tool.cancelled":
      extras = ["durationMs"];
      requiredExtras = extras;
      status = "cancelled";
      details = {
        durationMs: requireDuration(record.durationMs, code),
        errorCode: "cancelled",
      };
      break;
  }

  requireExactShape(
    record,
    [...commonKeys, ...toolKeys, ...extras],
    [...requiredCommon, ...toolKeys, ...requiredExtras],
    code,
  );
  return withAuditIdentity({
    ...scope,
    ...tool,
    ...details,
    type,
    status,
  });
}

function withAuditIdentity(
  payload: Omit<PersistedAuditEvent, "version" | "eventId">,
): PersistedAuditEvent {
  const identity: Record<string, unknown> = {
    type: payload.type,
    sessionId: payload.sessionId,
    runId: payload.runId,
    assignmentId: payload.assignmentId,
    ...(payload.workflowId ? { workflowId: payload.workflowId } : {}),
    ...(payload.workflowStepId
      ? { workflowStepId: payload.workflowStepId }
      : {}),
    agentPath: payload.agentPath,
    serverId: payload.serverId,
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
    ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
    ...(payload.namespacedToolName
      ? { namespacedToolName: payload.namespacedToolName }
      : {}),
    ...(payload.toolRisk ? { toolRisk: payload.toolRisk } : {}),
    ...(payload.argumentsHash ? { argumentsHash: payload.argumentsHash } : {}),
    ...(payload.interactionId ? { interactionId: payload.interactionId } : {}),
    ...(payload.elicitationMode
      ? { elicitationMode: payload.elicitationMode }
      : {}),
    ...(payload.elicitationStatus
      ? { elicitationStatus: payload.elicitationStatus }
      : {}),
    ...(payload.snapshotId ? { snapshotId: payload.snapshotId } : {}),
  };
  return {
    version: MCP_AUDIT_EVENT_VERSION,
    eventId: `mcp_audit_${hashString(canonicalizeMcpJson(identity))}`,
    ...payload,
  };
}

function parsePersistedAuditEvent(line: string): PersistedAuditEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const record = requireRecord(parsed, "corrupt_store");
  if (
    record.version !== MCP_AUDIT_EVENT_VERSION ||
    typeof record.eventId !== "string" ||
    !AUDIT_ID.test(record.eventId) ||
    typeof record.status !== "string"
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const input: Record<string, unknown> = { ...record };
  delete input.version;
  delete input.eventId;
  delete input.status;
  if (record.type === "mcp.tool.cancelled") delete input.errorCode;
  const normalized = normalizeAuditEvent(input, "corrupt_store");
  if (canonicalizeMcpJson(normalized) !== canonicalizeMcpJson(record)) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  return normalized;
}

function normalizeAuditScope(
  record: Record<string, unknown>,
  code: McpEvidenceStoreErrorCode,
): McpAuditScopeInput {
  const workflowId = requireOptionalIdentifier(record.workflowId, code);
  const workflowStepId = requireOptionalIdentifier(record.workflowStepId, code);
  if (workflowStepId && !workflowId) throw new McpEvidenceStoreError(code);
  const agentPath =
    typeof record.agentPath === "string"
      ? normalizeMcpAgentPath(record.agentPath)
      : null;
  if (!agentPath) throw new McpEvidenceStoreError(code);
  return {
    timestamp: requireIsoTimestamp(record.timestamp, code),
    sessionId: requireIdentifier(record.sessionId, code),
    runId: requireIdentifier(record.runId, code),
    assignmentId: requireIdentifier(record.assignmentId, code),
    ...(workflowId ? { workflowId } : {}),
    ...(workflowStepId ? { workflowStepId } : {}),
    agentPath,
    serverId: requireServerId(record.serverId, code),
  };
}

function normalizeAuditToolBinding(
  record: Record<string, unknown>,
  code: McpEvidenceStoreErrorCode,
): Pick<
  PersistedAuditEvent,
  | "requestId"
  | "toolCallId"
  | "namespacedToolName"
  | "toolRisk"
  | "argumentNames"
  | "argumentsHash"
> {
  if (
    typeof record.namespacedToolName !== "string" ||
    !record.namespacedToolName.startsWith("mcp__") ||
    !isMcpApprovalToolRisk(record.toolRisk)
  ) {
    throw new McpEvidenceStoreError(code);
  }
  return {
    requestId: requireIdentifier(record.requestId, code),
    toolCallId: requireIdentifier(record.toolCallId, code),
    namespacedToolName: requireIdentifier(record.namespacedToolName, code),
    toolRisk: record.toolRisk,
    argumentNames: requireArgumentNames(record.argumentNames, code),
    argumentsHash: requireArgumentsHash(record.argumentsHash, code),
  };
}

function redactAuditEvent(event: PersistedAuditEvent): McpAuditEventView {
  const { requestId: _requestId, ...view } = event;
  return view;
}

function prepareEvidence(
  input: McpToolResultEvidenceImportInput,
  maxContentBytes: number,
  maxAggregateBytes: number,
): PreparedEvidence {
  const record = requireRecord(input, "invalid_request");
  const allowed = [
    "sessionId",
    "runId",
    "assignmentId",
    "workflowId",
    "workflowStepId",
    "agentPath",
    "serverId",
    "requestId",
    "toolCallId",
    "namespacedToolName",
    "content",
  ];
  const required = allowed.filter(
    (key) => key !== "workflowId" && key !== "workflowStepId",
  );
  requireExactShape(record, allowed, required, "invalid_request");
  const scope = normalizeAuditScope(
    { ...record, timestamp: "2000-01-01T00:00:00.000Z" },
    "invalid_request",
  );
  if (
    typeof record.namespacedToolName !== "string" ||
    !record.namespacedToolName.startsWith("mcp__") ||
    !Array.isArray(record.content) ||
    record.content.length > MAX_CONTENT_ITEMS
  ) {
    throw new McpEvidenceStoreError("invalid_request");
  }

  const contents: PreparedContent[] = [];
  let totalBytes = 0;
  for (let index = 0; index < record.content.length; index += 1) {
    const prepared = prepareToolResultContent(
      record.content[index],
      index,
      maxContentBytes,
    );
    totalBytes += prepared.buffer.byteLength;
    if (totalBytes > maxAggregateBytes) {
      throw new McpEvidenceStoreError("result_too_large");
    }
    contents.push(prepared);
  }
  const aggregateHash: McpContentHash = {
    algorithm: "sha256",
    value: hashString(
      canonicalizeMcpJson(contents.map((content) => content.manifest)),
    ),
  };
  const baseIdentity = {
    version: MCP_TOOL_RESULT_EVIDENCE_VERSION,
    kind: "tool-result" as const,
    sessionId: scope.sessionId,
    runId: scope.runId,
    assignmentId: scope.assignmentId,
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    ...(scope.workflowStepId ? { workflowStepId: scope.workflowStepId } : {}),
    agentPath: scope.agentPath,
    serverId: scope.serverId,
    requestId: requireIdentifier(record.requestId, "invalid_request"),
    toolCallId: requireIdentifier(record.toolCallId, "invalid_request"),
    namespacedToolName: requireIdentifier(
      record.namespacedToolName,
      "invalid_request",
    ),
    totalBytes,
    aggregateHash,
    contents: contents.map((content) => content.manifest),
  };
  const evidenceId = `mcp_tool_result_${hashString(
    canonicalizeMcpJson(baseIdentity),
  )}`;
  return {
    identity: { ...baseIdentity, evidenceId },
    contents,
  };
}

function prepareToolResultContent(
  value: unknown,
  index: number,
  maxContentBytes: number,
): PreparedContent {
  const record = requireRecord(value, "invalid_request");
  let buffer: Buffer;
  let type: "text" | "json";
  let mimeType: "text/plain" | "application/json";
  let extension: "txt" | "json";
  if (record.type === "text") {
    requireExactShape(
      record,
      ["type", "text"],
      ["type", "text"],
      "invalid_request",
    );
    if (typeof record.text !== "string") {
      throw new McpEvidenceStoreError("invalid_request");
    }
    buffer = Buffer.from(record.text, "utf8");
    type = "text";
    mimeType = "text/plain";
    extension = "txt";
  } else if (record.type === "json") {
    requireExactShape(
      record,
      ["type", "value"],
      ["type", "value"],
      "invalid_request",
    );
    try {
      buffer = Buffer.from(canonicalizeMcpJson(record.value), "utf8");
    } catch {
      throw new McpEvidenceStoreError("invalid_request");
    }
    type = "json";
    mimeType = "application/json";
    extension = "json";
  } else {
    throw new McpEvidenceStoreError("invalid_request");
  }
  if (buffer.byteLength > maxContentBytes) {
    throw new McpEvidenceStoreError("result_too_large");
  }
  return {
    buffer,
    manifest: {
      index,
      type,
      mimeType,
      byteLength: buffer.byteLength,
      sha256: hashBuffer(buffer),
      storedPath: `${CONTENTS_DIRECTORY}/${String(index).padStart(2, "0")}.${extension}`,
    },
  };
}

async function publishEvidence(
  rootPath: string,
  manifest: ToolResultManifest,
  contents: readonly PreparedContent[],
): Promise<void> {
  const targetPath = path.join(rootPath, manifest.evidenceId);
  const temporaryPath = path.join(
    rootPath,
    `.tool-result-${manifest.evidenceId}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let published = false;
  try {
    await fs.mkdir(temporaryPath, { mode: 0o700 });
    await fs.chmod(temporaryPath, 0o700);
    const contentsPath = path.join(temporaryPath, CONTENTS_DIRECTORY);
    await fs.mkdir(contentsPath, { mode: 0o700 });
    await fs.chmod(contentsPath, 0o700);
    for (const content of contents) {
      await writeExclusiveReadOnly(
        path.join(temporaryPath, ...content.manifest.storedPath.split("/")),
        content.buffer,
      );
    }
    await syncDirectory(contentsPath);
    await writeExclusiveReadOnly(
      path.join(temporaryPath, MANIFEST_FILENAME),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    );
    await syncDirectory(temporaryPath);
    if (await pathExists(targetPath)) {
      throw new McpEvidenceStoreError("conflict");
    }
    await fs.rename(temporaryPath, targetPath);
    published = true;
    await syncDirectory(rootPath);
  } finally {
    if (!published) {
      await fs
        .rm(temporaryPath, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
}

function parseToolResultManifest(
  buffer: Buffer,
  expected: {
    evidenceId: string;
    sessionId: string;
    runId: string;
    assignmentId: string;
  },
): ToolResultManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const record = requireRecord(parsed, "corrupt_store");
  const allowed = [
    "version",
    "evidenceId",
    "kind",
    "sessionId",
    "runId",
    "assignmentId",
    "workflowId",
    "workflowStepId",
    "agentPath",
    "serverId",
    "requestId",
    "toolCallId",
    "namespacedToolName",
    "recordedAt",
    "totalBytes",
    "aggregateHash",
    "contents",
  ];
  const required = allowed.filter(
    (key) => key !== "workflowId" && key !== "workflowStepId",
  );
  requireExactShape(record, allowed, required, "corrupt_store");
  if (
    record.version !== MCP_TOOL_RESULT_EVIDENCE_VERSION ||
    record.kind !== "tool-result" ||
    record.evidenceId !== expected.evidenceId ||
    record.sessionId !== expected.sessionId ||
    record.runId !== expected.runId ||
    record.assignmentId !== expected.assignmentId ||
    typeof record.namespacedToolName !== "string" ||
    !record.namespacedToolName.startsWith("mcp__") ||
    !Array.isArray(record.contents) ||
    record.contents.length > MAX_CONTENT_ITEMS
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const workflowId = requireOptionalIdentifier(
    record.workflowId,
    "corrupt_store",
  );
  const workflowStepId = requireOptionalIdentifier(
    record.workflowStepId,
    "corrupt_store",
  );
  if (workflowStepId && !workflowId) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const agentPath =
    typeof record.agentPath === "string"
      ? normalizeMcpAgentPath(record.agentPath)
      : null;
  if (!agentPath) throw new McpEvidenceStoreError("corrupt_store");
  const contents = record.contents.map((content, index) =>
    parseManifestContent(content, index),
  );
  const totalBytes = contents.reduce(
    (total, content) => total + content.byteLength,
    0,
  );
  if (
    !Number.isSafeInteger(record.totalBytes) ||
    record.totalBytes !== totalBytes
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const manifest: ToolResultManifest = {
    version: MCP_TOOL_RESULT_EVIDENCE_VERSION,
    evidenceId: expected.evidenceId,
    kind: "tool-result",
    sessionId: expected.sessionId,
    runId: expected.runId,
    assignmentId: expected.assignmentId,
    ...(workflowId ? { workflowId } : {}),
    ...(workflowStepId ? { workflowStepId } : {}),
    agentPath,
    serverId: requireServerId(record.serverId, "corrupt_store"),
    requestId: requireIdentifier(record.requestId, "corrupt_store"),
    toolCallId: requireIdentifier(record.toolCallId, "corrupt_store"),
    namespacedToolName: requireIdentifier(
      record.namespacedToolName,
      "corrupt_store",
    ),
    recordedAt: requireIsoTimestamp(record.recordedAt, "corrupt_store"),
    totalBytes,
    aggregateHash: requireContentHash(record.aggregateHash, "corrupt_store"),
    contents,
  };
  const expectedAggregate = hashString(canonicalizeMcpJson(contents));
  if (manifest.aggregateHash.value !== expectedAggregate) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const identity = { ...manifest } as Record<string, unknown>;
  delete identity.recordedAt;
  delete identity.evidenceId;
  const computedEvidenceId = `mcp_tool_result_${hashString(
    canonicalizeMcpJson(identity),
  )}`;
  if (computedEvidenceId !== manifest.evidenceId) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  return manifest;
}

function parseManifestContent(
  value: unknown,
  expectedIndex: number,
): ToolResultManifestContent {
  const record = requireRecord(value, "corrupt_store");
  requireExactShape(
    record,
    ["index", "type", "mimeType", "byteLength", "sha256", "storedPath"],
    ["index", "type", "mimeType", "byteLength", "sha256", "storedPath"],
    "corrupt_store",
  );
  if (
    record.index !== expectedIndex ||
    (record.type !== "text" && record.type !== "json") ||
    (record.mimeType !== "text/plain" &&
      record.mimeType !== "application/json") ||
    (record.type === "text" && record.mimeType !== "text/plain") ||
    (record.type === "json" && record.mimeType !== "application/json") ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 0 ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256) ||
    typeof record.storedPath !== "string"
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const pathMatch = CONTENT_PATH.exec(record.storedPath);
  const expectedExtension = record.type === "text" ? "txt" : "json";
  if (
    !pathMatch ||
    Number(pathMatch[1]) !== expectedIndex ||
    pathMatch[2] !== expectedExtension
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  return {
    index: expectedIndex,
    type: record.type,
    mimeType: record.mimeType,
    byteLength: record.byteLength as number,
    sha256: record.sha256,
    storedPath: record.storedPath,
  };
}

async function verifyEvidenceContents(
  evidencePath: string,
  manifest: ToolResultManifest,
  maxContentBytes: number,
  maxAggregateBytes: number,
): Promise<void> {
  if (
    manifest.totalBytes > maxAggregateBytes ||
    manifest.contents.some((content) => content.byteLength > maxContentBytes)
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const contentsPath = path.join(evidencePath, CONTENTS_DIRECTORY);
  await requireSecureDirectory(contentsPath, evidencePath, 0o700);
  const entries = await fs.readdir(contentsPath, { withFileTypes: true });
  const expected = new Set(
    manifest.contents.map((content) =>
      content.storedPath.slice(`${CONTENTS_DIRECTORY}/`.length),
    ),
  );
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || !expected.has(entry.name))
  ) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  for (const content of manifest.contents) {
    const buffer = await readSecureFile(
      path.join(evidencePath, ...content.storedPath.split("/")),
      contentsPath,
      content.byteLength,
      0o400,
    );
    if (
      buffer.byteLength !== content.byteLength ||
      hashBuffer(buffer) !== content.sha256
    ) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    if (content.type === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new McpEvidenceStoreError("corrupt_store");
      }
      if (canonicalizeMcpJson(parsed) !== buffer.toString("utf8")) {
        throw new McpEvidenceStoreError("corrupt_store");
      }
    }
  }
}

function toolResultEvidenceView(
  evidencePath: string,
  manifest: ToolResultManifest,
): McpToolResultEvidenceView {
  return {
    evidencePath,
    record: {
      evidenceId: manifest.evidenceId,
      kind: "tool-result",
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      assignmentId: manifest.assignmentId,
      ...(manifest.workflowId ? { workflowId: manifest.workflowId } : {}),
      ...(manifest.workflowStepId
        ? { workflowStepId: manifest.workflowStepId }
        : {}),
      agentPath: manifest.agentPath,
      serverId: manifest.serverId,
      recordedAt: manifest.recordedAt,
      toolCallId: manifest.toolCallId,
      namespacedToolName: manifest.namespacedToolName,
    },
    totalBytes: manifest.totalBytes,
    aggregateHash: { ...manifest.aggregateHash },
    contents: manifest.contents.map((content) => ({ ...content })),
  };
}

function samePreparedEvidence(
  existing: McpToolResultEvidenceView,
  expected: Omit<ToolResultManifest, "recordedAt">,
): boolean {
  return (
    existing.record.evidenceId === expected.evidenceId &&
    existing.record.sessionId === expected.sessionId &&
    existing.record.runId === expected.runId &&
    existing.record.assignmentId === expected.assignmentId &&
    existing.record.workflowId === expected.workflowId &&
    existing.record.workflowStepId === expected.workflowStepId &&
    existing.record.agentPath === expected.agentPath &&
    existing.record.serverId === expected.serverId &&
    existing.record.toolCallId === expected.toolCallId &&
    existing.record.namespacedToolName === expected.namespacedToolName &&
    existing.totalBytes === expected.totalBytes &&
    sameContentHash(existing.aggregateHash, expected.aggregateHash) &&
    canonicalizeMcpJson(existing.contents) ===
      canonicalizeMcpJson(expected.contents)
  );
}

async function ensurePrivateDirectory(
  directoryPath: string,
  parentPath: string,
): Promise<void> {
  try {
    await fs.mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
  await requireSecureDirectory(directoryPath, parentPath);
  await fs.chmod(directoryPath, 0o700);
  requireMode((await fs.lstat(directoryPath)).mode, 0o700);
}

async function requireSecureDirectory(
  directoryPath: string,
  parentPath: string,
  expectedMode?: number,
): Promise<Stats> {
  const stat = await fs.lstat(directoryPath).catch((error) => {
    if (isFileSystemError(error, "ENOENT")) {
      throw new McpEvidenceStoreError("not_found");
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  const [realParent, realDirectory] = await Promise.all([
    fs.realpath(parentPath),
    fs.realpath(directoryPath),
  ]);
  if (!isPathInside(realParent, realDirectory)) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  if (expectedMode !== undefined) requireMode(stat.mode, expectedMode);
  return stat;
}

async function readSecureFile(
  filePath: string,
  parentPath: string,
  maximumBytes: number,
  expectedMode: number,
): Promise<Buffer> {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (isFileSystemError(error, "ENOENT")) {
      throw new McpEvidenceStoreError("corrupt_store");
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  requireMode(stat.mode, expectedMode);
  const [realParent, realFile] = await Promise.all([
    fs.realpath(parentPath),
    fs.realpath(filePath),
  ]);
  if (!isPathInside(realParent, realFile)) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  return fs.readFile(filePath);
}

async function appendSecureFile(
  filePath: string,
  line: Uint8Array,
): Promise<void> {
  const flags =
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_WRONLY |
    (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, flags, 0o600);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new McpEvidenceStoreError("corrupt_store");
    await handle.writeFile(line);
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeExclusiveReadOnly(
  filePath: string,
  contents: Uint8Array,
): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "wx", 0o400);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function requireExactShape(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  code: McpEvidenceStoreErrorCode,
): void {
  const allowedSet = new Set(allowed);
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.some((key) => typeof key !== "string" || !allowedSet.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new McpEvidenceStoreError(code);
  }
}

function requireRecord(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpEvidenceStoreError(code);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new McpEvidenceStoreError(code);
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new McpEvidenceStoreError(code);
  }
  return value;
}

function requireOptionalIdentifier(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): string | undefined {
  return value === undefined ? undefined : requireIdentifier(value, code);
}

function requireServerId(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): string {
  const serverId = requireIdentifier(value, code);
  if (!isSafePathSegment(serverId)) throw new McpEvidenceStoreError(code);
  return serverId;
}

function requireArgumentNames(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENT_NAMES) {
    throw new McpEvidenceStoreError(code);
  }
  const names = value.map((name) => requireIdentifier(name, code));
  if (
    names.some(
      (name) =>
        name === "__proto__" || name === "constructor" || name === "prototype",
    ) ||
    names.some((name, index) => {
      const previous = names[index - 1];
      return previous !== undefined && previous >= name;
    })
  ) {
    throw new McpEvidenceStoreError(code);
  }
  return names;
}

function requireArgumentsHash(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): McpApprovalArgumentsHash {
  if (!isMcpApprovalArgumentsHash(value)) {
    throw new McpEvidenceStoreError(code);
  }
  return { ...value };
}

function requireContentHash(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): McpContentHash {
  const record = requireRecord(value, code);
  requireExactShape(
    record,
    ["algorithm", "value"],
    ["algorithm", "value"],
    code,
  );
  if (
    record.algorithm !== "sha256" ||
    typeof record.value !== "string" ||
    !SHA256.test(record.value)
  ) {
    throw new McpEvidenceStoreError(code);
  }
  return { algorithm: "sha256", value: record.value };
}

function requireTerminalApprovalStatus(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): Exclude<McpApprovalStatus, "pending"> {
  if (!isMcpApprovalStatus(value) || value === "pending") {
    throw new McpEvidenceStoreError(code);
  }
  return value;
}

function requireSanitizedErrorCode(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): McpSanitizedErrorCode {
  if (typeof value !== "string" || !SANITIZED_ERROR_CODES.has(value)) {
    throw new McpEvidenceStoreError(code);
  }
  return value as McpSanitizedErrorCode;
}

function requireByteCount(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_CONFIGURED_BYTES
  ) {
    throw new McpEvidenceStoreError(code);
  }
  return value as number;
}

function requireDuration(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_DURATION_MS
  ) {
    throw new McpEvidenceStoreError(code);
  }
  return value as number;
}

function requireIsoTimestamp(
  value: unknown,
  code: McpEvidenceStoreErrorCode,
): string {
  if (typeof value !== "string") throw new McpEvidenceStoreError(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new McpEvidenceStoreError(code);
  }
  return value;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new McpEvidenceStoreError("invalid_request");
  }
  return value;
}

function sameContentHash(left: McpContentHash, right: McpContentHash): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function hashBuffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireMode(mode: number, expected: number): void {
  if (process.platform !== "win32" && (mode & 0o777) !== expected) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function fileSizeOrZero(filePath: string): Promise<number> {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  });
  if (!stat) return 0;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new McpEvidenceStoreError("corrupt_store");
  }
  requireMode(stat.mode, 0o600);
  return stat.size;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs
    .lstat(filePath)
    .then(() => true)
    .catch((error) => {
      if (isFileSystemError(error, "ENOENT")) return false;
      throw error;
    });
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function compareEvidenceViews(
  left: McpToolResultEvidenceView,
  right: McpToolResultEvidenceView,
): number {
  return (
    left.record.recordedAt.localeCompare(right.record.recordedAt) ||
    left.record.evidenceId.localeCompare(right.record.evidenceId)
  );
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function evidenceStoreErrorMessage(code: McpEvidenceStoreErrorCode): string {
  switch (code) {
    case "invalid_request":
      return "MCP evidence request is invalid.";
    case "not_found":
      return "MCP evidence assignment was not found.";
    case "conflict":
      return "MCP evidence already exists with different metadata.";
    case "result_too_large":
      return "MCP evidence content exceeds the configured limit.";
    case "capacity_exceeded":
      return "MCP audit capacity was exceeded.";
    case "corrupt_store":
      return "MCP evidence storage is invalid.";
    case "io_error":
      return "MCP evidence storage operation failed.";
  }
}
