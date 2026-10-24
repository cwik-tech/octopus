import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { withFileMutationLock, writeFileAtomic } from '../../core/file-mutation.js'
import {
  MCP_ELICITATION_STATE_VERSION,
  McpElicitationError,
  hashMcpElicitationFormValues,
  isMcpElicitationAction,
  isMcpElicitationIdentifier,
  isMcpElicitationStatus,
  isMcpElicitationValuesHash,
  normalizeMcpElicitationFormSchema,
  normalizeMcpElicitationIdentifier,
  normalizeMcpElicitationMessage,
  normalizeMcpElicitationUrl,
  type McpElicitationAction,
  type McpElicitationAssignmentScope,
  type McpElicitationExactBinding,
  type McpElicitationFormSchema,
  type McpElicitationFormValues,
  type McpElicitationRequestInput,
  type McpElicitationResponseInput,
  type McpElicitationResponseResult,
  type McpElicitationStatus,
  type McpElicitationValuesHash,
  type McpElicitationView,
} from './mcp-elicitation.js'
import { normalizeMcpAgentPath } from './mcp-settings.js'
import {
  buildSessionRunAssignmentLocation,
  type SessionRunAssignmentLocation,
} from '../run/run-location.js'

const DEFAULT_ELICITATION_TTL_MS = 5 * 60 * 1_000
const MAX_ELICITATION_TTL_MS = 60 * 60 * 1_000
const DEFAULT_MAX_RECORDS = 1_024
const MAX_STATE_FILE_BYTES = 8 * 1_024 * 1_024
const MAX_TERMINAL_RECORD_GROWTH_BYTES = 1_024
const ELICITATION_STATE_FILE = 'state.json'

interface McpElicitationStateV1 {
  readonly version: typeof MCP_ELICITATION_STATE_VERSION
  readonly assignment: McpElicitationAssignmentScope
  readonly updatedAt: string
  readonly requests: readonly McpElicitationRecord[]
}

interface McpElicitationRecordBase extends McpElicitationExactBinding {
  readonly message: string
  readonly status: McpElicitationStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly resolvedAt?: string
  readonly responseId?: string
  readonly action?: McpElicitationAction
}

interface McpElicitationFormRecord extends McpElicitationRecordBase {
  readonly mode: 'form'
  readonly schema: McpElicitationFormSchema
  /** Digest only; accepted values are never retained. */
  readonly valuesHash?: McpElicitationValuesHash
}

interface McpElicitationUrlRecord extends McpElicitationRecordBase {
  readonly mode: 'url'
  readonly url: string
  readonly elicitationId: string
}

type McpElicitationRecord =
  | McpElicitationFormRecord
  | McpElicitationUrlRecord

interface NormalizedRequestBase extends McpElicitationExactBinding {
  readonly message: string
  readonly ttlMs: number
}

type NormalizedRequest =
  | (NormalizedRequestBase & {
      readonly mode: 'form'
      readonly schema: McpElicitationFormSchema
    })
  | (NormalizedRequestBase & {
      readonly mode: 'url'
      readonly url: string
      readonly elicitationId: string
    })

type NormalizedResponse =
  | (McpElicitationExactBinding & {
      readonly responseId: string
      readonly mode: 'form'
      readonly action: 'accept'
      readonly values: unknown
    })
  | (McpElicitationExactBinding & {
      readonly responseId: string
      readonly mode: 'form'
      readonly action: 'decline' | 'cancel'
    })
  | (McpElicitationExactBinding & {
      readonly responseId: string
      readonly mode: 'url'
      readonly elicitationId: string
      readonly action: McpElicitationAction
    })

export interface McpElicitationStoreOptions
  extends McpElicitationAssignmentScope {
  readonly workspacePath: string
  readonly now?: () => number
  readonly defaultTtlMs?: number
  readonly maxRecords?: number
}

/** Parent-process owner for one canonical assignment elicitation state file. */
export class McpElicitationStore {
  private readonly workspacePath: string
  private readonly location: SessionRunAssignmentLocation
  private readonly assignment: McpElicitationAssignmentScope
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly maxRecords: number
  private readonly mcpDirectory: string
  private readonly elicitationDirectory: string
  private readonly statePath: string

  constructor(options: McpElicitationStoreOptions) {
    const workspacePath = path.resolve(options.workspacePath)
    const location = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: options.sessionId,
      runId: options.runId,
      assignmentId: options.assignmentId,
    })
    if (!location) throw new McpElicitationError('invalid_request')
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
      DEFAULT_ELICITATION_TTL_MS,
    )
    this.maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS)
    this.mcpDirectory = path.join(location.assignmentPath, 'mcp')
    this.elicitationDirectory = path.join(
      this.mcpDirectory,
      'elicitations',
    )
    this.statePath = path.join(
      this.elicitationDirectory,
      ELICITATION_STATE_FILE,
    )
  }

  async createRequest(
    input: McpElicitationRequestInput,
  ): Promise<McpElicitationView> {
    const normalized = normalizeRequestInput(input, this.defaultTtlMs)
    this.requireStoreScope(normalized, 'binding_mismatch')

    return this.runLocked(true, async () => {
      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      const state = (await this.readState()) ?? this.emptyState(now)
      const duplicate = state.requests.find(
        (record) => record.interactionId === normalized.interactionId,
      )
      if (duplicate) {
        if (hasExactRequestBinding(duplicate, normalized)) {
          return redactMcpElicitation(duplicate)
        }
        throw new McpElicitationError('binding_mismatch')
      }
      if (state.requests.length >= this.maxRecords) {
        throw new McpElicitationError('capacity_exceeded')
      }

      const base = {
        interactionId: normalized.interactionId,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
        assignmentId: normalized.assignmentId,
        agentPath: normalized.agentPath,
        serverId: normalized.serverId,
        parentRequestId: normalized.parentRequestId,
        toolCallId: normalized.toolCallId,
        namespacedToolName: normalized.namespacedToolName,
        message: normalized.message,
        status: 'pending' as const,
        createdAt: now,
        expiresAt: toTimestamp(nowMs + normalized.ttlMs),
      }
      const record: McpElicitationRecord = normalized.mode === 'form'
        ? {
            ...base,
            mode: 'form',
            schema: normalized.schema,
          }
        : {
            ...base,
            mode: 'url',
            url: normalized.url,
            elicitationId: normalized.elicitationId,
          }
      await this.writeState({
        ...state,
        updatedAt: now,
        requests: sortRecords([...state.requests, record]),
      })
      return redactMcpElicitation(record)
    })
  }

  async get(interactionId: string): Promise<McpElicitationView | null> {
    const normalizedId = normalizeMcpElicitationIdentifier(interactionId)
    return this.runLocked(false, async () => {
      const state = await this.readState()
      const record = state?.requests.find(
        (candidate) => candidate.interactionId === normalizedId,
      )
      return record ? redactMcpElicitation(record) : null
    })
  }

  async list(): Promise<readonly McpElicitationView[]> {
    return this.runLocked(false, async () => {
      const state = await this.readState()
      return (state?.requests ?? []).map(redactMcpElicitation)
    })
  }

  async respond(
    input: McpElicitationResponseInput,
  ): Promise<McpElicitationResponseResult> {
    const normalized = normalizeResponseInput(input)
    this.requireStoreScope(normalized, 'not_found')
    return this.runLocked(false, async () => {
      const state = await this.requireState()
      const record = requireRecord(state, normalized.interactionId)
      requireExactBinding(record, normalized)
      requireResponseModeBinding(record, normalized)

      let ephemeralValues: McpElicitationFormValues | undefined
      let valuesHash: McpElicitationValuesHash | undefined
      if (
        record.mode === 'form' &&
        normalized.mode === 'form' &&
        normalized.action === 'accept'
      ) {
        const summary = hashMcpElicitationFormValues(
          record.schema,
          normalized.values,
        )
        ephemeralValues = summary.values
        valuesHash = summary.valuesHash
      }

      if (record.status !== 'pending') {
        if (isExactResponseReplay(record, normalized, valuesHash)) {
          return responseResult(record, ephemeralValues)
        }
        if (record.status === 'expired') {
          throw new McpElicitationError('expired')
        }
        throw new McpElicitationError('already_resolved')
      }

      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      if (Date.parse(record.expiresAt) <= nowMs) {
        await this.replaceRecord(
          state,
          {
            ...record,
            status: 'expired',
            resolvedAt: now,
          },
          now,
        )
        throw new McpElicitationError('expired')
      }

      const common = {
        ...record,
        status: statusForAction(normalized.action),
        resolvedAt: now,
        responseId: normalized.responseId,
        action: normalized.action,
      }
      // valuesHash is set exactly when an accepted form response was hashed above.
      const resolved: McpElicitationRecord =
        record.mode === 'form' && valuesHash !== undefined
          ? {
              ...common,
              mode: 'form',
              schema: record.schema,
              valuesHash,
            }
          : common
      await this.replaceRecord(state, resolved, now)
      return responseResult(resolved, ephemeralValues)
    })
  }

  async expirePending(): Promise<readonly McpElicitationView[]> {
    return this.runLocked(false, async () => {
      const state = await this.readState()
      if (!state) return []
      const nowMs = this.currentTime()
      const now = toTimestamp(nowMs)
      const expired: McpElicitationRecord[] = []
      const requests = state.requests.map((record) => {
        if (
          record.status !== 'pending' ||
          Date.parse(record.expiresAt) > nowMs
        ) {
          return record
        }
        const updated: McpElicitationRecord = {
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
      return expired.map(redactMcpElicitation)
    })
  }

  /** Invoke exactly once when the owning parent runtime starts. */
  async recoverPendingAfterRestart(): Promise<readonly McpElicitationView[]> {
    return this.runLocked(false, async () => {
      const state = await this.readState()
      if (!state) return []
      const now = toTimestamp(this.currentTime())
      const interrupted: McpElicitationRecord[] = []
      const requests = state.requests.map((record) => {
        if (record.status !== 'pending') return record
        const updated: McpElicitationRecord = {
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
      return interrupted.map(redactMcpElicitation)
    })
  }

  private async replaceRecord(
    state: McpElicitationStateV1,
    replacement: McpElicitationRecord,
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

  private async requireState(): Promise<McpElicitationStateV1> {
    const state = await this.readState()
    if (!state) throw new McpElicitationError('not_found')
    return state
  }

  private emptyState(updatedAt: string): McpElicitationStateV1 {
    return {
      version: MCP_ELICITATION_STATE_VERSION,
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
        'elicitations',
        ELICITATION_STATE_FILE,
      )
      return await withFileMutationLock(canonicalLockPath, async () => {
        await this.assertCanonicalAssignment()
        if (createStorage) await this.ensureStorageDirectories()
        return operation()
      })
    } catch (error) {
      if (error instanceof McpElicitationError) throw error
      throw new McpElicitationError('storage_invalid')
    }
  }

  private async readState(): Promise<McpElicitationStateV1 | null> {
    if (!(await this.assertOptionalDirectory(this.mcpDirectory, ['mcp']))) {
      return null
    }
    if (
      !(await this.assertOptionalDirectory(this.elicitationDirectory, [
        'mcp',
        'elicitations',
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
      throw new McpElicitationError('storage_invalid')
    }
    await this.assertExactRealPath(this.statePath, [
      'mcp',
      'elicitations',
      ELICITATION_STATE_FILE,
    ])

    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8'))
    } catch {
      throw new McpElicitationError('storage_invalid')
    }
    return parseState(parsed, this.assignment, this.maxRecords)
  }

  private async writeState(state: McpElicitationStateV1): Promise<void> {
    await this.ensureStorageDirectories()
    const contents = `${JSON.stringify(
      { ...state, requests: sortRecords(state.requests) },
      null,
      2,
    )}\n`
    const pendingGrowthReserve =
      state.requests.filter((record) => record.status === 'pending').length *
      MAX_TERMINAL_RECORD_GROWTH_BYTES
    if (
      Buffer.byteLength(contents, 'utf8') + pendingGrowthReserve >
      MAX_STATE_FILE_BYTES
    ) {
      throw new McpElicitationError('capacity_exceeded')
    }
    await writeFileAtomic(
      this.statePath,
      contents,
    )
    const stat = await fs.lstat(this.statePath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
    ) {
      throw new McpElicitationError('storage_invalid')
    }
    await this.assertExactRealPath(this.statePath, [
      'mcp',
      'elicitations',
      ELICITATION_STATE_FILE,
    ])
  }

  private async assertCanonicalAssignment(): Promise<void> {
    let workspaceStat
    let assignmentStat
    try {
      workspaceStat = await fs.stat(this.workspacePath)
      assignmentStat = await fs.lstat(this.location.assignmentPath)
    } catch {
      throw new McpElicitationError('storage_invalid')
    }
    if (
      !workspaceStat.isDirectory() ||
      !assignmentStat.isDirectory() ||
      assignmentStat.isSymbolicLink()
    ) {
      throw new McpElicitationError('storage_invalid')
    }
    const workspaceRealPath = await fs.realpath(this.workspacePath)
    const assignmentRealPath = await fs.realpath(this.location.assignmentPath)
    const expectedAssignmentRealPath = path.resolve(
      workspaceRealPath,
      ...this.location.relativeAssignmentPath.split('/'),
    )
    if (assignmentRealPath !== expectedAssignmentRealPath) {
      throw new McpElicitationError('storage_invalid')
    }
  }

  private async ensureStorageDirectories(): Promise<void> {
    await this.ensurePrivateDirectory(this.mcpDirectory, ['mcp'])
    await this.ensurePrivateDirectory(this.elicitationDirectory, [
      'mcp',
      'elicitations',
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
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
    ) {
      throw new McpElicitationError('storage_invalid')
    }
    await this.assertExactRealPath(directoryPath, relativeSegments)
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
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
    ) {
      throw new McpElicitationError('storage_invalid')
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
      throw new McpElicitationError('storage_invalid')
    }
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isFinite(value)) {
      throw new McpElicitationError('invalid_request')
    }
    return Math.floor(value)
  }

  private hasStoreScope(scope: McpElicitationAssignmentScope): boolean {
    return (
      scope.sessionId === this.assignment.sessionId &&
      scope.runId === this.assignment.runId &&
      scope.assignmentId === this.assignment.assignmentId
    )
  }

  private requireStoreScope(
    scope: McpElicitationAssignmentScope,
    code: 'not_found' | 'binding_mismatch',
  ): void {
    if (!this.hasStoreScope(scope)) throw new McpElicitationError(code)
  }
}

function normalizeRequestInput(
  input: McpElicitationRequestInput,
  defaultTtlMs: number,
): NormalizedRequest {
  const exact = normalizeExactBinding(input)
  const message = normalizeMcpElicitationMessage(input.message)
  const ttlMs = boundedTtl(input.ttlMs, defaultTtlMs)
  if (input.mode === 'form') {
    return {
      ...exact,
      message,
      ttlMs,
      mode: 'form',
      schema: normalizeMcpElicitationFormSchema(input.schema),
    }
  }
  if (input.mode === 'url') {
    return {
      ...exact,
      message,
      ttlMs,
      mode: 'url',
      url: normalizeMcpElicitationUrl(input.url),
      elicitationId: normalizeMcpElicitationIdentifier(input.elicitationId),
    }
  }
  throw new McpElicitationError('invalid_request')
}

function normalizeResponseInput(
  input: McpElicitationResponseInput,
): NormalizedResponse {
  const exact = normalizeExactBinding(input)
  const responseId = normalizeMcpElicitationIdentifier(input.responseId)
  if (!isMcpElicitationAction(input.action)) {
    throw new McpElicitationError('invalid_request')
  }
  if (input.mode === 'form') {
    if (input.action === 'accept') {
      if (!hasOwn(input, 'values')) {
        throw new McpElicitationError('invalid_request')
      }
      return {
        ...exact,
        responseId,
        mode: 'form',
        action: 'accept',
        values: input.values,
      }
    }
    if (hasOwn(input, 'values')) {
      throw new McpElicitationError('invalid_request')
    }
    return {
      ...exact,
      responseId,
      mode: 'form',
      action: input.action,
    }
  }
  if (input.mode === 'url') {
    if (hasOwn(input, 'values')) {
      throw new McpElicitationError('invalid_request')
    }
    return {
      ...exact,
      responseId,
      mode: 'url',
      elicitationId: normalizeMcpElicitationIdentifier(input.elicitationId),
      action: input.action,
    }
  }
  throw new McpElicitationError('invalid_request')
}

function normalizeExactBinding(
  input: McpElicitationExactBinding,
): McpElicitationExactBinding {
  if (
    typeof input.agentPath !== 'string' ||
    typeof input.namespacedToolName !== 'string'
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const agentPath = normalizeMcpAgentPath(input.agentPath)
  if (!agentPath || !input.namespacedToolName.startsWith('mcp__')) {
    throw new McpElicitationError('invalid_request')
  }
  return {
    interactionId: normalizeMcpElicitationIdentifier(input.interactionId),
    sessionId: normalizeMcpElicitationIdentifier(input.sessionId),
    runId: normalizeMcpElicitationIdentifier(input.runId),
    assignmentId: normalizeMcpElicitationIdentifier(input.assignmentId),
    agentPath,
    serverId: normalizeMcpElicitationIdentifier(input.serverId),
    parentRequestId: normalizeMcpElicitationIdentifier(input.parentRequestId),
    toolCallId: normalizeMcpElicitationIdentifier(input.toolCallId),
    namespacedToolName: normalizeMcpElicitationIdentifier(
      input.namespacedToolName,
    ),
  }
}

function hasExactRequestBinding(
  record: McpElicitationRecord,
  input: NormalizedRequest,
): boolean {
  if (
    !sameExactBinding(record, input) ||
    record.message !== input.message ||
    Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== input.ttlMs ||
    record.mode !== input.mode
  ) {
    return false
  }
  if (record.mode === 'form' && input.mode === 'form') {
    return JSON.stringify(record.schema) === JSON.stringify(input.schema)
  }
  return (
    record.mode === 'url' &&
    input.mode === 'url' &&
    record.url === input.url &&
    record.elicitationId === input.elicitationId
  )
}

function requireExactBinding(
  record: McpElicitationRecord,
  input: McpElicitationExactBinding,
): void {
  if (!sameExactBinding(record, input)) {
    throw new McpElicitationError('binding_mismatch')
  }
}

function sameExactBinding(
  left: McpElicitationExactBinding,
  right: McpElicitationExactBinding,
): boolean {
  return (
    left.interactionId === right.interactionId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.assignmentId === right.assignmentId &&
    left.agentPath === right.agentPath &&
    left.serverId === right.serverId &&
    left.parentRequestId === right.parentRequestId &&
    left.toolCallId === right.toolCallId &&
    left.namespacedToolName === right.namespacedToolName
  )
}

function requireResponseModeBinding(
  record: McpElicitationRecord,
  response: NormalizedResponse,
): void {
  if (record.mode !== response.mode) {
    throw new McpElicitationError('binding_mismatch')
  }
  if (
    record.mode === 'url' &&
    response.mode === 'url' &&
    record.elicitationId !== response.elicitationId
  ) {
    throw new McpElicitationError('binding_mismatch')
  }
}

function isExactResponseReplay(
  record: McpElicitationRecord,
  response: NormalizedResponse,
  valuesHash: McpElicitationValuesHash | undefined,
): boolean {
  if (
    record.responseId !== response.responseId ||
    record.action !== response.action ||
    record.status !== statusForAction(response.action)
  ) {
    return false
  }
  if (
    record.mode === 'form' &&
    response.mode === 'form' &&
    response.action === 'accept'
  ) {
    return Boolean(
      record.valuesHash &&
        valuesHash &&
        sameValuesHash(record.valuesHash, valuesHash),
    )
  }
  return record.mode === response.mode
}

function responseResult(
  record: McpElicitationRecord,
  values: McpElicitationFormValues | undefined,
): McpElicitationResponseResult {
  const view = redactMcpElicitation(record)
  if (record.mode === 'form' && record.action === 'accept' && values) {
    return {
      view: view as Extract<McpElicitationView, { readonly mode: 'form' }>,
      values,
    }
  }
  return { view }
}

function redactMcpElicitation(
  record: McpElicitationRecord,
): McpElicitationView {
  const base = {
    interactionId: record.interactionId,
    kind: 'elicitation' as const,
    sessionId: record.sessionId,
    runId: record.runId,
    assignmentId: record.assignmentId,
    agentPath: record.agentPath,
    serverId: record.serverId,
    parentRequestId: record.parentRequestId,
    toolCallId: record.toolCallId,
    namespacedToolName: record.namespacedToolName,
    message: record.message,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    ...(record.action ? { action: record.action } : {}),
  }
  return record.mode === 'form'
    ? {
        ...base,
        mode: 'form',
        schema: cloneSchema(record.schema),
      }
    : {
        ...base,
        mode: 'url',
        url: record.url,
        elicitationId: record.elicitationId,
      }
}

function requireRecord(
  state: McpElicitationStateV1,
  interactionId: string,
): McpElicitationRecord {
  const record = state.requests.find(
    (candidate) => candidate.interactionId === interactionId,
  )
  if (!record) throw new McpElicitationError('not_found')
  return record
}

function parseState(
  value: unknown,
  expectedAssignment: McpElicitationAssignmentScope,
  maxRecords: number,
): McpElicitationStateV1 {
  try {
    const state = asPlainRecord(value)
    if (
      !state ||
      !hasExactKeys(state, ['version', 'assignment', 'updatedAt', 'requests']) ||
      state.version !== MCP_ELICITATION_STATE_VERSION ||
      !isTimestamp(state.updatedAt) ||
      !Array.isArray(state.requests) ||
      state.requests.length > maxRecords
    ) {
      throw new McpElicitationError('storage_invalid')
    }
    const assignment = asPlainRecord(state.assignment)
    if (
      !assignment ||
      !hasExactKeys(assignment, ['sessionId', 'runId', 'assignmentId']) ||
      assignment.sessionId !== expectedAssignment.sessionId ||
      assignment.runId !== expectedAssignment.runId ||
      assignment.assignmentId !== expectedAssignment.assignmentId
    ) {
      throw new McpElicitationError('storage_invalid')
    }

    const requests = state.requests.map((record) =>
      parseRecord(record, expectedAssignment),
    )
    const interactionIds = new Set(
      requests.map((record) => record.interactionId),
    )
    if (
      interactionIds.size !== requests.length ||
      requests.some(
        (record) =>
          Date.parse(state.updatedAt as string) <
          Date.parse(record.resolvedAt ?? record.createdAt),
      )
    ) {
      throw new McpElicitationError('storage_invalid')
    }
    return {
      version: MCP_ELICITATION_STATE_VERSION,
      assignment: { ...expectedAssignment },
      updatedAt: state.updatedAt,
      requests: sortRecords(requests),
    }
  } catch (error) {
    if (
      error instanceof McpElicitationError &&
      error.code === 'storage_invalid'
    ) {
      throw error
    }
    throw new McpElicitationError('storage_invalid')
  }
}

function parseRecord(
  value: unknown,
  assignment: McpElicitationAssignmentScope,
): McpElicitationRecord {
  const record = asPlainRecord(value)
  const commonKeys = [
    'interactionId',
    'sessionId',
    'runId',
    'assignmentId',
    'agentPath',
    'serverId',
    'parentRequestId',
    'toolCallId',
    'namespacedToolName',
    'message',
    'mode',
    'status',
    'createdAt',
    'expiresAt',
    'resolvedAt',
    'responseId',
    'action',
    'schema',
    'valuesHash',
    'url',
    'elicitationId',
  ]
  const requiredKeys = [
    'interactionId',
    'sessionId',
    'runId',
    'assignmentId',
    'agentPath',
    'serverId',
    'parentRequestId',
    'toolCallId',
    'namespacedToolName',
    'message',
    'mode',
    'status',
    'createdAt',
    'expiresAt',
  ]
  if (
    !record ||
    !hasOnlyKeys(record, commonKeys) ||
    !hasRequiredKeys(record, requiredKeys) ||
    record.sessionId !== assignment.sessionId ||
    record.runId !== assignment.runId ||
    record.assignmentId !== assignment.assignmentId ||
    !isMcpElicitationIdentifier(record.interactionId) ||
    !isMcpElicitationIdentifier(record.serverId) ||
    !isMcpElicitationIdentifier(record.parentRequestId) ||
    !isMcpElicitationIdentifier(record.toolCallId) ||
    !isMcpElicitationIdentifier(record.namespacedToolName) ||
    !(record.namespacedToolName as string).startsWith('mcp__') ||
    typeof record.agentPath !== 'string' ||
    normalizeMcpAgentPath(record.agentPath) !== record.agentPath ||
    typeof record.message !== 'string' ||
    normalizeMcpElicitationMessage(record.message) !== record.message ||
    !isMcpElicitationStatus(record.status) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.createdAt) ||
    !hasValidTerminalShape(record)
  ) {
    throw new McpElicitationError('storage_invalid')
  }

  const base = {
    interactionId: record.interactionId as string,
    sessionId: assignment.sessionId,
    runId: assignment.runId,
    assignmentId: assignment.assignmentId,
    agentPath: record.agentPath,
    serverId: record.serverId as string,
    parentRequestId: record.parentRequestId as string,
    toolCallId: record.toolCallId as string,
    namespacedToolName: record.namespacedToolName as string,
    message: record.message,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(typeof record.resolvedAt === 'string'
      ? { resolvedAt: record.resolvedAt }
      : {}),
    ...(typeof record.responseId === 'string'
      ? { responseId: record.responseId }
      : {}),
    ...(isMcpElicitationAction(record.action)
      ? { action: record.action }
      : {}),
  }
  if (record.mode === 'form') {
    if (
      !hasOwn(record, 'schema') ||
      hasOwn(record, 'url') ||
      hasOwn(record, 'elicitationId')
    ) {
      throw new McpElicitationError('storage_invalid')
    }
    const schema = normalizeMcpElicitationFormSchema(record.schema)
    if (JSON.stringify(schema) !== JSON.stringify(record.schema)) {
      throw new McpElicitationError('storage_invalid')
    }
    return {
      ...base,
      mode: 'form',
      schema,
      ...(isMcpElicitationValuesHash(record.valuesHash)
        ? { valuesHash: { ...record.valuesHash } }
        : {}),
    }
  }
  if (
    record.mode !== 'url' ||
    hasOwn(record, 'schema') ||
    hasOwn(record, 'valuesHash') ||
    typeof record.url !== 'string' ||
    normalizeMcpElicitationUrl(record.url) !== record.url ||
    !isMcpElicitationIdentifier(record.elicitationId)
  ) {
    throw new McpElicitationError('storage_invalid')
  }
  return {
    ...base,
    mode: 'url',
    url: record.url,
    elicitationId: record.elicitationId,
  }
}

function hasValidTerminalShape(record: Record<string, unknown>): boolean {
  if (record.status === 'pending') {
    return (
      record.resolvedAt === undefined &&
      record.responseId === undefined &&
      record.action === undefined &&
      record.valuesHash === undefined
    )
  }
  if (
    !isTimestamp(record.resolvedAt) ||
    Date.parse(record.resolvedAt) < Date.parse(record.createdAt as string)
  ) {
    return false
  }
  if (record.status === 'expired') {
    return (
      Date.parse(record.resolvedAt) >= Date.parse(record.expiresAt as string) &&
      record.responseId === undefined &&
      record.action === undefined &&
      record.valuesHash === undefined
    )
  }
  if (record.status === 'interrupted') {
    return (
      record.responseId === undefined &&
      record.action === undefined &&
      record.valuesHash === undefined
    )
  }
  if (
    Date.parse(record.resolvedAt) >= Date.parse(record.expiresAt as string) ||
    !isMcpElicitationIdentifier(record.responseId) ||
    !isMcpElicitationAction(record.action) ||
    record.status !== statusForAction(record.action)
  ) {
    return false
  }
  if (record.mode === 'form' && record.action === 'accept') {
    return isMcpElicitationValuesHash(record.valuesHash)
  }
  return record.valuesHash === undefined
}

function statusForAction(
  action: McpElicitationAction,
): 'accepted' | 'declined' | 'cancelled' {
  if (action === 'accept') return 'accepted'
  if (action === 'decline') return 'declined'
  return 'cancelled'
}

function sortRecords(
  records: readonly McpElicitationRecord[],
): readonly McpElicitationRecord[] {
  return [...records].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.interactionId.localeCompare(right.interactionId),
  )
}

function sameValuesHash(
  left: McpElicitationValuesHash,
  right: McpElicitationValuesHash,
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value
}

function cloneSchema(
  schema: McpElicitationFormSchema,
): McpElicitationFormSchema {
  return normalizeMcpElicitationFormSchema(
    JSON.parse(JSON.stringify(schema)) as unknown,
  )
}

function boundedTtl(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_ELICITATION_TTL_MS
  ) {
    throw new McpElicitationError('invalid_request')
  }
  const normalized = Math.floor(value)
  if (normalized < 1) throw new McpElicitationError('invalid_request')
  return normalized
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new McpElicitationError('invalid_request')
  }
  const normalized = Math.floor(value)
  if (normalized < 1) throw new McpElicitationError('invalid_request')
  return normalized
}

function toTimestamp(timeMs: number): string {
  try {
    return new Date(timeMs).toISOString()
  } catch {
    throw new McpElicitationError('invalid_request')
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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
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
  return required.every((key) => hasOwn(value, key))
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isExistingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}
