import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { withFileMutationLock, writeFileAtomic } from '../../core/file-mutation.js'
import {
  MCP_APPROVAL_STATE_VERSION,
  McpApprovalError,
  hashMcpApprovalArguments,
  isMcpApprovalArgumentsHash,
  isMcpApprovalStatus,
  isMcpApprovalToolRisk,
  type McpApprovalAssignmentScope,
  type McpApprovalCancelInput,
  type McpApprovalExactBinding,
  type McpApprovalRequestInput,
  type McpApprovalResponseInput,
  type McpApprovalScope,
  type McpApprovalStatus,
  type McpApprovalView,
  type McpReusableRunApprovalQuery,
} from './mcp-approval.js'
import type { McpToolRisk } from './mcp-runtime.js'
import { normalizeMcpAgentPath } from './mcp-settings.js'
import {
  buildSessionRunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from '../run/run-location.js'

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1_000
const MAX_APPROVAL_TTL_MS = 60 * 60 * 1_000
const DEFAULT_MAX_RECORDS = 1_024
const MAX_STATE_FILE_BYTES = 8 * 1_024 * 1_024
const MAX_IDENTIFIER_LENGTH = 512
const APPROVAL_STATE_FILE = 'state.json'

interface McpApprovalStateV1 {
  readonly version: typeof MCP_APPROVAL_STATE_VERSION
  readonly assignment: McpApprovalAssignmentScope
  readonly updatedAt: string
  readonly requests: readonly McpApprovalRecord[]
}

/** Persistence shape; deliberately not exported to API or renderer consumers. */
interface McpApprovalRecord extends McpApprovalExactBinding {
  readonly interactionId: string
  readonly argumentNames: readonly string[]
  readonly status: McpApprovalStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt?: string
  readonly responseId?: string
  readonly decision?: 'approve' | 'deny'
  readonly approvalScope?: McpApprovalScope
}

export interface McpApprovalStoreOptions extends McpApprovalAssignmentScope {
  readonly workspacePath: string
  readonly now?: () => number
  readonly defaultTtlMs?: number
  readonly maxRecords?: number
}

/** Parent-process owner for one canonical session/run assignment approval file. */
export class McpApprovalStore {
  private readonly workspacePath: string
  private readonly location: SessionRunAssignmentLocation
  private readonly assignment: McpApprovalAssignmentScope
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly maxRecords: number
  private readonly mcpDirectory: string
  private readonly approvalDirectory: string
  private readonly statePath: string

  constructor(options: McpApprovalStoreOptions) {
    const workspacePath = path.resolve(options.workspacePath)
    const location = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: options.sessionId,
      runId: options.runId,
      assignmentId: options.assignmentId,
    })
    if (!location) throw new McpApprovalError('invalid_request')
    this.workspacePath = workspacePath
    this.location = location
    this.assignment = {
      sessionId: location.sessionId,
      runId: location.runId,
      assignmentId: location.assignmentId,
    }
    this.now = options.now ?? Date.now
    this.defaultTtlMs = boundedTtl(
      options.defaultTtlMs,
      DEFAULT_APPROVAL_TTL_MS,
    )
    this.maxRecords = positiveInteger(
      options.maxRecords,
      DEFAULT_MAX_RECORDS,
    )
    this.mcpDirectory = path.join(location.assignmentPath, 'mcp')
    this.approvalDirectory = path.join(this.mcpDirectory, 'approvals')
    this.statePath = path.join(this.approvalDirectory, APPROVAL_STATE_FILE)
  }

  async createRequest(input: McpApprovalRequestInput): Promise<McpApprovalView> {
    const normalized = normalizeRequestInput(input)
    this.requireStoreScope(normalized, 'binding_mismatch')
    const argumentSummary = hashMcpApprovalArguments(input.arguments)
    const ttlMs = boundedTtl(input.ttlMs, this.defaultTtlMs)

    return this.runLocked(true, async () => {
      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      const state = (await this.readState()) ?? this.emptyState(now)
      const duplicate = state.requests.find(
        (record) => record.interactionId === normalized.interactionId,
      )
      if (duplicate) {
        if (
          duplicate.interactionId === normalized.interactionId &&
          duplicate.toolCallId === normalized.toolCallId &&
          hasExactRequestBinding(duplicate, normalized, argumentSummary.argumentsHash)
        ) {
          return redactMcpApproval(duplicate)
        }
        throw new McpApprovalError('binding_mismatch')
      }
      if (state.requests.length >= this.maxRecords) {
        throw new McpApprovalError('capacity_exceeded')
      }

      const record: McpApprovalRecord = {
        interactionId: normalized.interactionId,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
        assignmentId: normalized.assignmentId,
        agentPath: normalized.agentPath,
        serverId: normalized.serverId,
        namespacedToolName: normalized.namespacedToolName,
        toolCallId: normalized.toolCallId,
        toolRisk: normalized.toolRisk,
        argumentNames: [...argumentSummary.argumentNames],
        argumentsHash: { ...argumentSummary.argumentsHash },
        status: 'pending',
        createdAt: now,
        expiresAt: toTimestamp(nowMs + ttlMs),
      }
      await this.writeState({
        ...state,
        updatedAt: now,
        requests: sortRecords([...state.requests, record]),
      })
      return redactMcpApproval(record)
    })
  }

  async get(interactionId: string): Promise<McpApprovalView | null> {
    const normalizedId = requireIdentifier(interactionId)
    return this.runLocked(false, async () => {
      const state = await this.readState()
      const record = state?.requests.find(
        (candidate) => candidate.interactionId === normalizedId,
      )
      return record ? redactMcpApproval(record) : null
    })
  }

  async list(): Promise<readonly McpApprovalView[]> {
    return this.runLocked(false, async () => {
      const state = await this.readState()
      return (state?.requests ?? []).map(redactMcpApproval)
    })
  }

  async respond(input: McpApprovalResponseInput): Promise<McpApprovalView> {
    const normalized = normalizeResponseInput(input)
    this.requireStoreScope(normalized, 'not_found')
    return this.runLocked(false, async () => {
      const state = await this.requireState()
      const record = requireRecord(state, normalized.interactionId)
      requireExactBinding(record, normalized)

      if (record.status !== 'pending') {
        if (isExactResponseReplay(record, normalized)) {
          return redactMcpApproval(record)
        }
        if (record.status === 'expired') {
          throw new McpApprovalError('expired')
        }
        throw new McpApprovalError('already_resolved')
      }

      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      if (Date.parse(record.expiresAt) <= nowMs) {
        await this.replaceRecord(state, {
          ...record,
          status: 'expired',
          resolvedAt: now,
        }, now)
        throw new McpApprovalError('expired')
      }

      const resolved: McpApprovalRecord = normalized.decision === 'approve'
        ? {
            ...record,
            status: normalized.scope === 'run'
              ? 'approved-run'
              : 'approved-once',
            resolvedAt: now,
            responseId: normalized.responseId,
            decision: 'approve',
            approvalScope: normalized.scope,
          }
        : {
            ...record,
            status: 'denied',
            resolvedAt: now,
            responseId: normalized.responseId,
            decision: 'deny',
          }
      await this.replaceRecord(state, resolved, now)
      return redactMcpApproval(resolved)
    })
  }

  async cancel(input: McpApprovalCancelInput): Promise<McpApprovalView> {
    const normalized = normalizeCancelInput(input)
    this.requireStoreScope(normalized, 'not_found')
    return this.runLocked(false, async () => {
      const state = await this.requireState()
      const record = requireRecord(state, normalized.interactionId)
      requireExactBinding(record, normalized)
      if (record.status === 'cancelled') return redactMcpApproval(record)
      if (record.status === 'expired') throw new McpApprovalError('expired')
      if (record.status !== 'pending') {
        throw new McpApprovalError('already_resolved')
      }

      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      if (Date.parse(record.expiresAt) <= nowMs) {
        await this.replaceRecord(state, {
          ...record,
          status: 'expired',
          resolvedAt: now,
        }, now)
        throw new McpApprovalError('expired')
      }
      const cancelled: McpApprovalRecord = {
        ...record,
        status: 'cancelled',
        resolvedAt: now,
      }
      await this.replaceRecord(state, cancelled, now)
      return redactMcpApproval(cancelled)
    })
  }

  async expirePending(): Promise<readonly McpApprovalView[]> {
    return this.runLocked(false, async () => {
      const state = await this.readState()
      if (!state) return []
      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      const expired: McpApprovalRecord[] = []
      const requests = state.requests.map((record) => {
        if (
          record.status !== 'pending' ||
          Date.parse(record.expiresAt) > nowMs
        ) {
          return record
        }
        const updated: McpApprovalRecord = {
          ...record,
          status: 'expired',
          resolvedAt: now,
        }
        expired.push(updated)
        return updated
      })
      if (expired.length > 0) {
        await this.writeState({ ...state, updatedAt: now, requests })
      }
      return expired.map(redactMcpApproval)
    })
  }

  /** Invoke exactly once when the owning parent runtime starts. */
  async recoverPendingAfterRestart(): Promise<readonly McpApprovalView[]> {
    return this.runLocked(false, async () => {
      const state = await this.readState()
      if (!state) return []
      const now = toTimestamp(this.currentTime())
      const interrupted: McpApprovalRecord[] = []
      const requests = state.requests.map((record) => {
        if (record.status !== 'pending') return record
        const updated: McpApprovalRecord = {
          ...record,
          status: 'interrupted',
          resolvedAt: now,
        }
        interrupted.push(updated)
        return updated
      })
      if (interrupted.length > 0) {
        await this.writeState({ ...state, updatedAt: now, requests })
      }
      return interrupted.map(redactMcpApproval)
    })
  }

  /**
   * Read-only run-scope lookup. The originating response remains bound to its
   * exact call and digest; reuse is limited to the same tool/risk/run scope.
   */
  async findReusableRunApproval(
    input: McpReusableRunApprovalQuery,
  ): Promise<McpApprovalView | null> {
    const normalized = normalizeRunApprovalQuery(input)
    if (!this.hasStoreScope(normalized)) return null
    return this.runLocked(false, async () => {
      const state = await this.readState()
      if (!state) return null
      const nowMs = this.currentTime()
      const candidate = state.requests
        .filter(
          (record) =>
            record.status === 'approved-run' &&
            Date.parse(record.expiresAt) > nowMs &&
            record.sessionId === normalized.sessionId &&
            record.runId === normalized.runId &&
            record.assignmentId === normalized.assignmentId &&
            record.agentPath === normalized.agentPath &&
            record.serverId === normalized.serverId &&
            record.namespacedToolName === normalized.namespacedToolName &&
            record.toolRisk === normalized.toolRisk,
        )
        .sort(compareMostRecentlyResolved)[0]
      return candidate ? redactMcpApproval(candidate) : null
    })
  }

  private async replaceRecord(
    state: McpApprovalStateV1,
    replacement: McpApprovalRecord,
    updatedAt: string,
  ): Promise<void> {
    await this.writeState({
      ...state,
      updatedAt,
      requests: state.requests.map((record) =>
        record.interactionId === replacement.interactionId
          ? replacement
          : record,
      ),
    })
  }

  private async requireState(): Promise<McpApprovalStateV1> {
    const state = await this.readState()
    if (!state) throw new McpApprovalError('not_found')
    return state
  }

  private emptyState(updatedAt: string): McpApprovalStateV1 {
    return {
      version: MCP_APPROVAL_STATE_VERSION,
      assignment: { ...this.assignment },
      updatedAt,
      requests: [],
    }
  }

  private async runLocked<T>(
    createStorage: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      await this.assertCanonicalAssignment()
      if (createStorage) await this.ensureStorageDirectories()
      const canonicalLockPath = path.join(
        await fs.realpath(this.location.assignmentPath),
        'mcp',
        'approvals',
        APPROVAL_STATE_FILE,
      )
      return await withFileMutationLock(canonicalLockPath, async () => {
        await this.assertCanonicalAssignment()
        if (createStorage) await this.ensureStorageDirectories()
        return operation()
      })
    } catch (error) {
      if (error instanceof McpApprovalError) throw error
      throw new McpApprovalError('storage_invalid')
    }
  }

  private async readState(): Promise<McpApprovalStateV1 | null> {
    if (!(await this.assertOptionalDirectory(this.mcpDirectory, ['mcp']))) {
      return null
    }
    if (
      !(await this.assertOptionalDirectory(this.approvalDirectory, [
        'mcp',
        'approvals',
      ]))
    ) {
      return null
    }

    let stat
    try {
      stat = await fs.lstat(this.statePath)
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw error
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_STATE_FILE_BYTES ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
    ) {
      throw new McpApprovalError('storage_invalid')
    }
    await this.assertExactRealPath(this.statePath, [
      'mcp',
      'approvals',
      APPROVAL_STATE_FILE,
    ])

    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8'))
    } catch {
      throw new McpApprovalError('storage_invalid')
    }
    return parseState(parsed, this.assignment, this.maxRecords)
  }

  private async writeState(state: McpApprovalStateV1): Promise<void> {
    await this.ensureStorageDirectories()
    await writeFileAtomic(
      this.statePath,
      `${JSON.stringify({
        ...state,
        requests: sortRecords(state.requests),
      }, null, 2)}\n`,
    )
  }

  private async assertCanonicalAssignment(): Promise<void> {
    let workspaceStat
    let assignmentStat
    try {
      workspaceStat = await fs.stat(this.workspacePath)
      assignmentStat = await fs.lstat(this.location.assignmentPath)
    } catch {
      throw new McpApprovalError('storage_invalid')
    }
    if (
      !workspaceStat.isDirectory() ||
      !assignmentStat.isDirectory() ||
      assignmentStat.isSymbolicLink()
    ) {
      throw new McpApprovalError('storage_invalid')
    }
    const workspaceRealPath = await fs.realpath(this.workspacePath)
    const assignmentRealPath = await fs.realpath(this.location.assignmentPath)
    const expectedAssignmentRealPath = path.resolve(
      workspaceRealPath,
      ...this.location.relativeAssignmentPath.split('/'),
    )
    if (assignmentRealPath !== expectedAssignmentRealPath) {
      throw new McpApprovalError('storage_invalid')
    }
  }

  private async ensureStorageDirectories(): Promise<void> {
    await this.ensurePrivateDirectory(this.mcpDirectory, ['mcp'])
    await this.ensurePrivateDirectory(this.approvalDirectory, [
      'mcp',
      'approvals',
    ])
  }

  private async ensurePrivateDirectory(
    directoryPath: string,
    relativeSegments: readonly string[],
  ): Promise<void> {
    try {
      await fs.mkdir(directoryPath, { mode: 0o700 })
    } catch (error) {
      if (!isExistingPathError(error)) throw error
    }
    const stat = await fs.lstat(directoryPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new McpApprovalError('storage_invalid')
    }
    await this.assertExactRealPath(directoryPath, relativeSegments)
    await fs.chmod(directoryPath, 0o700)
    if (
      process.platform !== 'win32' &&
      ((await fs.lstat(directoryPath)).mode & 0o777) !== 0o700
    ) {
      throw new McpApprovalError('storage_invalid')
    }
  }

  private async assertOptionalDirectory(
    directoryPath: string,
    relativeSegments: readonly string[],
  ): Promise<boolean> {
    let stat
    try {
      stat = await fs.lstat(directoryPath)
    } catch (error) {
      if (isMissingPathError(error)) return false
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new McpApprovalError('storage_invalid')
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
      throw new McpApprovalError('storage_invalid')
    }
    await this.assertExactRealPath(directoryPath, relativeSegments)
    return true
  }

  private async assertExactRealPath(
    candidatePath: string,
    relativeSegments: readonly string[],
  ): Promise<void> {
    const assignmentRealPath = await fs.realpath(this.location.assignmentPath)
    const candidateRealPath = await fs.realpath(candidatePath)
    const expectedRealPath = path.resolve(
      assignmentRealPath,
      ...relativeSegments,
    )
    if (candidateRealPath !== expectedRealPath) {
      throw new McpApprovalError('storage_invalid')
    }
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isFinite(value)) throw new McpApprovalError('invalid_request')
    return Math.floor(value)
  }

  private hasStoreScope(scope: McpApprovalAssignmentScope): boolean {
    return (
      scope.sessionId === this.assignment.sessionId &&
      scope.runId === this.assignment.runId &&
      scope.assignmentId === this.assignment.assignmentId
    )
  }

  private requireStoreScope(
    scope: McpApprovalAssignmentScope,
    code: 'not_found' | 'binding_mismatch',
  ): void {
    if (!this.hasStoreScope(scope)) throw new McpApprovalError(code)
  }
}

function normalizeRequestInput(
  input: McpApprovalRequestInput,
): Omit<McpApprovalRequestInput, 'arguments' | 'ttlMs'> {
  return {
    interactionId: requireIdentifier(input.interactionId),
    ...normalizeExactScope(input),
    toolCallId: requireIdentifier(input.toolCallId),
  }
}

function redactMcpApproval(record: McpApprovalRecord): McpApprovalView {
  return {
    interactionId: record.interactionId,
    kind: 'approval',
    sessionId: record.sessionId,
    runId: record.runId,
    assignmentId: record.assignmentId,
    agentPath: record.agentPath,
    serverId: record.serverId,
    namespacedToolName: record.namespacedToolName,
    toolCallId: record.toolCallId,
    toolRisk: record.toolRisk,
    argumentNames: [...record.argumentNames],
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.approvalScope
      ? { approvalScope: record.approvalScope }
      : {}),
  }
}

function normalizeResponseInput(
  input: McpApprovalResponseInput,
): McpApprovalResponseInput {
  const exact = normalizeExactBinding(input)
  const interactionId = requireIdentifier(input.interactionId)
  const responseId = requireIdentifier(input.responseId)
  if (input.decision === 'approve') {
    if (input.scope !== 'once' && input.scope !== 'run') {
      throw new McpApprovalError('invalid_request')
    }
    return {
      ...exact,
      interactionId,
      responseId,
      decision: 'approve',
      scope: input.scope,
    }
  }
  if (
    input.decision !== 'deny' ||
    ('scope' in input && input.scope !== undefined)
  ) {
    throw new McpApprovalError('invalid_request')
  }
  return { ...exact, interactionId, responseId, decision: 'deny' }
}

function normalizeCancelInput(
  input: McpApprovalCancelInput,
): McpApprovalCancelInput {
  return {
    ...normalizeExactBinding(input),
    interactionId: requireIdentifier(input.interactionId),
  }
}

function normalizeRunApprovalQuery(
  input: McpReusableRunApprovalQuery,
): McpReusableRunApprovalQuery {
  return normalizeExactScope(input)
}

function normalizeExactBinding(
  input: McpApprovalExactBinding,
): McpApprovalExactBinding {
  if (!isMcpApprovalArgumentsHash(input.argumentsHash)) {
    throw new McpApprovalError('invalid_request')
  }
  return {
    ...normalizeExactScope(input),
    toolCallId: requireIdentifier(input.toolCallId),
    argumentsHash: { ...input.argumentsHash },
  }
}

function normalizeExactScope<T extends {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly agentPath: string
  readonly serverId: string
  readonly namespacedToolName: string
  readonly toolRisk: McpToolRisk
}>(input: T): Pick<
  T,
  | 'sessionId'
  | 'runId'
  | 'assignmentId'
  | 'agentPath'
  | 'serverId'
  | 'namespacedToolName'
  | 'toolRisk'
> {
  if (
    typeof input.agentPath !== 'string' ||
    typeof input.namespacedToolName !== 'string'
  ) {
    throw new McpApprovalError('invalid_request')
  }
  const agentPath = normalizeMcpAgentPath(input.agentPath)
  if (
    !agentPath ||
    !isMcpApprovalToolRisk(input.toolRisk) ||
    !input.namespacedToolName.startsWith('mcp__')
  ) {
    throw new McpApprovalError('invalid_request')
  }
  return {
    sessionId: requireIdentifier(input.sessionId),
    runId: requireIdentifier(input.runId),
    assignmentId: requireIdentifier(input.assignmentId),
    agentPath,
    serverId: requireIdentifier(input.serverId),
    namespacedToolName: requireIdentifier(input.namespacedToolName),
    toolRisk: input.toolRisk,
  }
}

function hasExactRequestBinding(
  record: McpApprovalRecord,
  input: Omit<McpApprovalRequestInput, 'arguments' | 'ttlMs'>,
  argumentsHash: McpApprovalExactBinding['argumentsHash'],
): boolean {
  return (
    record.sessionId === input.sessionId &&
    record.runId === input.runId &&
    record.assignmentId === input.assignmentId &&
    record.agentPath === input.agentPath &&
    record.serverId === input.serverId &&
    record.namespacedToolName === input.namespacedToolName &&
    record.toolCallId === input.toolCallId &&
    record.toolRisk === input.toolRisk &&
    sameHash(record.argumentsHash, argumentsHash)
  )
}

function requireExactBinding(
  record: McpApprovalRecord,
  input: McpApprovalExactBinding,
): void {
  if (
    record.sessionId !== input.sessionId ||
    record.runId !== input.runId ||
    record.assignmentId !== input.assignmentId ||
    record.agentPath !== input.agentPath ||
    record.serverId !== input.serverId ||
    record.namespacedToolName !== input.namespacedToolName ||
    record.toolCallId !== input.toolCallId ||
    record.toolRisk !== input.toolRisk ||
    !sameHash(record.argumentsHash, input.argumentsHash)
  ) {
    throw new McpApprovalError('binding_mismatch')
  }
}

function isExactResponseReplay(
  record: McpApprovalRecord,
  response: McpApprovalResponseInput,
): boolean {
  if (record.responseId !== response.responseId) return false
  if (response.decision === 'deny') {
    return record.status === 'denied' && record.decision === 'deny'
  }
  return (
    record.decision === 'approve' &&
    record.approvalScope === response.scope &&
    record.status ===
      (response.scope === 'run' ? 'approved-run' : 'approved-once')
  )
}

function requireRecord(
  state: McpApprovalStateV1,
  interactionId: string,
): McpApprovalRecord {
  const record = state.requests.find(
    (candidate) => candidate.interactionId === interactionId,
  )
  if (!record) throw new McpApprovalError('not_found')
  return record
}

function parseState(
  value: unknown,
  expectedAssignment: McpApprovalAssignmentScope,
  maxRecords: number,
): McpApprovalStateV1 {
  const state = asPlainRecord(value)
  if (
    !state ||
    !hasExactKeys(state, ['version', 'assignment', 'updatedAt', 'requests']) ||
    state.version !== MCP_APPROVAL_STATE_VERSION ||
    !isTimestamp(state.updatedAt) ||
    !Array.isArray(state.requests) ||
    state.requests.length > maxRecords
  ) {
    throw new McpApprovalError('storage_invalid')
  }
  const assignment = asPlainRecord(state.assignment)
  if (
    !assignment ||
    !hasExactKeys(assignment, ['sessionId', 'runId', 'assignmentId']) ||
    assignment.sessionId !== expectedAssignment.sessionId ||
    assignment.runId !== expectedAssignment.runId ||
    assignment.assignmentId !== expectedAssignment.assignmentId
  ) {
    throw new McpApprovalError('storage_invalid')
  }

  const requests = state.requests.map((record) =>
    parseRecord(record, expectedAssignment),
  )
  const interactionIds = new Set(requests.map((record) => record.interactionId))
  if (interactionIds.size !== requests.length) {
    throw new McpApprovalError('storage_invalid')
  }
  return {
    version: MCP_APPROVAL_STATE_VERSION,
    assignment: { ...expectedAssignment },
    updatedAt: state.updatedAt,
    requests: sortRecords(requests),
  }
}

function parseRecord(
  value: unknown,
  assignment: McpApprovalAssignmentScope,
): McpApprovalRecord {
  const record = asPlainRecord(value)
  const allowedKeys = [
    'interactionId',
    'sessionId',
    'runId',
    'assignmentId',
    'agentPath',
    'serverId',
    'namespacedToolName',
    'toolCallId',
    'toolRisk',
    'argumentNames',
    'argumentsHash',
    'status',
    'createdAt',
    'expiresAt',
    'resolvedAt',
    'responseId',
    'decision',
    'approvalScope',
  ]
  if (
    !record ||
    !hasOnlyKeys(record, allowedKeys) ||
    !hasRequiredKeys(record, [
      'interactionId',
      'sessionId',
      'runId',
      'assignmentId',
      'agentPath',
      'serverId',
      'namespacedToolName',
      'toolCallId',
      'toolRisk',
      'argumentNames',
      'argumentsHash',
      'status',
      'createdAt',
      'expiresAt',
    ]) ||
    record.sessionId !== assignment.sessionId ||
    record.runId !== assignment.runId ||
    record.assignmentId !== assignment.assignmentId ||
    !isIdentifier(record.interactionId) ||
    !isIdentifier(record.serverId) ||
    !isIdentifier(record.toolCallId) ||
    !isIdentifier(record.namespacedToolName) ||
    !(record.namespacedToolName as string).startsWith('mcp__') ||
    typeof record.agentPath !== 'string' ||
    normalizeMcpAgentPath(record.agentPath) !== record.agentPath ||
    !isMcpApprovalToolRisk(record.toolRisk) ||
    !isMcpApprovalStatus(record.status) ||
    !isMcpApprovalArgumentsHash(record.argumentsHash) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
    !isArgumentNameList(record.argumentNames) ||
    !hasValidTerminalShape(record)
  ) {
    throw new McpApprovalError('storage_invalid')
  }

  return {
    interactionId: record.interactionId as string,
    sessionId: assignment.sessionId,
    runId: assignment.runId,
    assignmentId: assignment.assignmentId,
    agentPath: record.agentPath,
    serverId: record.serverId as string,
    namespacedToolName: record.namespacedToolName as string,
    toolCallId: record.toolCallId as string,
    toolRisk: record.toolRisk,
    argumentNames: [...record.argumentNames],
    argumentsHash: { ...record.argumentsHash },
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(typeof record.resolvedAt === 'string'
      ? { resolvedAt: record.resolvedAt }
      : {}),
    ...(typeof record.responseId === 'string'
      ? { responseId: record.responseId }
      : {}),
    ...(record.decision === 'approve' || record.decision === 'deny'
      ? { decision: record.decision }
      : {}),
    ...(record.approvalScope === 'once' || record.approvalScope === 'run'
      ? { approvalScope: record.approvalScope }
      : {}),
  }
}

function hasValidTerminalShape(record: Record<string, unknown>): boolean {
  if (record.status === 'pending') {
    return (
      record.resolvedAt === undefined &&
      record.responseId === undefined &&
      record.decision === undefined &&
      record.approvalScope === undefined
    )
  }
  if (
    !isTimestamp(record.resolvedAt) ||
    Date.parse(record.resolvedAt) < Date.parse(record.createdAt as string)
  ) {
    return false
  }
  if (
    (record.status === 'approved-once' ||
      record.status === 'approved-run' ||
      record.status === 'denied' ||
      record.status === 'cancelled') &&
    Date.parse(record.resolvedAt) >= Date.parse(record.expiresAt as string)
  ) {
    return false
  }
  if (record.status === 'approved-once' || record.status === 'approved-run') {
    return (
      isIdentifier(record.responseId) &&
      record.decision === 'approve' &&
      record.approvalScope ===
        (record.status === 'approved-run' ? 'run' : 'once')
    )
  }
  if (record.status === 'denied') {
    return (
      isIdentifier(record.responseId) &&
      record.decision === 'deny' &&
      record.approvalScope === undefined
    )
  }
  return (
    record.responseId === undefined &&
    record.decision === undefined &&
    record.approvalScope === undefined
  )
}

function isArgumentNameList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  if (
    value.some(
      (name) =>
        typeof name !== 'string' ||
        name.length === 0 ||
        name.length > MAX_IDENTIFIER_LENGTH ||
        /[\0-\x1f\x7f]/.test(name) ||
        name === '__proto__' ||
        name === 'constructor' ||
        name === 'prototype',
    )
  ) {
    return false
  }
  return value.every((name, index) => index === 0 || value[index - 1] < name)
}

function sortRecords(
  records: readonly McpApprovalRecord[],
): readonly McpApprovalRecord[] {
  return [...records].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.interactionId.localeCompare(right.interactionId),
  )
}

function compareMostRecentlyResolved(
  left: McpApprovalRecord,
  right: McpApprovalRecord,
): number {
  return (
    (right.resolvedAt ?? '').localeCompare(left.resolvedAt ?? '') ||
    right.interactionId.localeCompare(left.interactionId)
  )
}

function sameHash(
  left: McpApprovalExactBinding['argumentsHash'],
  right: McpApprovalExactBinding['argumentsHash'],
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value
}

function requireIdentifier(value: unknown): string {
  if (!isIdentifier(value)) throw new McpApprovalError('invalid_request')
  return value
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\0-\x1f\x7f]/.test(value)
  )
}

function boundedTtl(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0 || value > MAX_APPROVAL_TTL_MS) {
    throw new McpApprovalError('invalid_request')
  }
  const normalized = Math.floor(value)
  if (normalized < 1) throw new McpApprovalError('invalid_request')
  return normalized
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new McpApprovalError('invalid_request')
  }
  const normalized = Math.floor(value)
  if (normalized < 1) throw new McpApprovalError('invalid_request')
  return normalized
}

function toTimestamp(timeMs: number): string {
  try {
    return new Date(timeMs).toISOString()
  } catch {
    throw new McpApprovalError('invalid_request')
  }
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return hasOnlyKeys(value, expected) && hasRequiredKeys(value, expected)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed)
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowedSet.has(key),
  )
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isExistingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}
