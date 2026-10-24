import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { CapabilityEffect } from '../../contracts/capability-effect.js'
import { openOwnedFileForAppend } from '../../core/owned-file.js'
import type {
  CapabilityApprovalOutcome,
  CapabilityDispatchEvent,
  CapabilityDispatchEventType,
  CapabilityEvidencePort,
  CapabilityScopeAuthority,
  CapabilitySourceKind,
} from '../../contracts/capability-dispatch.js'

export const CAPABILITY_DISPATCH_EVENT_LOG_FILENAME =
  'capability-dispatch-events.jsonl'

export interface AssignmentCapabilityEvidenceWriterOptions {
  readonly assignmentPath: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}

export interface CapabilityEvidenceWriterMetrics {
  readonly appendOperations: number
  readonly bytesWritten: number
  readonly directoryCreateOperations: number
}

/** Owns ordered JSONL writes for one assignment and strips runtime extras. */
export class AssignmentCapabilityEvidenceWriter implements CapabilityEvidencePort {
  readonly filePath: string
  private readonly assignmentPath: string
  private readonly logsPath: string
  private readonly identity: Pick<
    AssignmentCapabilityEvidenceWriterOptions,
    'sessionId' | 'runId' | 'assignmentId'
  >
  private appendTail: Promise<void> = Promise.resolve()
  private fileHandle: fs.FileHandle | undefined
  private opening: Promise<fs.FileHandle> | undefined
  private closed = false
  private closePromise: Promise<void> | undefined
  private appendOperations = 0
  private bytesWritten = 0
  private directoryCreateOperations = 0

  constructor(options: AssignmentCapabilityEvidenceWriterOptions) {
    if (!isNonEmptyString(options.assignmentPath)) {
      throw new Error('Capability evidence assignment path is invalid.')
    }
    if (
      !isIdentifier(options.sessionId) ||
      !isIdentifier(options.runId) ||
      !isIdentifier(options.assignmentId)
    ) {
      throw new Error('Capability evidence assignment identity is invalid.')
    }
    const assignmentPath = path.resolve(options.assignmentPath)
    this.assignmentPath = assignmentPath
    this.logsPath = path.join(assignmentPath, 'logs')
    this.filePath = path.join(
      this.logsPath,
      CAPABILITY_DISPATCH_EVENT_LOG_FILENAME,
    )
    this.identity = {
      sessionId: options.sessionId,
      runId: options.runId,
      assignmentId: options.assignmentId,
    }
  }

  append(event: CapabilityDispatchEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Capability evidence writer is closed.'))
    }
    let sanitized: CapabilityDispatchEvent
    try {
      sanitized = sanitizeDispatchEvent(event, this.identity)
    } catch (error) {
      return Promise.reject(error)
    }
    const line = `${JSON.stringify(sanitized)}\n`
    const operation = this.appendTail.then(() => this.writeLine(line))
    this.appendTail = operation.catch(() => undefined)
    return operation
  }

  getMetrics(): CapabilityEvidenceWriterMetrics {
    return {
      appendOperations: this.appendOperations,
      bytesWritten: this.bytesWritten,
      directoryCreateOperations: this.directoryCreateOperations,
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = this.closeAfterPendingWrites()
    return this.closePromise
  }

  private async writeLine(line: string): Promise<void> {
    const handle = await this.openHandle()
    await handle.write(line, undefined, 'utf8')
    this.appendOperations += 1
    this.bytesWritten += Buffer.byteLength(line, 'utf8')
  }

  private openHandle(): Promise<fs.FileHandle> {
    if (this.fileHandle) return Promise.resolve(this.fileHandle)
    if (this.opening) return this.opening
    this.opening = this.createHandle()
    return this.opening
  }

  private async createHandle(): Promise<fs.FileHandle> {
    this.directoryCreateOperations += 1
    try {
      // The same primitive the canonical journal projection uses. These two
      // write the same file, so the check that keeps a symlink from
      // redirecting it has to be one implementation rather than two copies
      // that must agree (AC20).
      const handle = await openOwnedFileForAppend({
        containerPath: this.assignmentPath,
        filePath: this.filePath,
      })
      this.fileHandle = handle
      return handle
    } catch (error) {
      throw new Error('Capability evidence path is not canonical.', {
        cause: error,
      })
    }
  }

  private async closeAfterPendingWrites(): Promise<void> {
    await this.appendTail
    const handle = this.fileHandle
    if (handle) {
      this.fileHandle = undefined
      await handle.close()
    }
  }
}

function sanitizeDispatchEvent(
  input: unknown,
  identity: Readonly<{
    sessionId: string
    runId: string
    assignmentId: string
  }>,
): CapabilityDispatchEvent {
  if (!isRecord(input)) throw new Error('Capability dispatch event is invalid.')
  if (
    input.contractVersion !== 1 ||
    !isDispatchEventType(input.type) ||
    !isIsoTimestamp(input.timestamp) ||
    !isIdentifier(input.dispatchId) ||
    !isIdentifier(input.attemptId) ||
    !isIdentifier(input.requestId) ||
    input.sessionId !== identity.sessionId ||
    input.runId !== identity.runId ||
    input.assignmentId !== identity.assignmentId ||
    !isOptionalIdentifier(input.taskId) ||
    !isNonEmptyString(input.agentPath) ||
    !isOptionalIdentifier(input.agentId) ||
    !isOptionalIdentifier(input.activityScopeId) ||
    !isOptionalIdentifier(input.workflowId) ||
    !isOptionalIdentifier(input.workflowStepId) ||
    !isAuthorityKind(input.authorityKind) ||
    !isIdentifier(input.capabilityId) ||
    !isCapabilitySourceKind(input.sourceKind) ||
    !isIdentifier(input.sourceId) ||
    !isOptionalIdentifier(input.sourceVersion) ||
    !isSha256(input.argumentDigest) ||
    !isStringArray(input.argumentNames)
  ) {
    throw new Error('Capability dispatch event is invalid.')
  }
  const effect = input.effect === undefined
    ? undefined
    : readCapabilityEffect(input.effect)
  if (input.effect !== undefined && !effect) {
    throw new Error('Capability dispatch event effect is invalid.')
  }
  if (input.code !== undefined && !isIdentifier(input.code)) {
    throw new Error('Capability dispatch event code is invalid.')
  }
  if (input.interactionId !== undefined && !isIdentifier(input.interactionId)) {
    throw new Error('Capability dispatch interaction identity is invalid.')
  }
  if (
    input.approvalOutcome !== undefined &&
    !isApprovalOutcome(input.approvalOutcome)
  ) {
    throw new Error('Capability dispatch approval outcome is invalid.')
  }
  if (input.costTracked !== undefined && typeof input.costTracked !== 'boolean') {
    throw new Error('Capability dispatch cost tracking flag is invalid.')
  }
  if (input.budgetOverrun !== undefined && typeof input.budgetOverrun !== 'boolean') {
    throw new Error('Capability dispatch budget overrun flag is invalid.')
  }
  if (
    input.actualCostUsd !== undefined &&
    !isFiniteNonNegativeNumber(input.actualCostUsd)
  ) {
    throw new Error('Capability dispatch actual cost is invalid.')
  }

  return {
    contractVersion: 1,
    type: input.type,
    timestamp: input.timestamp,
    dispatchId: input.dispatchId,
    attemptId: input.attemptId,
    requestId: input.requestId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    assignmentId: identity.assignmentId,
    ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}),
    agentPath: input.agentPath,
    ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
    ...(typeof input.activityScopeId === 'string'
      ? { activityScopeId: input.activityScopeId }
      : {}),
    ...(typeof input.workflowId === 'string'
      ? { workflowId: input.workflowId }
      : {}),
    ...(typeof input.workflowStepId === 'string'
      ? { workflowStepId: input.workflowStepId }
      : {}),
    authorityKind: input.authorityKind,
    capabilityId: input.capabilityId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    ...(typeof input.sourceVersion === 'string'
      ? { sourceVersion: input.sourceVersion }
      : {}),
    argumentDigest: input.argumentDigest,
    argumentNames: [...input.argumentNames],
    ...(effect ? { effect } : {}),
    ...(typeof input.code === 'string' ? { code: input.code } : {}),
    ...(typeof input.interactionId === 'string'
      ? { interactionId: input.interactionId }
      : {}),
    ...(isApprovalOutcome(input.approvalOutcome)
      ? { approvalOutcome: input.approvalOutcome }
      : {}),
    ...(typeof input.costTracked === 'boolean'
      ? { costTracked: input.costTracked }
      : {}),
    ...(typeof input.budgetOverrun === 'boolean'
      ? { budgetOverrun: input.budgetOverrun }
      : {}),
    ...(isFiniteNonNegativeNumber(input.actualCostUsd)
      ? { actualCostUsd: input.actualCostUsd }
      : {}),
  }
}

function readCapabilityEffect(value: unknown): CapabilityEffect | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.kind !== 'read-only' &&
    value.kind !== 'mutating' &&
    value.kind !== 'destructive' &&
    value.kind !== 'unknown'
  ) {
    return undefined
  }
  if (value.concurrency !== 'serial' && value.concurrency !== 'parallel-safe') {
    return undefined
  }
  return { kind: value.kind, concurrency: value.concurrency }
}

function isDispatchEventType(value: unknown): value is CapabilityDispatchEventType {
  return value === 'capability.dispatch.requested' ||
    value === 'capability.dispatch.approval_requested' ||
    value === 'capability.dispatch.approval_resolved' ||
    value === 'capability.dispatch.started' ||
    value === 'capability.dispatch.completed' ||
    value === 'capability.dispatch.rejected' ||
    value === 'capability.dispatch.cancelled' ||
    value === 'capability.dispatch.failed' ||
    value === 'capability.dispatch.indeterminate'
}

function isCapabilitySourceKind(value: unknown): value is CapabilitySourceKind {
  return value === 'builtin' || value === 'mcp' || value === 'pi-host' || value === 'engine'
}

function isAuthorityKind(
  value: unknown,
): value is CapabilityScopeAuthority['kind'] {
  return value === 'mcp-lease' ||
    value === 'runtime-assignment' ||
    value === 'parent-capability'
}

function isApprovalOutcome(value: unknown): value is CapabilityApprovalOutcome {
  return value === 'approved' ||
    value === 'denied' ||
    value === 'expired' ||
    value === 'cancelled' ||
    value === 'interrupted'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value)
}

function isOptionalIdentifier(value: unknown): boolean {
  return value === undefined || isIdentifier(value)
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isIdentifier)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
