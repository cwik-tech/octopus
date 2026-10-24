import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  CanonicalJsonError,
  canonicalizeJson,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
} from '../contracts/canonical-json.js'
import {
  EXECUTION_JOURNAL_SCHEMA_VERSION,
  ExecutionJournalError,
  type ExecutionJournalActivityKind,
  type ExecutionJournalAppendInput,
  type ExecutionJournalAppendOutcome,
  type ExecutionJournalEvent,
  type ExecutionJournalManifest,
  type ExecutionJournalScanSummary,
  type ExecutionJournalScopeIdentity,
  type ExecutionJournalScopeKind,
} from '../contracts/execution-journal.js'
import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
  ProcessFileLockError,
  type AcquiredProcessFileLock,
  type CrossProcessFileLockRecord,
} from './cross-process-file-lock.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from './run-assignment-location.js'

export const EXECUTION_JOURNAL_DIRECTORY_NAME = 'execution-journal'
export const EXECUTION_JOURNAL_FILENAME = 'journal.jsonl'

const MANIFEST_FILENAME = 'manifest.json'
const JOURNAL_LOCK_FILENAME = 'journal.lock'
const PROJECTIONS_DIRECTORY_NAME = 'projections'
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
/**
 * How large one conversation activity may become.
 *
 * The reason chat gets a journal per turn rather than per session is that
 * opening one reads the file, revalidates every line and indexes every event —
 * and the accepted ADR forbids compacting the result. An activity that grew
 * without limit would put that cost back on every later turn, which is the
 * growth the whole layout exists to avoid.
 *
 * Enforced from the file's size rather than its contents. A bound checked after
 * the file is in memory is not a bound: the allocation it exists to prevent has
 * already happened by then.
 *
 * Conversation scopes only. Assignment and batch journals are bounded by a
 * run's shape, and quietly shrinking them to fit a chat rule would break work
 * that has nothing to do with chat.
 */
/**
 * The largest manifest this build will read.
 *
 * A manifest is a fixed set of short fields; anything approaching this is not
 * one. It is read on every operation of a live handle, so it is exactly the
 * kind of small, frequent read that must never become a large one because
 * somebody replaced the file.
 */
const MANIFEST_MAX_BYTES = 64 * 1024

/**
 * The manifest, bounded and never followed through a link.
 *
 * One place, because every read of it has the same three answers to give and
 * they are three different faults: gone, too large to be one, and not a plain
 * file at all.
 */
async function readManifestBounded(manifestPath: string): Promise<string> {
  const bounded = await readBoundedFileNoFollow(manifestPath, MANIFEST_MAX_BYTES)
  if (bounded.kind === 'missing') {
    // Not `manifest_conflict`: nothing has been shown to have changed. A
    // manifest that cannot be read right now is an environment fault, and
    // calling it an identity conflict would permanently poison a scope whose
    // journal is intact (ADR A-2).
    throw new ExecutionJournalError(
      'manifest_unavailable',
      'Execution journal manifest could not be read.',
    )
  }
  if (bounded.kind === 'not-a-file') {
    throw new ExecutionJournalError(
      'path_unsafe',
      'Execution journal manifest is not a regular file.',
    )
  }
  if (bounded.kind === 'over-bound') {
    throw limitExceeded(
      `Execution journal manifest is over its ${MANIFEST_MAX_BYTES}-byte bound.`,
    )
  }
  return bounded.text
}

export const CONVERSATION_JOURNAL_MAX_EVENTS = 128
export const CONVERSATION_JOURNAL_MAX_BYTES = 1024 * 1024

interface ScopeHardBounds {
  readonly maxEvents: number
  readonly maxBytes: number
}

/** The hard bounds for this scope kind, or nothing when it has none. */
function scopeHardBounds(
  scopeKind: ExecutionJournalScopeKind,
): ScopeHardBounds | undefined {
  return scopeKind === 'conversation'
    ? {
        maxEvents: CONVERSATION_JOURNAL_MAX_EVENTS,
        maxBytes: CONVERSATION_JOURNAL_MAX_BYTES,
      }
    : undefined
}

function limitExceeded(message: string): ExecutionJournalError {
  return new ExecutionJournalError('limit_exceeded', message)
}

const JOURNAL_IMPLEMENTATION_NAME = 'pipeline-execution-journal'
const JOURNAL_IMPLEMENTATION_VERSION = 1

export interface ExecutionJournalOpenOptions {
  readonly scopeRoot: string
  readonly identity: ExecutionJournalScopeIdentity
  readonly lockTimeoutMs?: number
  readonly clock?: { readonly now: () => number }
  /**
   * Cancels an open that is still waiting for the per-scope lock. Without it
   * a caller that gives up leaves initialization running in the background,
   * where it can still take the lock and provision a journal nobody owns.
   */
  readonly signal?: AbortSignal
  /**
   * Wraps the journal's write target so a test can induce a fault in the
   * commit itself — a short write, a write that throws `ENOSPC`, a failed
   * `fsync` (ADR A-2).
   *
   * Production never passes it, and the journal's identity checks are
   * deliberately outside it: the wrapper receives the already-validated
   * handle and may intercept only `write` and `sync`. `chmod` cannot express
   * these faults, and a fault injected any further out would exercise the
   * harness rather than the commit path.
   */
  readonly writeInterceptorForTest?: (
    target: JournalWriteTarget,
  ) => JournalWriteTarget
}

/** The journal's write target: the bytes, plus the durability barrier. */
export interface JournalWriteTarget extends JournalByteWriter {
  sync(): Promise<void>
}

/**
 * Does this fault mean the durable history is damaged, or only that this
 * handle is finished (ADR A-2)?
 *
 * Integrity faults describe the bytes on disk: a broken hash chain, a record
 * that does not validate, a file that shrank below its validated length, a
 * manifest whose identity changed, an unreadable lock record. They need
 * explicit repair, and a reopen would meet them again.
 *
 * Everything else describes the environment at one moment — ENOSPC, EIO, a
 * torn write, a failed `fsync`, relaxed permissions, a non-canonical path, a
 * manifest that could not be read, a lock someone else holds. The records
 * already on disk stay valid, so a fresh handle that rescans them is correct.
 *
 * Unknown errors are recoverable on purpose: declaring damage that was not
 * observed is the more expensive mistake, and the reopen re-validates
 * everything from disk before it appends anything.
 */
function isIntegrityFault(error: unknown): boolean {
  if (!(error instanceof ExecutionJournalError)) return false
  switch (error.code) {
    case 'corrupt':
    case 'manifest_conflict':
    case 'unsupported_version':
      return true
    default:
      return false
  }
}

export interface ExecutionJournalMetrics {
  readonly appendCount: number
  /** Lock cycles paid; below `appendCount` when appends group-commit. */
  readonly lockAcquisitionCount: number
  /** Durability barriers paid; one per committed batch. */
  readonly syncCount: number
  readonly alreadyAcceptedCount: number
  readonly revisionConflictCount: number
  readonly identityConflictCount: number
  readonly lockTimeoutCount: number
  /** Integrity faults only: damage that needs explicit repair (ADR A-2). */
  readonly corruptionCount: number
  /**
   * Handles retired by a recoverable fault. Kept apart from
   * `corruptionCount`, which used to count every `ENOSPC` and permission
   * fault too and so could not be used as an integrity alarm. Counted once
   * per handle, at the transition — later refusals are the same retirement.
   */
  readonly retiredHandleCount: number
  readonly appendLatencyMsTotal: number
  readonly syncLatencyMsTotal: number
  readonly lockWaitMsTotal: number
  readonly scanCount: number
  readonly scannedEventCount: number
  readonly truncatedFragmentBytesTotal: number
}

export interface ExecutionJournal {
  readonly manifest: ExecutionJournalManifest
  /** Canonical private journal directory (contains manifest/journal/lock). */
  readonly journalDirectoryPath: string
  append(
    input: ExecutionJournalAppendInput,
  ): Promise<ExecutionJournalAppendOutcome>
  scan(): Promise<ExecutionJournalScanSummary>
  /**
   * Read one stream's history in sequence order. Costs the stream rather than
   * the journal, so per-dispatch recovery does not grow with total history.
   */
  scanStream(
    streamKind: string,
    streamId: string,
  ): Promise<ExecutionJournalScanSummary>
  close(): Promise<void>
  getMetrics(): ExecutionJournalMetrics
  /**
   * True once a recoverable fault retired this handle (ADR A-2). The durable
   * history is intact, but this handle's in-memory index has advanced past
   * what reached disk, so its owner must drop it and open a fresh one.
   */
  isRetired(): boolean
}

/** Caller-owned append fields canonicalized into `appendRequestDigest`. */
export interface JournalAppendRequestFields {
  readonly eventId: string
  readonly streamKind: string
  readonly streamId: string
  readonly expectedStreamRevision: number
  readonly type: string
  readonly payloadSchemaVersion: number
  readonly payload: CanonicalJsonObject
  readonly correlationId: string
  readonly causationEventId?: string
  readonly sourceSequenceId?: string
  readonly sourceOrdinal?: number
  readonly executionAttemptId?: string
}

export interface JournalContentValidation {
  readonly events: readonly ExecutionJournalEvent[]
  readonly fragment: string | undefined
}

interface MutableJournalIndex {
  lastSequence: number
  lastEventHash: string
  streamRevisions: Map<string, number>
  eventSequences: Map<string, number>
}

interface JournalTailIndex extends MutableJournalIndex {
  byteLength: number
  eventsById: Map<string, ExecutionJournalEvent>
  /** Per-stream history in sequence order, so one stream reads in O(stream). */
  eventsByStream: Map<string, ExecutionJournalEvent[]>
}

interface PendingAppend {
  readonly input: ExecutionJournalAppendInput
  readonly resolve: (outcome: ExecutionJournalAppendOutcome) => void
  readonly reject: (error: unknown) => void
}

type PreparedBatchEntry =
  | { readonly kind: 'record'; readonly line: Buffer; readonly settle: () => void }
  | { readonly kind: 'settled'; readonly settle: () => void }

interface JournalPaths {
  readonly scopeRoot: string
  readonly runtimePath: string
  readonly journalDirectory: string
  readonly manifestPath: string
  readonly journalPath: string
  readonly lockPath: string
  readonly projectionsPath: string
}

// ---------------------------------------------------------------------------
// Pure envelope, digest, hashing, and validation rules
// ---------------------------------------------------------------------------

export function canonicalizeAppendRequest(
  fields: JournalAppendRequestFields,
): string {
  const record: Record<string, CanonicalJsonValue> = {
    eventId: fields.eventId,
    streamKind: fields.streamKind,
    streamId: fields.streamId,
    expectedStreamRevision: fields.expectedStreamRevision,
    type: fields.type,
    payloadSchemaVersion: fields.payloadSchemaVersion,
    payload: fields.payload,
    correlationId: fields.correlationId,
  }
  if (fields.causationEventId !== undefined) {
    record.causationEventId = fields.causationEventId
  }
  if (fields.sourceSequenceId !== undefined) {
    record.sourceSequenceId = fields.sourceSequenceId
  }
  if (fields.sourceOrdinal !== undefined) {
    record.sourceOrdinal = fields.sourceOrdinal
  }
  if (fields.executionAttemptId !== undefined) {
    record.executionAttemptId = fields.executionAttemptId
  }
  return canonicalizeJson(record)
}

export function computeAppendRequestDigest(
  fields: JournalAppendRequestFields,
): string {
  return sha256Hex(canonicalizeAppendRequest(fields))
}

export function recomputeAppendRequestDigest(
  event: ExecutionJournalEvent,
): string {
  return computeAppendRequestDigest(requestFieldsFromEvent(event))
}

export function recomputeEventHash(event: ExecutionJournalEvent): string {
  const { eventHash: _excluded, ...rest } = event
  return sha256Hex(canonicalizeJson(eventHashRecord(rest)))
}

export function computeGenesisEventHash(
  identity: ExecutionJournalScopeIdentity,
): string {
  const record: Record<string, CanonicalJsonValue> = {
    purpose: 'execution-journal-genesis',
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    scopeKind: identity.scopeKind,
    scopeId: identity.scopeId,
    tenantId: identity.tenantId,
    journalRelativePath: EXECUTION_JOURNAL_FILENAME,
    initialSequence: 0,
  }
  if (identity.ownerKind !== undefined) record.ownerKind = identity.ownerKind
  if (identity.sessionId !== undefined) record.sessionId = identity.sessionId
  if (identity.runId !== undefined) record.runId = identity.runId
  if (identity.assignmentId !== undefined) {
    record.assignmentId = identity.assignmentId
  }
  if (identity.conversationId !== undefined) {
    record.conversationId = identity.conversationId
  }
  if (identity.activityKind !== undefined) {
    record.activityKind = identity.activityKind
  }
  return sha256Hex(canonicalizeJson(record))
}

export function verifyStreamRevision(
  expectedRevision: number,
  actualRevision: number,
): boolean {
  return expectedRevision === actualRevision
}

export function classifyJournalTail(
  raw: string,
): 'empty' | 'terminated' | 'unterminated' {
  if (raw.length === 0) return 'empty'
  return raw.endsWith('\n') ? 'terminated' : 'unterminated'
}

const ENVELOPE_KEYS = [
  'schemaVersion',
  'eventId',
  'sequence',
  'recordedAt',
  'scopeKind',
  'scopeId',
  'tenantId',
  'sessionId',
  'runId',
  'assignmentId',
  'conversationId',
  'ownerKind',
  'activityKind',
  'streamKind',
  'streamId',
  'streamRevision',
  'type',
  'payloadSchemaVersion',
  'appendRequestDigest',
  'correlationId',
  'causationEventId',
  'sourceSequenceId',
  'sourceOrdinal',
  'executionAttemptId',
  'previousEventHash',
  'eventHash',
  'payload',
] as const

const ENVELOPE_KEY_SET: ReadonlySet<string> = new Set(ENVELOPE_KEYS)

const REQUIRED_ENVELOPE_KEYS: ReadonlySet<string> = new Set(
  ENVELOPE_KEYS.filter(
    (key) =>
      key !== 'sessionId' &&
      key !== 'runId' &&
      key !== 'assignmentId' &&
      key !== 'conversationId' &&
      key !== 'ownerKind' &&
      key !== 'activityKind' &&
      key !== 'causationEventId' &&
      key !== 'sourceSequenceId' &&
      key !== 'sourceOrdinal' &&
      key !== 'executionAttemptId',
  ),
)

export function parseJournalEnvelope(
  raw: unknown,
  manifest: ExecutionJournalManifest,
): ExecutionJournalEvent {
  if (!isPlainRecord(raw)) {
    throw corrupt('Journal record must be a JSON object.')
  }
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEY_SET.has(key)) {
      throw corrupt(`Journal record contains an unexpected field: ${key}`)
    }
  }
  for (const key of REQUIRED_ENVELOPE_KEYS) {
    if (!(key in raw)) {
      throw corrupt(`Journal record is missing field: ${key}`)
    }
  }
  if (raw.schemaVersion !== EXECUTION_JOURNAL_SCHEMA_VERSION) {
    throw new ExecutionJournalError(
      'unsupported_version',
      'Journal record schema version is not supported.',
    )
  }
  if (!isJournalIdentifier(raw.eventId)) {
    throw corrupt('Journal record event identity is invalid.')
  }
  if (!isPositiveInteger(raw.sequence)) {
    throw corrupt('Journal record sequence is invalid.')
  }
  if (!isIsoTimestamp(raw.recordedAt)) {
    throw corrupt('Journal record timestamp is invalid.')
  }
  if (raw.scopeKind !== manifest.scopeKind) {
    throw corrupt('Journal record scope kind does not match the manifest.')
  }
  if (raw.scopeId !== manifest.scopeId) {
    throw corrupt('Journal record scope identity does not match the manifest.')
  }
  if (raw.tenantId !== manifest.tenantId) {
    throw corrupt('Journal record tenant does not match the manifest.')
  }
  assertOptionalIdentityMatches(raw.ownerKind, manifest.ownerKind, 'owner kind')
  assertOptionalIdentityMatches(raw.sessionId, manifest.sessionId, 'session')
  assertOptionalIdentityMatches(raw.runId, manifest.runId, 'run')
  assertOptionalIdentityMatches(
    raw.assignmentId,
    manifest.assignmentId,
    'assignment',
  )
  assertOptionalIdentityMatches(
    raw.conversationId,
    manifest.conversationId,
    'conversation',
  )
  if (raw.activityKind !== manifest.activityKind) {
    throw corrupt('Journal record activity kind does not match the manifest.')
  }
  if (!isJournalIdentifier(raw.streamKind)) {
    throw corrupt('Journal record stream kind is invalid.')
  }
  if (!isJournalIdentifier(raw.streamId)) {
    throw corrupt('Journal record stream identity is invalid.')
  }
  if (!isPositiveInteger(raw.streamRevision)) {
    throw corrupt('Journal record stream revision is invalid.')
  }
  if (!isJournalIdentifier(raw.type)) {
    throw corrupt('Journal record type is invalid.')
  }
  if (!isPositiveInteger(raw.payloadSchemaVersion)) {
    throw corrupt('Journal record payload schema version is invalid.')
  }
  if (!isSha256Hex(raw.appendRequestDigest)) {
    throw corrupt('Journal record append request digest is invalid.')
  }
  if (!isJournalIdentifier(raw.correlationId)) {
    throw corrupt('Journal record correlation identity is invalid.')
  }
  if (
    raw.causationEventId !== undefined &&
    !isJournalIdentifier(raw.causationEventId)
  ) {
    throw corrupt('Journal record causation identity is invalid.')
  }
  let sourceSequenceId: string | undefined
  let sourceOrdinal: number | undefined
  if (raw.sourceSequenceId !== undefined || raw.sourceOrdinal !== undefined) {
    if (raw.sourceSequenceId === undefined || raw.sourceOrdinal === undefined) {
      throw corrupt(
        'Journal record source sequence and ordinal must be present together.',
      )
    }
    if (!isJournalIdentifier(raw.sourceSequenceId)) {
      throw corrupt('Journal record source sequence identity is invalid.')
    }
    if (!isNonNegativeInteger(raw.sourceOrdinal)) {
      throw corrupt('Journal record source ordinal is invalid.')
    }
    sourceSequenceId = raw.sourceSequenceId
    sourceOrdinal = raw.sourceOrdinal
  }
  if (
    raw.executionAttemptId !== undefined &&
    !isJournalIdentifier(raw.executionAttemptId)
  ) {
    throw corrupt('Journal record execution attempt identity is invalid.')
  }
  if (!isSha256Hex(raw.previousEventHash)) {
    throw corrupt('Journal record previous event hash is invalid.')
  }
  if (!isSha256Hex(raw.eventHash)) {
    throw corrupt('Journal record event hash is invalid.')
  }
  const payload = parseCanonicalPayload(raw.payload)

  return {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    eventId: raw.eventId,
    sequence: raw.sequence,
    recordedAt: raw.recordedAt,
    scopeKind: manifest.scopeKind,
    scopeId: manifest.scopeId,
    tenantId: manifest.tenantId,
    ...(manifest.sessionId === undefined ? {} : { sessionId: manifest.sessionId }),
    ...(manifest.runId === undefined ? {} : { runId: manifest.runId }),
    ...(manifest.assignmentId === undefined
      ? {}
      : { assignmentId: manifest.assignmentId }),
    ...(manifest.ownerKind === undefined ? {} : { ownerKind: manifest.ownerKind }),
    ...(manifest.conversationId === undefined
      ? {}
      : { conversationId: manifest.conversationId }),
    ...(manifest.activityKind === undefined
      ? {}
      : { activityKind: manifest.activityKind }),
    streamKind: raw.streamKind,
    streamId: raw.streamId,
    streamRevision: raw.streamRevision,
    type: raw.type,
    payloadSchemaVersion: raw.payloadSchemaVersion,
    appendRequestDigest: raw.appendRequestDigest,
    correlationId: raw.correlationId,
    ...(raw.causationEventId === undefined
      ? {}
      : { causationEventId: raw.causationEventId }),
    ...(sourceSequenceId === undefined ? {} : { sourceSequenceId }),
    ...(sourceOrdinal === undefined ? {} : { sourceOrdinal }),
    ...(raw.executionAttemptId === undefined
      ? {}
      : { executionAttemptId: raw.executionAttemptId }),
    previousEventHash: raw.previousEventHash,
    eventHash: raw.eventHash,
    payload,
  }
}

export function validateJournalContent(
  manifest: ExecutionJournalManifest,
  raw: string,
): JournalContentValidation {
  const tail = classifyJournalTail(raw)
  if (tail === 'empty') return { events: [], fragment: undefined }
  const lines = raw.split('\n')
  const fragment = tail === 'unterminated' ? lines[lines.length - 1] : undefined
  const terminatedLines = lines.slice(0, -1)
  const index = createMutableIndex(manifest)
  const events: ExecutionJournalEvent[] = []
  for (const line of terminatedLines) {
    events.push(validateJournalLine(manifest, index, line))
  }
  assertCausationOrder(events, index)
  return { events, fragment }
}

export function validateJournalLine(
  manifest: ExecutionJournalManifest,
  index: MutableJournalIndex,
  line: string,
): ExecutionJournalEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw corrupt('Journal record is not valid JSON.')
  }
  const event = parseJournalEnvelope(parsed, manifest)
  if (event.sequence !== index.lastSequence + 1) {
    throw corrupt('Journal sequence is not contiguous.')
  }
  const streamKey = streamKeyOf(event.streamKind, event.streamId)
  const expectedRevision = (index.streamRevisions.get(streamKey) ?? 0) + 1
  if (event.streamRevision !== expectedRevision) {
    throw corrupt('Journal stream revision is not contiguous.')
  }
  if (index.eventSequences.has(event.eventId)) {
    throw corrupt('Journal event identity is duplicated.')
  }
  if (event.previousEventHash !== index.lastEventHash) {
    throw corrupt('Journal hash chain is broken.')
  }
  if (recomputeEventHash(event) !== event.eventHash) {
    throw corrupt('Journal event hash does not match its record.')
  }
  if (recomputeAppendRequestDigest(event) !== event.appendRequestDigest) {
    throw corrupt('Journal append request digest does not match its record.')
  }
  if (event.causationEventId !== undefined) {
    if (event.causationEventId === event.eventId) {
      throw corrupt('Journal causation reference points at itself.')
    }
    const causeSequence = index.eventSequences.get(event.causationEventId)
    if (causeSequence !== undefined && causeSequence >= event.sequence) {
      throw corrupt('Journal causation reference is not ordered.')
    }
  }
  index.eventSequences.set(event.eventId, event.sequence)
  index.streamRevisions.set(streamKey, event.streamRevision)
  index.lastEventHash = event.eventHash
  index.lastSequence = event.sequence
  return event
}

// ---------------------------------------------------------------------------
// Journal initialization and filesystem handle
// ---------------------------------------------------------------------------

/**
 * Read a file through an opened handle, at most `maxBytes + 1`, refusing links.
 *
 * Core-local on purpose: the journal is the innermost layer and must not reach
 * outward into services for a primitive it depends on.
 *
 * The distinction it exists to make: measuring a file and then reading it are
 * two operations. Between them the file can grow, or the name can be pointed at
 * something else entirely — so a bound established by a `stat` is a bound on
 * what the file used to be, and reading "whatever is there now" against it does
 * not bound anything. One byte past the bound is read so that "at the bound"
 * and "over it" are distinguishable without pulling in the remainder.
 *
 * `undefined` when the file is absent, `'over-bound'` when it is larger than
 * the caller will accept.
 */
type BoundedRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'over-bound' }
  | { readonly kind: 'not-a-file' }

async function readBoundedFileNoFollow(
  filePath: string,
  maxBytes: number,
): Promise<BoundedRead> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return { kind: 'missing' }
    // `ELOOP` is the open refusing a link, which is the point of `O_NOFOLLOW`.
    if (hasNodeErrorCode(error, 'ELOOP')) return { kind: 'not-a-file' }
    throw error
  }
  try {
    const stat = await handle.stat()
    // Judged from the opened handle, so it describes the file actually being
    // read rather than whatever the name pointed at a moment ago.
    if (!stat.isFile()) return { kind: 'not-a-file' }
    if (stat.size > maxBytes) return { kind: 'over-bound' }
    // And the read is still bounded independently, because a single `read` may
    // return fewer bytes than asked for and the file can grow after the size
    // above was taken. Filling the extra byte is what says "over the bound"
    // without pulling in the remainder.
    const buffer = Buffer.alloc(maxBytes + 1)
    let filled = 0
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        filled,
      )
      if (bytesRead === 0) break
      filled += bytesRead
      if (filled > maxBytes) return { kind: 'over-bound' }
    }
    return { kind: 'ok', text: buffer.subarray(0, filled).toString('utf8') }
  } finally {
    await handle.close()
  }
}

export async function initializeExecutionJournal(
  options: ExecutionJournalOpenOptions,
): Promise<ExecutionJournal> {
  const clock = options.clock ?? { now: () => Date.now() }
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  if (
    typeof options.scopeRoot !== 'string' ||
    options.scopeRoot.length === 0 ||
    options.scopeRoot.includes('\0')
  ) {
    throw new ExecutionJournalError(
      'scope_invalid',
      'Journal scope root must be a non-empty path.',
    )
  }
  validateScopeIdentity(options.identity)

  const scopeRoot = path.resolve(options.scopeRoot)
  const canonicalScopeRoot = await validateOwnedDirectory(
    scopeRoot,
    'Journal scope root',
  )
  const runtimePath = path.join(scopeRoot, RUN_PRIVATE_RUNTIME_DIRECTORY_NAME)
  const canonicalRuntimePath = await ensurePrivateDirectory(
    runtimePath,
    path.join(canonicalScopeRoot, RUN_PRIVATE_RUNTIME_DIRECTORY_NAME),
    'Private runtime directory',
  )
  const journalDirectory = path.join(runtimePath, EXECUTION_JOURNAL_DIRECTORY_NAME)
  const canonicalJournalDirectory = await ensurePrivateDirectory(
    journalDirectory,
    path.join(canonicalRuntimePath, EXECUTION_JOURNAL_DIRECTORY_NAME),
    'Journal directory',
  )
  const paths: JournalPaths = {
    scopeRoot: canonicalScopeRoot,
    runtimePath: canonicalRuntimePath,
    journalDirectory: canonicalJournalDirectory,
    manifestPath: path.join(canonicalJournalDirectory, MANIFEST_FILENAME),
    journalPath: path.join(canonicalJournalDirectory, EXECUTION_JOURNAL_FILENAME),
    lockPath: path.join(canonicalJournalDirectory, JOURNAL_LOCK_FILENAME),
    projectionsPath: path.join(
      canonicalJournalDirectory,
      PROJECTIONS_DIRECTORY_NAME,
    ),
  }

  throwIfAborted(options.signal)
  const lock = await acquireJournalLock(
    paths.lockPath,
    lockTimeoutMs,
    options.signal,
  )
  try {
    throwIfAborted(options.signal)
    await ensurePrivateDirectory(
      paths.projectionsPath,
      path.join(canonicalJournalDirectory, PROJECTIONS_DIRECTORY_NAME),
      'Journal projections directory',
    )
    const { manifest, rawText } = await loadOrCreateManifest(
      paths,
      options.identity,
      clock,
    )
    await ensureJournalFile(paths)

    const scanStarted = clock.now()
    const bounds = scopeHardBounds(manifest.scopeKind)
    let journalRaw: string
    if (bounds) {
      // The bound is carried by the read itself. A `stat` followed by a
      // `readFile` bounds what the file was, not what is read: between the two
      // it can grow, or the name can be pointed somewhere else.
      const bounded = await readBoundedFileNoFollow(
        paths.journalPath,
        bounds.maxBytes,
      )
      if (bounded.kind === 'over-bound') {
        throw limitExceeded(
          `Conversation activity journal is over its ${bounds.maxBytes}-byte ` +
            'bound and was not read.',
        )
      }
      if (bounded.kind === 'not-a-file') {
        throw new ExecutionJournalError(
          'path_unsafe',
          'Execution journal file is not a regular file.',
        )
      }
      journalRaw = bounded.kind === 'missing' ? '' : bounded.text
    } else {
      journalRaw = await fs.readFile(paths.journalPath, 'utf8')
    }
    const validation = validateJournalContent(manifest, journalRaw)
    if (bounds && validation.events.length > bounds.maxEvents) {
      throw limitExceeded(
        `Conversation activity journal holds ${validation.events.length} events, ` +
          `over its ${bounds.maxEvents}-event bound.`,
      )
    }
    let truncatedFragmentBytes = 0
    if (validation.fragment !== undefined) {
      truncatedFragmentBytes = Buffer.byteLength(validation.fragment, 'utf8')
      const validatedBytes =
        Buffer.byteLength(journalRaw, 'utf8') - truncatedFragmentBytes
      await truncateJournalTo(paths.journalPath, validatedBytes)
    }
    const index = buildTailIndex(manifest, validation.events, validatedBytes(journalRaw, validation.fragment))
    const scanDurationMs = clock.now() - scanStarted

    return new FileSystemExecutionJournal({
      paths,
      manifest,
      manifestRawText: rawText,
      identity: options.identity,
      index,
      clock,
      lockTimeoutMs,
      ...(options.writeInterceptorForTest === undefined
        ? {}
        : { writeInterceptor: options.writeInterceptorForTest }),
      initialMetrics: {
        scanDurationMs,
        scannedEventCount: validation.events.length,
        truncatedFragmentBytes,
      },
    })
  } finally {
    await lock.release()
  }
}

export type ExecutionJournalReadResult =
  | {
      readonly kind: 'ok'
      readonly manifest: ExecutionJournalManifest
      readonly events: readonly ExecutionJournalEvent[]
      /**
       * True when the file ends mid-record.
       *
       * The events before it are valid and are returned, but the file is not
       * whole — a writer would truncate the fragment, and a reader must not.
       * Reported so a caller can tell "this is the journal" from "this is the
       * part of the journal that survived", which are different answers to give
       * an operator.
       */
      readonly truncatedTail: boolean
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'unsupported_version' }

export interface ExecutionJournalReadLimits {
  readonly maxBytes: number
  readonly maxEvents: number
}

/**
 * Read a journal without provisioning, locking, or writing anything.
 *
 * Inspection must be able to look at a journal it does not own — including one
 * abandoned by a dead process — so this never creates directories, never takes
 * the per-scope lock, and never truncates an unterminated tail. An incomplete
 * final record is simply not reported as an event.
 *
 * Optional limits require both nonnegative safe integers. They bound the read
 * through one opened handle, refuse a final journal symlink, and may tighten
 * but never raise the scope's hard bounds. Omitting them preserves the scope's
 * existing read behavior; assignment and batch journals have no hard bounds.
 */
export async function readExecutionJournal(
  scopeRoot: string,
  limits?: ExecutionJournalReadLimits,
): Promise<ExecutionJournalReadResult> {
  if (
    limits !== undefined &&
    (!Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 0 ||
      !Number.isSafeInteger(limits.maxEvents) ||
      limits.maxEvents < 0)
  ) {
    return { kind: 'corrupt', reason: 'read_limits_invalid' }
  }
  const journalDirectory = path.join(
    scopeRoot,
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
    EXECUTION_JOURNAL_DIRECTORY_NAME,
  )
  let manifestRaw: string
  try {
    // Bounded and no-follow before the scope kind is even known, because the
    // scope kind is inside this file: a manifest large enough to matter has to
    // be refused by the read that discovers what it is.
    const bounded = await readBoundedFileNoFollow(
      path.join(journalDirectory, MANIFEST_FILENAME),
      MANIFEST_MAX_BYTES,
    )
    if (bounded.kind === 'missing') return { kind: 'not_found' }
    if (bounded.kind !== 'ok') {
      return { kind: 'corrupt', reason: 'manifest_unreadable' }
    }
    manifestRaw = bounded.text
  } catch {
    return { kind: 'corrupt', reason: 'manifest_unreadable' }
  }
  let manifest: ExecutionJournalManifest
  try {
    manifest = parseManifest(JSON.parse(manifestRaw))
  } catch (error) {
    if (
      error instanceof ExecutionJournalError &&
      error.code === 'unsupported_version'
    ) {
      return { kind: 'unsupported_version' }
    }
    return { kind: 'corrupt', reason: 'manifest_invalid' }
  }

  const hardBounds = scopeHardBounds(manifest.scopeKind)
  const readBounds = limits === undefined
    ? hardBounds
    : {
        maxBytes: Math.min(limits.maxBytes, hardBounds?.maxBytes ?? limits.maxBytes),
        maxEvents: Math.min(limits.maxEvents, hardBounds?.maxEvents ?? limits.maxEvents),
      }
  let raw: string
  if (readBounds) {
    try {
      const bounded = await readBoundedFileNoFollow(
        path.join(journalDirectory, EXECUTION_JOURNAL_FILENAME),
        readBounds.maxBytes,
      )
      if (bounded.kind === 'missing') return { kind: 'not_found' }
      if (bounded.kind !== 'ok') {
        return { kind: 'corrupt', reason: 'journal_over_bound' }
      }
      raw = bounded.text
    } catch {
      return { kind: 'corrupt', reason: 'journal_unreadable' }
    }
  } else {
    try {
      raw = await fs.readFile(
        path.join(journalDirectory, EXECUTION_JOURNAL_FILENAME),
        'utf8',
      )
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) return { kind: 'not_found' }
      return { kind: 'corrupt', reason: 'journal_unreadable' }
    }
  }
  try {
    const validation = validateJournalContent(manifest, raw)
    const events = validation.events
    // The same bound the write path enforces. A journal can reach this size
    // some other way — restored from elsewhere, or written by a build that had
    // no bound — and a read path that returns it anyway has not enforced the
    // bound at all; it has only made it inconvenient to exceed.
    if (readBounds && events.length > readBounds.maxEvents) {
      return { kind: 'corrupt', reason: 'journal_over_bound' }
    }
    return {
      kind: 'ok',
      manifest,
      events,
      truncatedTail: validation.fragment !== undefined,
    }
  } catch (error) {
    if (
      error instanceof ExecutionJournalError &&
      error.code === 'unsupported_version'
    ) {
      return { kind: 'unsupported_version' }
    }
    return {
      kind: 'corrupt',
      reason: error instanceof Error ? error.message : 'journal_invalid',
    }
  }
}

class FileSystemExecutionJournal implements ExecutionJournal {
  private readonly paths: JournalPaths
  readonly manifest: ExecutionJournalManifest
  private readonly manifestRawText: string
  private readonly identity: ExecutionJournalScopeIdentity
  private readonly index: JournalTailIndex
  private readonly clock: { readonly now: () => number }
  private readonly lockTimeoutMs: number
  private readonly writeInterceptor:
    | ((target: JournalWriteTarget) => JournalWriteTarget)
    | undefined
  private queueTail: Promise<unknown> = Promise.resolve()
  private pendingAppends: PendingAppend[] = []
  private commitScheduled = false
  private fileHandle: fs.FileHandle | undefined
  private closed = false
  private poisoned = false
  /**
   * Set when a recoverable fault ended this handle's usefulness (ADR A-2).
   *
   * Distinct from `poisoned`, which means the durable history needs repair. A
   * retired handle's history is intact — but its in-memory index has advanced
   * past what reached disk, because `prepareBatchEntry` mutates the index
   * before the write and `resyncIndexLocked` only catches up when the file
   * grew. Nothing may append through this object again.
   */
  private retired = false
  private closePromise: Promise<void> | undefined
  private metrics: {
    appendCount: number
    lockAcquisitionCount: number
    syncCount: number
    alreadyAcceptedCount: number
    revisionConflictCount: number
    identityConflictCount: number
    lockTimeoutCount: number
    corruptionCount: number
    retiredHandleCount: number
    appendLatencyMsTotal: number
    syncLatencyMsTotal: number
    lockWaitMsTotal: number
    scanCount: number
    scannedEventCount: number
    truncatedFragmentBytesTotal: number
  }

  constructor(input: {
    readonly paths: JournalPaths
    readonly manifest: ExecutionJournalManifest
    readonly manifestRawText: string
    readonly identity: ExecutionJournalScopeIdentity
    readonly index: JournalTailIndex
    readonly clock: { readonly now: () => number }
    readonly lockTimeoutMs: number
    readonly writeInterceptor?:
      | ((target: JournalWriteTarget) => JournalWriteTarget)
      | undefined
    readonly initialMetrics: {
      readonly scanDurationMs: number
      readonly scannedEventCount: number
      readonly truncatedFragmentBytes: number
    }
  }) {
    this.paths = input.paths
    this.manifest = input.manifest
    this.manifestRawText = input.manifestRawText
    this.identity = input.identity
    this.index = input.index
    this.clock = input.clock
    this.lockTimeoutMs = input.lockTimeoutMs
    this.writeInterceptor = input.writeInterceptor
    this.metrics = {
      appendCount: 0,
      lockAcquisitionCount: 0,
      syncCount: 0,
      alreadyAcceptedCount: 0,
      revisionConflictCount: 0,
      identityConflictCount: 0,
      lockTimeoutCount: 0,
      corruptionCount: 0,
      retiredHandleCount: 0,
      appendLatencyMsTotal: 0,
      syncLatencyMsTotal: 0,
      lockWaitMsTotal: 0,
      scanCount: 1,
      scannedEventCount: input.initialMetrics.scannedEventCount,
      truncatedFragmentBytesTotal: input.initialMetrics.truncatedFragmentBytes,
    }
  }

  get journalDirectoryPath(): string {
    return this.paths.journalDirectory
  }

  /**
   * Appends group-commit: the lock cycle and the `sync()` barrier are the
   * dominant cost of an append, so every request already waiting when a
   * commit starts shares one of each. Each request still receives its own
   * outcome, and no outcome is reported before its record is durable.
   */
  append(
    input: ExecutionJournalAppendInput,
  ): Promise<ExecutionJournalAppendOutcome> {
    return new Promise<ExecutionJournalAppendOutcome>((resolve, reject) => {
      this.pendingAppends.push({ input, resolve, reject })
      if (this.commitScheduled) return
      this.commitScheduled = true
      void this.enqueue(() => this.commitPendingAppends())
    })
  }

  scan(): Promise<ExecutionJournalScanSummary> {
    return this.enqueue(() => this.scanSerialized())
  }

  scanStream(
    streamKind: string,
    streamId: string,
  ): Promise<ExecutionJournalScanSummary> {
    return this.enqueue(() => this.scanStreamSerialized(streamKind, streamId))
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.enqueue(async () => {
      this.closed = true
      if (this.fileHandle) {
        await this.fileHandle.close().catch(() => undefined)
        this.fileHandle = undefined
      }
    })
    return this.closePromise
  }

  getMetrics(): ExecutionJournalMetrics {
    return { ...this.metrics }
  }

  isRetired(): boolean {
    return this.retired
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queueTail.then(operation)
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async commitPendingAppends(): Promise<void> {
    this.commitScheduled = false
    const batch = this.pendingAppends
    this.pendingAppends = []
    if (batch.length === 0) return

    const startedAt = this.clock.now()
    if (this.closed) {
      const closed = new ExecutionJournalError(
        'closed',
        'Execution journal is closed.',
      )
      for (const entry of batch) entry.reject(closed)
      return
    }
    if (this.poisoned) {
      const poisoned = corrupt(
        'Execution journal detected corruption and can no longer be used.',
      )
      for (const entry of batch) entry.reject(poisoned)
      return
    }
    if (this.retired) {
      const retiredError = new ExecutionJournalError(
        'retired',
        'Execution journal handle was retired after a recoverable fault; ' +
          'a new handle must be opened.',
      )
      for (const entry of batch) entry.reject(retiredError)
      return
    }

    let lock: AcquiredProcessFileLock<CrossProcessFileLockRecord>
    try {
      lock = await this.acquireLock(undefined)
    } catch (error) {
      for (const entry of batch) entry.reject(error)
      return
    }

    // Outcomes are held until the batch is durable; nothing is acknowledged
    // before its record has been written and synced.
    const settlements: Array<() => void> = []
    try {
      await this.validateEnvironmentLocked()
      await this.resyncIndexLocked()

      const lines: Buffer[] = []
      for (const entry of batch) {
        const prepared = this.prepareBatchEntry(entry)
        if (prepared.kind === 'settled') {
          settlements.push(prepared.settle)
          continue
        }
        lines.push(prepared.line)
        settlements.push(prepared.settle)
      }

      if (lines.length > 0) {
        const payload = Buffer.concat(lines)
        const handle = await this.openJournalHandleLocked()
        const target = this.writeInterceptor?.(handle) ?? handle
        await writeAllBytes(target, payload)
        const syncStartedAt = this.clock.now()
        await target.sync()
        this.metrics.syncCount += 1
        this.metrics.syncLatencyMsTotal += this.clock.now() - syncStartedAt
        this.index.byteLength += payload.byteLength
        this.metrics.appendLatencyMsTotal += this.clock.now() - startedAt
      }
    } catch (error) {
      // The in-memory index already reflects records whose durability is now
      // unknown, so this handle fails closed either way. What differs is
      // whether the *assignment* is finished with it (ADR A-2).
      let rejection = error
      if (
        error instanceof ExecutionJournalError &&
        error.code === 'limit_exceeded'
      ) {
        // A bound is not a fault. Retiring the handle would tell the caller to
        // open a fresh one and carry on, and a fresh handle would refuse this
        // activity too — the answer is that this activity is finished, which is
        // a different thing to do about it. Nothing is poisoned and nothing is
        // retired: the journal is intact and one append was refused.
      } else if (isIntegrityFault(error)) {
        // Counted only where it is first seen. `resyncIndexLocked` detects and
        // records damage at the site that found it, and it is also reachable
        // from `scan` and `scanStream`, which have no catch of their own — so
        // counting again here would double-count exactly the faults this
        // metric exists to measure.
        if (!this.poisoned) this.metrics.corruptionCount += 1
        this.poisoned = true
      } else {
        // Counted at the transition only: the guard above refuses every later
        // append without reaching here, so a caller that retries cannot turn
        // one fault into a rising count.
        this.metrics.retiredHandleCount += 1
        this.retired = true
        // N5: the descriptor was previously left open forever. Closing it is
        // also what makes a reopen honest — the next handle opens the file as
        // it now is, rather than inheriting access granted earlier.
        const staleHandle = this.fileHandle
        this.fileHandle = undefined
        if (staleHandle) await staleHandle.close().catch(() => undefined)
        // The boundary is typed: a raw `ENOSPC` from Node would otherwise
        // cross it unwrapped, and callers classify on the journal's own code.
        // The original failure is kept as the cause, because the errno is
        // what an operator needs to read.
        rejection = new ExecutionJournalError(
          'retired',
          `Execution journal handle was retired after a recoverable fault: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        )
      }
      for (const entry of batch) entry.reject(rejection)
      return
    } finally {
      await lock.release()
    }
    for (const settle of settlements) settle()
  }

  /**
   * Validate one queued append against the live index and, when it is a real
   * record, produce its line and index it so the next entry in the batch
   * chains from it. Every outcome is deferred until the batch is durable.
   */
  private prepareBatchEntry(entry: PendingAppend): PreparedBatchEntry {
    const settled = (settle: () => void): PreparedBatchEntry => ({
      kind: 'settled',
      settle,
    })
    let normalized: NormalizedAppendInput
    try {
      normalized = validateAppendInput(entry.input)
      throwIfAborted(normalized.signal)
    } catch (error) {
      return settled(() => entry.reject(error))
    }

    const existing = this.index.eventsById.get(normalized.eventId)
    if (existing) {
      if (existing.appendRequestDigest === normalized.appendRequestDigest) {
        this.metrics.alreadyAcceptedCount += 1
        return settled(() =>
          entry.resolve({ kind: 'already-accepted', event: existing }),
        )
      }
      this.metrics.identityConflictCount += 1
      return settled(() =>
        entry.resolve({
          kind: 'event-identity-conflict',
          eventId: normalized.eventId,
        }),
      )
    }

    const streamKey = streamKeyOf(normalized.streamKind, normalized.streamId)
    const actualRevision = this.index.streamRevisions.get(streamKey) ?? 0
    if (
      !verifyStreamRevision(normalized.expectedStreamRevision, actualRevision)
    ) {
      this.metrics.revisionConflictCount += 1
      return settled(() =>
        entry.resolve({
          kind: 'revision-conflict',
          expectedRevision: normalized.expectedStreamRevision,
          actualRevision,
        }),
      )
    }

    if (normalized.causationEventId !== undefined) {
      if (normalized.causationEventId === normalized.eventId) {
        return settled(() =>
          entry.reject(
            appendInvalid('Journal causation identity references itself.'),
          ),
        )
      }
      // The reader rejects a causation reference that resolves forward, so
      // the writer must not accept one it cannot already resolve backward.
      if (!this.index.eventSequences.has(normalized.causationEventId)) {
        return settled(() =>
          entry.reject(
            appendInvalid(
              'Journal causation identity does not reference a recorded event.',
            ),
          ),
        )
      }
    }

    const event = this.buildEvent(normalized, actualRevision)
    const line = Buffer.from(`${canonicalizeJson(event)}\n`, 'utf8')
    const bounds = scopeHardBounds(this.manifest.scopeKind)
    if (bounds) {
      // Checked against the running index, so an entry later in a batch is
      // measured against the entries before it rather than against the state
      // the batch started from.
      if (event.sequence > bounds.maxEvents) {
        return settled(() =>
          entry.reject(
            limitExceeded(
              `Conversation activity journal already holds its ${bounds.maxEvents} ` +
                'events; this append would take it past that.',
            ),
          ),
        )
      }
      if (this.index.byteLength + line.byteLength > bounds.maxBytes) {
        return settled(() =>
          entry.reject(
            limitExceeded(
              `Conversation activity journal would reach ${
                this.index.byteLength + line.byteLength
              } bytes, over its ${bounds.maxBytes}-byte bound.`,
            ),
          ),
        )
      }
    }
    this.index.lastSequence = event.sequence
    this.index.lastEventHash = event.eventHash
    this.index.streamRevisions.set(streamKey, event.streamRevision)
    this.index.eventSequences.set(event.eventId, event.sequence)
    indexEvent(this.index, event)
    this.metrics.appendCount += 1
    return {
      kind: 'record',
      line,
      settle: () => entry.resolve({ kind: 'appended', event }),
    }
  }

  private assertHealthy(): void {
    if (this.poisoned) {
      throw corrupt(
        'Execution journal detected corruption and can no longer be used.',
      )
    }
  }

  private async scanSerialized(): Promise<ExecutionJournalScanSummary> {
    if (this.closed) {
      throw new ExecutionJournalError('closed', 'Execution journal is closed.')
    }
    this.assertHealthy()
    const lock = await this.acquireLock(undefined)
    try {
      await this.validateEnvironmentLocked()
      await this.resyncIndexLocked()
      this.metrics.scanCount += 1
      this.metrics.scannedEventCount += this.index.eventsById.size
      const events = [...this.index.eventsById.values()].sort(
        (left, right) => left.sequence - right.sequence,
      )
      return {
        eventCount: events.length,
        lastSequence: this.index.lastSequence,
        events,
        truncatedFragmentBytes: this.metrics.truncatedFragmentBytesTotal,
      }
    } finally {
      await lock.release()
    }
  }

  private async scanStreamSerialized(
    streamKind: string,
    streamId: string,
  ): Promise<ExecutionJournalScanSummary> {
    if (this.closed) {
      throw new ExecutionJournalError('closed', 'Execution journal is closed.')
    }
    this.assertHealthy()
    const lock = await this.acquireLock(undefined)
    try {
      await this.validateEnvironmentLocked()
      await this.resyncIndexLocked()
      const events =
        this.index.eventsByStream.get(streamKeyOf(streamKind, streamId)) ?? []
      this.metrics.scanCount += 1
      this.metrics.scannedEventCount += events.length
      return {
        eventCount: events.length,
        lastSequence: events[events.length - 1]?.sequence ?? 0,
        events: [...events],
        truncatedFragmentBytes: this.metrics.truncatedFragmentBytesTotal,
      }
    } finally {
      await lock.release()
    }
  }

  private buildEvent(
    normalized: NormalizedAppendInput,
    actualRevision: number,
  ): ExecutionJournalEvent {
    const event: ExecutionJournalEvent = {
      schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
      eventId: normalized.eventId,
      sequence: this.index.lastSequence + 1,
      recordedAt: new Date(this.clock.now()).toISOString(),
      scopeKind: this.manifest.scopeKind,
      scopeId: this.manifest.scopeId,
      tenantId: this.manifest.tenantId,
      ...(this.manifest.sessionId === undefined
        ? {}
        : { sessionId: this.manifest.sessionId }),
      ...(this.manifest.runId === undefined
        ? {}
        : { runId: this.manifest.runId }),
      ...(this.manifest.assignmentId === undefined
        ? {}
        : { assignmentId: this.manifest.assignmentId }),
      ...(this.manifest.ownerKind === undefined ? {} : { ownerKind: this.manifest.ownerKind }),
      ...(this.manifest.conversationId === undefined
        ? {}
        : { conversationId: this.manifest.conversationId }),
      ...(this.manifest.activityKind === undefined
        ? {}
        : { activityKind: this.manifest.activityKind }),
      streamKind: normalized.streamKind,
      streamId: normalized.streamId,
      streamRevision: actualRevision + 1,
      type: normalized.type,
      payloadSchemaVersion: normalized.payloadSchemaVersion,
      appendRequestDigest: normalized.appendRequestDigest,
      correlationId: normalized.correlationId,
      ...(normalized.causationEventId === undefined
        ? {}
        : { causationEventId: normalized.causationEventId }),
      ...(normalized.sourceSequenceId === undefined
        ? {}
        : { sourceSequenceId: normalized.sourceSequenceId }),
      ...(normalized.sourceOrdinal === undefined
        ? {}
        : { sourceOrdinal: normalized.sourceOrdinal }),
      ...(normalized.executionAttemptId === undefined
        ? {}
        : { executionAttemptId: normalized.executionAttemptId }),
      previousEventHash: this.index.lastEventHash,
      eventHash: '',
      payload: normalized.payload,
    }
    return { ...event, eventHash: recomputeEventHash(event) }
  }

  private async acquireLock(
    signal: AbortSignal | undefined,
  ): Promise<AcquiredProcessFileLock<CrossProcessFileLockRecord>> {
    const waitStartedAt = this.clock.now()
    try {
      const lock = await acquireProcessFileLock({
        lockPath: this.paths.lockPath,
        record: createCrossProcessFileLockRecord(),
        adapter: crossProcessFileLockAdapter,
        timeoutMs: this.lockTimeoutMs,
        waitDescription: 'execution journal lock',
        ...(signal === undefined ? {} : { signal }),
      })
      this.metrics.lockWaitMsTotal += this.clock.now() - waitStartedAt
      this.metrics.lockAcquisitionCount += 1
      return lock
    } catch (error) {
      // Every lock failure is translated, not only the timeout. The lock is
      // the journal's own boundary, so its failures must arrive as the
      // journal's own error type: a foreign one carries a code the caller
      // cannot classify, and the caller's classification is what decides
      // whether an assignment is retried or repaired (ADR A-2).
      if (error instanceof ProcessFileLockError) {
        const lockName = path.basename(this.paths.lockPath)
        switch (error.code) {
          case 'timeout':
            this.metrics.lockTimeoutCount += 1
            throw new ExecutionJournalError(
              'lock_timeout',
              `Timed out waiting for the execution journal lock: ${lockName}`,
              { cause: error },
            )
          case 'in_use':
            // Contention, not damage: someone else holds it right now. It
            // reuses `lock_timeout` because that is already the public code
            // for "the lock could not be taken in time".
            this.metrics.lockTimeoutCount += 1
            throw new ExecutionJournalError(
              'lock_timeout',
              `The execution journal lock is held by another writer: ${lockName}`,
              { cause: error },
            )
          case 'corrupt':
            // The lock record itself is unreadable. That is damage to durable
            // state, and a reopen would meet it again.
            throw new ExecutionJournalError(
              'corrupt',
              `The execution journal lock record is unreadable: ${lockName}`,
              { cause: error },
            )
        }
      }
      throw error
    }
  }

  private async validateEnvironmentLocked(): Promise<void> {
    await validateOwnedDirectory(this.paths.scopeRoot, 'Journal scope root')
    await assertPrivateDirectory(
      this.paths.runtimePath,
      'Private runtime directory',
    )
    await assertPrivateDirectory(
      this.paths.journalDirectory,
      'Journal directory',
    )
    // Bounded and no-follow, before any comparison. This runs on every
    // operation of a live handle, so it is a small frequent read of a file
    // another process can replace — and reading a replacement whole, only to
    // then notice the contents differ, is the allocation the bound exists to
    // prevent.
    const manifestRaw = await readManifestBounded(this.paths.manifestPath)
    if (manifestRaw !== this.manifestRawText) {
      throw new ExecutionJournalError(
        'manifest_conflict',
        'Execution journal manifest changed after initialization.',
      )
    }
    const manifestStat = await fs.lstat(this.paths.manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Execution journal manifest is not a regular file.',
      )
    }
    if (hasRelaxedPermissions(manifestStat)) {
      throw new ExecutionJournalError(
        'permissions_unsafe',
        'Execution journal manifest permissions are relaxed.',
      )
    }
  }

  private async resyncIndexLocked(): Promise<void> {
    const stat = await fs.lstat(this.paths.journalPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Execution journal file is not a regular file.',
      )
    }
    if (hasRelaxedPermissions(stat)) {
      throw new ExecutionJournalError(
        'permissions_unsafe',
        'Execution journal file permissions are relaxed.',
      )
    }
    if (stat.size < this.index.byteLength) {
      this.metrics.corruptionCount += 1
      this.poisoned = true
      throw corrupt('Execution journal shrank below its validated length.')
    }
    if (stat.size === this.index.byteLength) return

    const bounds = scopeHardBounds(this.manifest.scopeKind)

    // Opened without following a name, then judged on the opened handle. The
    // `lstat` above described the path; between then and here it can be
    // replaced, and a read through the new name would allocate whatever that
    // file holds and index it as this activity's history.
    const readHandle = await fs.open(
      this.paths.journalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
    let tailText: string
    try {
      const openedStat = await readHandle.stat()
      if (!openedStat.isFile()) {
        this.poisoned = true
        throw corrupt('Execution journal file is not a regular file.')
      }
      if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
        // Not the file this handle validated a moment ago. Indexing its
        // contents as this activity's tail is exactly the confusion the
        // identity check exists to prevent.
        this.poisoned = true
        throw corrupt('Execution journal file was replaced while being read.')
      }
      if (bounds && openedStat.size > bounds.maxBytes) {
        // Catching up must not begin by allocating everything another writer
        // added. The bound is about what this scope may hold, whoever wrote it.
        throw limitExceeded(
          `Conversation activity journal grew to ${openedStat.size} bytes, over ` +
            `its ${bounds.maxBytes}-byte bound, and its tail was not read.`,
        )
      }
      if (openedStat.size < this.index.byteLength) {
        this.metrics.corruptionCount += 1
        this.poisoned = true
        throw corrupt('Execution journal shrank below its validated length.')
      }
      const pendingBytes = openedStat.size - this.index.byteLength
      const buffer = Buffer.alloc(pendingBytes)
      await readExactlyBytes(
        readHandle,
        buffer,
        this.index.byteLength,
        pendingBytes,
      )
      tailText = buffer.toString('utf8')
    } catch (error) {
      if (error instanceof ExecutionJournalError && error.code === 'corrupt') {
        this.metrics.corruptionCount += 1
        this.poisoned = true
      }
      throw error
    } finally {
      await readHandle.close()
    }

    const tail = classifyJournalTail(tailText)
    const lines = tailText.split('\n')
    const fragment = tail === 'unterminated' ? lines[lines.length - 1] : undefined
    const terminatedLines = lines.slice(0, -1)
    let validatedBytes = 0
    try {
      for (const line of terminatedLines) {
        const event = validateJournalLine(this.manifest, this.index, line)
        indexEvent(this.index, event)
        validatedBytes += Buffer.byteLength(`${line}\n`, 'utf8')
      }
    } catch (error) {
      if (error instanceof ExecutionJournalError && error.code === 'corrupt') {
        this.metrics.corruptionCount += 1
        this.poisoned = true
      }
      throw error
    }

    if (fragment !== undefined && fragment.length > 0) {
      // An unacknowledged fragment may only follow validated records; it was
      // never acknowledged, so truncating it restores the durable tail.
      await truncateJournalTo(
        this.paths.journalPath,
        this.index.byteLength + validatedBytes,
      )
      this.metrics.truncatedFragmentBytesTotal += Buffer.byteLength(
        fragment,
        'utf8',
      )
    }
    this.index.byteLength += validatedBytes
  }

  private async openJournalHandleLocked(): Promise<fs.FileHandle> {
    const expectedStat = await fs.lstat(this.paths.journalPath)
    if (!expectedStat.isFile() || expectedStat.isSymbolicLink()) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Execution journal file is not a regular file.',
      )
    }
    if (this.fileHandle) {
      const handleStat = await this.fileHandle.stat()
      if (
        handleStat.dev === expectedStat.dev &&
        handleStat.ino === expectedStat.ino
      ) {
        return this.fileHandle
      }
      await this.fileHandle.close().catch(() => undefined)
      this.fileHandle = undefined
    }
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(
        this.paths.journalPath,
        appendNoFollowFlags(),
        0o600,
      )
      const openedStat = await handle.stat()
      if (
        !openedStat.isFile() ||
        openedStat.dev !== expectedStat.dev ||
        openedStat.ino !== expectedStat.ino
      ) {
        throw new Error('opened journal file does not match its path')
      }
      const canonicalJournalPath = await fs.realpath(this.paths.journalPath)
      if (canonicalJournalPath !== this.paths.journalPath) {
        throw new Error('journal path escapes its canonical directory')
      }
      this.fileHandle = handle
      return handle
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      throw new ExecutionJournalError(
        'path_unsafe',
        'Execution journal file could not be opened safely.',
        { cause: error },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Initialization helpers
// ---------------------------------------------------------------------------

async function loadOrCreateManifest(
  paths: JournalPaths,
  identity: ExecutionJournalScopeIdentity,
  clock: { readonly now: () => number },
): Promise<{ readonly manifest: ExecutionJournalManifest; readonly rawText: string }> {
  let existingStat: Awaited<ReturnType<typeof fs.lstat>> | undefined
  try {
    existingStat = await fs.lstat(paths.manifestPath)
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ENOENT')) throw error
  }

  if (existingStat) {
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Execution journal manifest is not a regular file.',
      )
    }
    if (hasRelaxedPermissions(existingStat)) {
      throw new ExecutionJournalError(
        'permissions_unsafe',
        'Execution journal manifest permissions are relaxed.',
      )
    }
    let rawText: string
    try {
      // Bounded and no-follow, on every operation. This runs while the journal
      // is live, so the file it reads is one another process can replace — and
      // an unbounded read of a replaced name is the allocation this whole
      // layer's bounds exist to prevent.
      rawText = await readManifestBounded(paths.manifestPath)
    } catch {
      throw new ExecutionJournalError(
        'corrupt',
        'Execution journal manifest could not be read.',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch {
      throw new ExecutionJournalError(
        'corrupt',
        'Execution journal manifest is not valid JSON.',
      )
    }
    const manifest = parseManifest(parsed)
    if (!identityMatchesManifest(manifest, identity)) {
      throw new ExecutionJournalError(
        'manifest_conflict',
        'Execution journal already exists with a different identity.',
      )
    }
    if (
      manifest.initialSequence !== 0 ||
      manifest.initialPreviousEventHash !== computeGenesisEventHash(identity)
    ) {
      throw new ExecutionJournalError(
        'manifest_conflict',
        'Execution journal manifest carries an unexpected hash chain origin.',
      )
    }
    return { manifest, rawText }
  }

  const manifest: ExecutionJournalManifest = {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    scopeKind: identity.scopeKind,
    scopeId: identity.scopeId,
    tenantId: identity.tenantId,
    ...(identity.sessionId === undefined
      ? {}
      : { sessionId: identity.sessionId }),
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    ...(identity.assignmentId === undefined
      ? {}
      : { assignmentId: identity.assignmentId }),
    ...(identity.ownerKind === undefined ? {} : { ownerKind: identity.ownerKind }),
    ...(identity.conversationId === undefined
      ? {}
      : { conversationId: identity.conversationId }),
    ...(identity.activityKind === undefined
      ? {}
      : { activityKind: identity.activityKind }),
    createdAt: new Date(clock.now()).toISOString(),
    journalRelativePath: EXECUTION_JOURNAL_FILENAME,
    initialSequence: 0,
    initialPreviousEventHash: computeGenesisEventHash(identity),
    createdBy: {
      implementation: JOURNAL_IMPLEMENTATION_NAME,
      version: JOURNAL_IMPLEMENTATION_VERSION,
    },
  }
  const rawText = `${JSON.stringify(manifest)}\n`
  await publishPrivateFileAtomically(paths.manifestPath, rawText)
  return { manifest, rawText }
}

/**
 * Validate a manifest from untrusted input.
 *
 * Exported so callers that must judge a manifest — discovery deciding whether
 * an activity is readable, for one — use the same rules the journal itself
 * applies, instead of a weaker parser that drifts from them.
 */
export function parseExecutionJournalManifest(
  raw: unknown,
): ExecutionJournalManifest {
  return parseManifest(raw)
}

function parseManifest(raw: unknown): ExecutionJournalManifest {
  if (!isPlainRecord(raw)) {
    throw new ExecutionJournalError(
      'corrupt',
      'Execution journal manifest must be a JSON object.',
    )
  }
  if (raw.schemaVersion !== EXECUTION_JOURNAL_SCHEMA_VERSION) {
    throw new ExecutionJournalError(
      'unsupported_version',
      'Execution journal manifest schema version is not supported.',
    )
  }
  if (
    raw.scopeKind !== 'assignment' &&
    raw.scopeKind !== 'batch' &&
    raw.scopeKind !== 'conversation'
  ) {
    throw new ExecutionJournalError(
      'corrupt',
      'Execution journal manifest scope kind is invalid.',
    )
  }
  if (
    (raw.ownerKind !== undefined && raw.ownerKind !== 'run-session' && raw.ownerKind !== 'create-resource-architect') ||
    (raw.conversationId !== undefined &&
      !isJournalIdentifier(raw.conversationId)) ||
    (raw.activityKind !== undefined && !isActivityKind(raw.activityKind))
  ) {
    throw new ExecutionJournalError(
      'corrupt',
      'Execution journal manifest conversation identity is invalid.',
    )
  }
  if (
    !isJournalIdentifier(raw.scopeId) ||
    !isJournalIdentifier(raw.tenantId) ||
    (raw.sessionId !== undefined && !isJournalIdentifier(raw.sessionId)) ||
    (raw.runId !== undefined && !isJournalIdentifier(raw.runId)) ||
    (raw.assignmentId !== undefined && !isJournalIdentifier(raw.assignmentId)) ||
    !isIsoTimestamp(raw.createdAt) ||
    raw.journalRelativePath !== EXECUTION_JOURNAL_FILENAME ||
    raw.initialSequence !== 0 ||
    !isSha256Hex(raw.initialPreviousEventHash)
  ) {
    throw new ExecutionJournalError(
      'corrupt',
      'Execution journal manifest fields are invalid.',
    )
  }
  assertScopeShape(
    {
      scopeKind: raw.scopeKind,
      sessionId: raw.sessionId,
      runId: raw.runId,
      assignmentId: raw.assignmentId,
      conversationId: raw.conversationId,
      ownerKind: raw.ownerKind,
      activityKind: raw.activityKind,
    },
    (detail) => {
      throw new ExecutionJournalError(
        'corrupt',
        `Execution journal manifest scope is not a valid shape: ${detail}.`,
      )
    },
  )
  if (!isPlainRecord(raw.createdBy)) {
    throw new ExecutionJournalError(
      'corrupt',
      'Execution journal manifest creator is invalid.',
    )
  }
  const createdBy = raw.createdBy
  if (
    !isJournalIdentifier(createdBy.implementation) ||
    !isPositiveInteger(createdBy.version)
  ) {
    throw new ExecutionJournalError(
      'corrupt',
      'Execution journal manifest creator is invalid.',
    )
  }
  return {
    schemaVersion: EXECUTION_JOURNAL_SCHEMA_VERSION,
    scopeKind: raw.scopeKind,
    scopeId: raw.scopeId,
    tenantId: raw.tenantId,
    ...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId }),
    ...(raw.runId === undefined ? {} : { runId: raw.runId }),
    ...(raw.ownerKind === undefined ? {} : { ownerKind: raw.ownerKind }),
    ...(raw.conversationId === undefined
      ? {}
      : { conversationId: raw.conversationId }),
    ...(raw.activityKind === undefined
      ? {}
      : { activityKind: raw.activityKind }),
    ...(raw.assignmentId === undefined
      ? {}
      : { assignmentId: raw.assignmentId }),
    createdAt: raw.createdAt,
    journalRelativePath: raw.journalRelativePath,
    initialSequence: 0,
    initialPreviousEventHash: raw.initialPreviousEventHash,
    createdBy: {
      implementation: createdBy.implementation,
      version: createdBy.version,
    },
  }
}

function identityMatchesManifest(
  manifest: ExecutionJournalManifest,
  identity: ExecutionJournalScopeIdentity,
): boolean {
  return manifest.scopeKind === identity.scopeKind &&
    manifest.scopeId === identity.scopeId &&
    manifest.tenantId === identity.tenantId &&
    manifest.sessionId === identity.sessionId &&
    manifest.ownerKind === identity.ownerKind &&
    manifest.runId === identity.runId &&
    manifest.assignmentId === identity.assignmentId &&
    manifest.conversationId === identity.conversationId &&
    manifest.activityKind === identity.activityKind
}

async function ensureJournalFile(paths: JournalPaths): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined
  try {
    stat = await fs.lstat(paths.journalPath)
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ENOENT')) throw error
  }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ExecutionJournalError(
        'path_unsafe',
        'Execution journal file is not a regular file.',
      )
    }
    if (hasRelaxedPermissions(stat)) {
      throw new ExecutionJournalError(
        'permissions_unsafe',
        'Execution journal file permissions are relaxed.',
      )
    }
    return
  }
  const handle = await fs.open(paths.journalPath, appendNoFollowFlags(), 0o600)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(paths.journalPath))
}

async function validateOwnedDirectory(
  directoryPath: string,
  label: string,
): Promise<string> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(directoryPath)
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      throw new ExecutionJournalError(
        'scope_invalid',
        `${label} does not exist: ${directoryPath}`,
      )
    }
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExecutionJournalError(
      'path_unsafe',
      `${label} must be an owned directory: ${directoryPath}`,
    )
  }
  return fs.realpath(directoryPath)
}

async function ensurePrivateDirectory(
  directoryPath: string,
  canonicalExpectedPath: string,
  label: string,
): Promise<string> {
  try {
    await fs.mkdir(directoryPath, { mode: 0o700 })
  } catch (error) {
    if (!hasNodeErrorCode(error, 'EEXIST')) throw error
  }
  return assertPrivateDirectory(directoryPath, label, canonicalExpectedPath)
}

async function assertPrivateDirectory(
  directoryPath: string,
  label: string,
  canonicalExpectedPath?: string,
): Promise<string> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(directoryPath)
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      throw new ExecutionJournalError(
        'path_unsafe',
        `${label} is missing: ${directoryPath}`,
      )
    }
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ExecutionJournalError(
      'path_unsafe',
      `${label} must be a directory that is not a symbolic link.`,
    )
  }
  if (hasRelaxedPermissions(stat)) {
    throw new ExecutionJournalError(
      'permissions_unsafe',
      `${label} permissions are relaxed.`,
    )
  }
  const canonicalPath = await fs.realpath(directoryPath)
  if (canonicalExpectedPath !== undefined && canonicalPath !== canonicalExpectedPath) {
    throw new ExecutionJournalError(
      'path_unsafe',
      `${label} resolves outside its canonical location.`,
    )
  }
  return canonicalPath
}

export async function publishPrivateFileAtomically(
  targetPath: string,
  content: string,
): Promise<void> {
  await publishPrivateFile(targetPath, content, 'replace')
}

/**
 * Publish a private file only if nothing already holds the name.
 *
 * Same durability path as `publishPrivateFileAtomically` — a synced temporary
 * file, then an atomic publication, then a parent-directory sync — but the
 * publication is `link`, which fails with `EEXIST` rather than replacing. For a
 * file that is written once and read thereafter, losing that race is the
 * correct outcome and a silent overwrite is not.
 *
 * Returns false when the name was already taken.
 */
export async function publishPrivateFileExclusively(
  targetPath: string,
  content: string,
): Promise<boolean> {
  return publishPrivateFile(targetPath, content, 'exclusive')
}

async function publishPrivateFile(
  targetPath: string,
  content: string,
  publication: 'replace' | 'exclusive',
): Promise<boolean> {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  )
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (publication === 'replace') {
      await fs.rename(temporaryPath, targetPath)
    } else {
      await fs.link(temporaryPath, targetPath)
      await fs.unlink(temporaryPath)
    }
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined)
    if (publication === 'exclusive' && hasNodeErrorCode(error, 'EEXIST')) {
      return false
    }
    throw error
  }
  await syncDirectory(path.dirname(targetPath))
  return true
}

async function truncateJournalTo(
  journalPath: string,
  byteLength: number,
): Promise<void> {
  const handle = await fs.open(journalPath, 'r+')
  try {
    await handle.truncate(byteLength)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(path.dirname(journalPath))
}

async function acquireJournalLock(
  lockPath: string,
  lockTimeoutMs: number,
  signal?: AbortSignal,
): Promise<AcquiredProcessFileLock<CrossProcessFileLockRecord>> {
  try {
    const lock = await acquireProcessFileLock({
      lockPath,
      record: createCrossProcessFileLockRecord(),
      adapter: crossProcessFileLockAdapter,
      timeoutMs: lockTimeoutMs,
      waitDescription: 'execution journal lock',
      ...(signal === undefined ? {} : { signal }),
    })
    return lock
  } catch (error) {
    if (error instanceof ProcessFileLockError && error.code === 'timeout') {
      throw new ExecutionJournalError(
        'lock_timeout',
        `Timed out waiting for the execution journal lock: ${path.basename(lockPath)}`,
      )
    }
    throw error
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r').catch(() => undefined)
  if (!handle) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Input validation and shared helpers
// ---------------------------------------------------------------------------

interface NormalizedAppendInput {
  readonly eventId: string
  readonly streamKind: string
  readonly streamId: string
  readonly expectedStreamRevision: number
  readonly type: string
  readonly payloadSchemaVersion: number
  readonly payload: CanonicalJsonObject
  readonly correlationId: string
  readonly causationEventId: string | undefined
  readonly sourceSequenceId: string | undefined
  readonly sourceOrdinal: number | undefined
  readonly executionAttemptId: string | undefined
  readonly appendRequestDigest: string
  readonly signal: AbortSignal | undefined
}

function validateAppendInput(
  input: ExecutionJournalAppendInput,
): NormalizedAppendInput {
  if (!isPlainRecord(input)) {
    throw appendInvalid('Journal append input must be an object.')
  }
  if (!isJournalIdentifier(input.eventId)) {
    throw appendInvalid('Journal append event identity is invalid.')
  }
  if (!isJournalIdentifier(input.streamKind)) {
    throw appendInvalid('Journal append stream kind is invalid.')
  }
  if (!isJournalIdentifier(input.streamId)) {
    throw appendInvalid('Journal append stream identity is invalid.')
  }
  if (!isNonNegativeInteger(input.expectedStreamRevision)) {
    throw appendInvalid('Journal append expected stream revision is invalid.')
  }
  if (!isJournalIdentifier(input.type)) {
    throw appendInvalid('Journal append event type is invalid.')
  }
  if (!isPositiveInteger(input.payloadSchemaVersion)) {
    throw appendInvalid('Journal append payload schema version is invalid.')
  }
  if (!isJournalIdentifier(input.correlationId)) {
    throw appendInvalid('Journal append correlation identity is invalid.')
  }
  if (
    input.causationEventId !== undefined &&
    !isJournalIdentifier(input.causationEventId)
  ) {
    throw appendInvalid('Journal append causation identity is invalid.')
  }
  const hasSourceSequence = input.sourceSequenceId !== undefined
  const hasSourceOrdinal = input.sourceOrdinal !== undefined
  if (hasSourceSequence !== hasSourceOrdinal) {
    throw appendInvalid(
      'Journal append source sequence and ordinal must be provided together.',
    )
  }
  if (hasSourceSequence && !isJournalIdentifier(input.sourceSequenceId)) {
    throw appendInvalid('Journal append source sequence identity is invalid.')
  }
  if (hasSourceOrdinal && !isNonNegativeInteger(input.sourceOrdinal)) {
    throw appendInvalid('Journal append source ordinal is invalid.')
  }
  if (
    input.executionAttemptId !== undefined &&
    !isJournalIdentifier(input.executionAttemptId)
  ) {
    throw appendInvalid('Journal append execution attempt identity is invalid.')
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw appendInvalid('Journal append signal is invalid.')
  }
  let payload: CanonicalJsonObject
  try {
    payload = JSON.parse(canonicalizeJson(input.payload)) as CanonicalJsonObject
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw appendInvalid('Journal append payload is not canonical JSON.')
    }
    throw error
  }

  const fields: JournalAppendRequestFields = {
    eventId: input.eventId,
    streamKind: input.streamKind,
    streamId: input.streamId,
    expectedStreamRevision: input.expectedStreamRevision,
    type: input.type,
    payloadSchemaVersion: input.payloadSchemaVersion,
    payload,
    correlationId: input.correlationId,
    ...(input.causationEventId === undefined
      ? {}
      : { causationEventId: input.causationEventId }),
    ...(input.sourceSequenceId === undefined
      ? {}
      : { sourceSequenceId: input.sourceSequenceId }),
    ...(input.sourceOrdinal === undefined
      ? {}
      : { sourceOrdinal: input.sourceOrdinal }),
    ...(input.executionAttemptId === undefined
      ? {}
      : { executionAttemptId: input.executionAttemptId }),
  }
  return {
    ...fields,
    causationEventId: input.causationEventId,
    sourceSequenceId: input.sourceSequenceId,
    sourceOrdinal: input.sourceOrdinal,
    executionAttemptId: input.executionAttemptId,
    appendRequestDigest: computeAppendRequestDigest(fields),
    signal: input.signal,
  }
}

/**
 * The fields each scope kind must carry, and the ones it must not.
 *
 * Checked as a set rather than field by field. Every field was already
 * validated on its own — is this a well-formed identifier, if present at all —
 * which says nothing about whether the combination describes anything real. An
 * assignment carrying a conversation id, a conversation journal opened with no
 * conversation, a batch claiming an assignment: each is a journal whose identity
 * says one thing while its contents assume another, and the genesis hash seals
 * whatever it was given, so the contradiction becomes permanent as soon as the
 * manifest is written.
 *
 * One rule, applied in both directions. What this build may open a journal with
 * and what it may read an existing manifest as have to be the same set, or a
 * file it could never have written becomes a file it will happily accept.
 *
 * Deliberately absent: any rule tying an assignment's `scopeId` to its
 * `assignmentId`. Journals exist that were written under contracts where those
 * differ, and refusing them would make old workspaces unreadable in exchange
 * for a tidier rule.
 */
function assertScopeShape(
  fields: {
    readonly scopeKind: 'assignment' | 'batch' | 'conversation'
    readonly sessionId?: unknown
    readonly runId?: unknown
    readonly assignmentId?: unknown
    readonly conversationId?: unknown
    readonly ownerKind?: unknown
    readonly activityKind?: unknown
  },
  fail: (detail: string) => never,
): void {
  const has = (value: unknown): boolean => value !== undefined
  if (has(fields.ownerKind) && fields.scopeKind !== 'conversation') {
    fail('only a conversation scope names an owner kind')
  }
  if (fields.scopeKind === 'assignment') {
    if (!has(fields.sessionId) || !has(fields.runId) || !has(fields.assignmentId)) {
      fail('an assignment scope must name its session, run and assignment')
    }
    if (has(fields.conversationId) || has(fields.activityKind)) {
      fail('an assignment scope does not belong to a conversation')
    }
    return
  }
  if (fields.scopeKind === 'batch') {
    if (
      has(fields.sessionId) ||
      has(fields.runId) ||
      has(fields.assignmentId) ||
      has(fields.conversationId) ||
      has(fields.activityKind)
    ) {
      fail('a batch scope stands alone and names nothing above it')
    }
    return
  }
  if (
    (fields.ownerKind !== 'create-resource-architect' && !has(fields.sessionId)) ||
    !has(fields.conversationId) ||
    !has(fields.activityKind)
  ) {
    fail('a conversation scope must name its session, conversation and activity kind')
  }
  if (fields.ownerKind === 'create-resource-architect' && has(fields.sessionId)) {
    fail('a Create conversation has no Run session')
  }
  if (has(fields.runId) || has(fields.assignmentId)) {
    fail('a conversation scope does not belong to a run or an assignment')
  }
}

function validateScopeIdentity(identity: ExecutionJournalScopeIdentity): void {
  if (!isPlainRecord(identity)) {
    throw new ExecutionJournalError(
      'scope_invalid',
      'Journal scope identity must be an object.',
    )
  }
  if (
    identity.scopeKind !== 'assignment' &&
    identity.scopeKind !== 'batch' &&
    identity.scopeKind !== 'conversation'
  ) {
    throw new ExecutionJournalError(
      'scope_invalid',
      'Journal scope kind is invalid.',
    )
  }
  if (
    (identity.ownerKind !== undefined && identity.ownerKind !== 'run-session' && identity.ownerKind !== 'create-resource-architect') ||
    (identity.conversationId !== undefined &&
      !isJournalIdentifier(identity.conversationId)) ||
    (identity.activityKind !== undefined &&
      !isActivityKind(identity.activityKind))
  ) {
    throw new ExecutionJournalError(
      'scope_invalid',
      'Journal scope conversation identity is invalid.',
    )
  }
  if (
    !isJournalIdentifier(identity.scopeId) ||
    !isJournalIdentifier(identity.tenantId) ||
    (identity.sessionId !== undefined &&
      !isJournalIdentifier(identity.sessionId)) ||
    (identity.runId !== undefined && !isJournalIdentifier(identity.runId)) ||
    (identity.assignmentId !== undefined &&
      !isJournalIdentifier(identity.assignmentId))
  ) {
    throw new ExecutionJournalError(
      'scope_invalid',
      'Journal scope identity fields are invalid.',
    )
  }
  assertScopeShape(identity, (detail) => {
    throw new ExecutionJournalError(
      'scope_invalid',
      `Journal scope identity is not a valid shape: ${detail}.`,
    )
  })
}

function requestFieldsFromEvent(
  event: ExecutionJournalEvent,
): JournalAppendRequestFields {
  return {
    eventId: event.eventId,
    streamKind: event.streamKind,
    streamId: event.streamId,
    expectedStreamRevision: event.streamRevision - 1,
    type: event.type,
    payloadSchemaVersion: event.payloadSchemaVersion,
    payload: event.payload,
    correlationId: event.correlationId,
    ...(event.causationEventId === undefined
      ? {}
      : { causationEventId: event.causationEventId }),
    ...(event.sourceSequenceId === undefined
      ? {}
      : { sourceSequenceId: event.sourceSequenceId }),
    ...(event.sourceOrdinal === undefined
      ? {}
      : { sourceOrdinal: event.sourceOrdinal }),
    ...(event.executionAttemptId === undefined
      ? {}
      : { executionAttemptId: event.executionAttemptId }),
  }
}

function eventHashRecord(
  event: Omit<ExecutionJournalEvent, 'eventHash'>,
): Record<string, CanonicalJsonValue> {
  const record: Record<string, CanonicalJsonValue> = {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    sequence: event.sequence,
    recordedAt: event.recordedAt,
    scopeKind: event.scopeKind,
    scopeId: event.scopeId,
    tenantId: event.tenantId,
    streamKind: event.streamKind,
    streamId: event.streamId,
    streamRevision: event.streamRevision,
    type: event.type,
    payloadSchemaVersion: event.payloadSchemaVersion,
    appendRequestDigest: event.appendRequestDigest,
    correlationId: event.correlationId,
    previousEventHash: event.previousEventHash,
    payload: event.payload,
  }
  if (event.ownerKind !== undefined) record.ownerKind = event.ownerKind
  if (event.sessionId !== undefined) record.sessionId = event.sessionId
  if (event.runId !== undefined) record.runId = event.runId
  if (event.assignmentId !== undefined) record.assignmentId = event.assignmentId
  if (event.conversationId !== undefined) {
    record.conversationId = event.conversationId
  }
  if (event.activityKind !== undefined) record.activityKind = event.activityKind
  if (event.causationEventId !== undefined) {
    record.causationEventId = event.causationEventId
  }
  if (event.sourceSequenceId !== undefined) {
    record.sourceSequenceId = event.sourceSequenceId
  }
  if (event.sourceOrdinal !== undefined) {
    record.sourceOrdinal = event.sourceOrdinal
  }
  if (event.executionAttemptId !== undefined) {
    record.executionAttemptId = event.executionAttemptId
  }
  return record
}

function buildTailIndex(
  manifest: ExecutionJournalManifest,
  events: readonly ExecutionJournalEvent[],
  byteLength: number,
): JournalTailIndex {
  const index: JournalTailIndex = {
    lastSequence: manifest.initialSequence,
    lastEventHash: manifest.initialPreviousEventHash,
    streamRevisions: new Map(),
    eventSequences: new Map(),
    byteLength,
    eventsById: new Map(),
    eventsByStream: new Map(),
  }
  for (const event of events) {
    index.lastSequence = event.sequence
    index.lastEventHash = event.eventHash
    index.streamRevisions.set(
      streamKeyOf(event.streamKind, event.streamId),
      event.streamRevision,
    )
    index.eventSequences.set(event.eventId, event.sequence)
    indexEvent(index, event)
  }
  return index
}

/** Records one event in the identity and per-stream indexes, in order. */
function indexEvent(
  index: JournalTailIndex,
  event: ExecutionJournalEvent,
): void {
  index.eventsById.set(event.eventId, event)
  const streamKey = streamKeyOf(event.streamKind, event.streamId)
  const stream = index.eventsByStream.get(streamKey)
  if (stream) {
    stream.push(event)
    return
  }
  index.eventsByStream.set(streamKey, [event])
}

function createMutableIndex(manifest: ExecutionJournalManifest): MutableJournalIndex {
  return {
    lastSequence: manifest.initialSequence,
    lastEventHash: manifest.initialPreviousEventHash,
    streamRevisions: new Map(),
    eventSequences: new Map(),
  }
}

function assertCausationOrder(
  events: readonly ExecutionJournalEvent[],
  index: MutableJournalIndex,
): void {
  for (const event of events) {
    if (event.causationEventId === undefined) continue
    const causeSequence = index.eventSequences.get(event.causationEventId)
    if (causeSequence !== undefined && causeSequence >= event.sequence) {
      throw corrupt('Journal causation reference is not ordered.')
    }
  }
}

function parseCanonicalPayload(value: unknown): CanonicalJsonObject {
  let canonical: string
  try {
    canonical = canonicalizeJson(value)
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw corrupt('Journal payload is not strict canonical JSON.')
    }
    throw error
  }
  const parsed: unknown = JSON.parse(canonical)
  if (!isPlainRecord(parsed)) {
    throw corrupt('Journal payload must be a JSON object.')
  }
  return parsed as CanonicalJsonObject
}

function assertOptionalIdentityMatches(
  recordValue: unknown,
  manifestValue: string | undefined,
  label: string,
): void {
  if (manifestValue === undefined) {
    if (recordValue !== undefined) {
      throw corrupt(`Journal record ${label} identity does not match the manifest.`)
    }
    return
  }
  if (recordValue !== manifestValue) {
    throw corrupt(`Journal record ${label} identity does not match the manifest.`)
  }
}

function validatedBytes(raw: string, fragment: string | undefined): number {
  const total = Buffer.byteLength(raw, 'utf8')
  if (fragment === undefined) return total
  return total - Buffer.byteLength(fragment, 'utf8')
}

function streamKeyOf(streamKind: string, streamId: string): string {
  return `${streamKind}\0${streamId}`
}

/** The subset of `fs.FileHandle` the journal reads through. */
export interface JournalByteReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>
}

/** The subset of `fs.FileHandle` the journal writes through. */
export interface JournalByteWriter {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
  ): Promise<{ readonly bytesWritten: number }>
}

/**
 * Read exactly `length` bytes. A short read is resumed; a read that ends
 * early means the file shrank under us, which is corruption rather than an
 * unterminated tail — treating it as a tail would truncate durable events.
 */
export async function readExactlyBytes(
  handle: JournalByteReader,
  buffer: Buffer,
  position: number,
  length: number,
): Promise<void> {
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    )
    if (bytesRead <= 0) {
      throw corrupt('Execution journal ended before its recorded length.')
    }
    offset += bytesRead
  }
}

/**
 * Write every byte. A short write leaves a partial record on disk; resuming
 * completes it, and a write that stops making progress fails closed rather
 * than reporting an append that never fully landed.
 */
export async function writeAllBytes(
  handle: JournalByteWriter,
  bytes: Buffer,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    )
    if (bytesWritten <= 0) {
      // Not corruption: the torn final line was never acknowledged to any
      // caller, and a reopen truncates it (ADR A-2).
      throw new ExecutionJournalError(
        'write_incomplete',
        'Execution journal write stopped before the record ended.',
      )
    }
    offset += bytesWritten
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function appendNoFollowFlags(): number {
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  return (
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow
  )
}

function appendInvalid(message: string): ExecutionJournalError {
  return new ExecutionJournalError('append_invalid', message)
}

function corrupt(message: string): ExecutionJournalError {
  return new ExecutionJournalError('corrupt', message)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('Journal append was cancelled.', 'AbortError')
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  )
}

function hasRelaxedPermissions(stat: { readonly mode: number | bigint }): boolean {
  return (Number(stat.mode) & 0o077) !== 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isActivityKind(
  value: unknown,
): value is ExecutionJournalActivityKind {
  return value === 'turn'
}

function isJournalIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/.test(value)
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
}
