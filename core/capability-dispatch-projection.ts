import { canonicalizeJson } from '../contracts/canonical-json.js'
import type { CapabilityDispatchEventType } from '../contracts/capability-dispatch.js'
import type { ExecutionJournalEvent } from '../contracts/execution-journal.js'
import {
  DURABLE_DISPATCH_STREAM_KIND,
} from './durable-dispatch.js'
import {
  JournalJsonlProjectionStore,
  ProjectionRebuildRequiredError,
} from './journal-projection.js'
import type { ExecutionJournal } from './execution-journal.js'
import * as path from 'node:path'

export const CAPABILITY_EVIDENCE_PROJECTION_ID = 'capability-evidence'
export const CAPABILITY_EVIDENCE_REDUCER_VERSION = 2

/**
 * Reducer projecting canonical dispatch journal events onto the legacy
 * capability-evidence view (`capability-dispatch-events.jsonl`). Canonical-only
 * stages (`prepared`, `committed`, and the three operator resolutions) carry no
 * legacy counterpart and project to nothing (ADR §9). The watermark still
 * advances over them, so a resolved dispatch does not leave the view reading as
 * permanently behind; the resolution itself is visible in the journal, which is
 * the authority, and not in this compatibility view.
 */
export function projectCapabilityDispatchEvidenceLine(
  event: ExecutionJournalEvent,
): string | undefined {
  if (event.streamKind !== DURABLE_DISPATCH_STREAM_KIND) return undefined
  const legacyType = legacyTypeFor(event.type)
  if (!legacyType) return undefined

  const payload = event.payload
  const identity = payload['identity']
  if (!isPlainRecord(identity)) return undefined

  const record: Record<string, unknown> = { ...identity }
  record['type'] = legacyType
  record['timestamp'] = event.recordedAt

  const code = payload['code']
  if (typeof code === 'string') record['code'] = code
  const interactionId = payload['interactionId']
  if (typeof interactionId === 'string') {
    record['interactionId'] = interactionId
  }
  const approvalOutcome = payload['approvalOutcome']
  if (isApprovalOutcome(approvalOutcome)) {
    record['approvalOutcome'] = approvalOutcome
  }
  const costTracked = payload['costTracked']
  if (typeof costTracked === 'boolean') record['costTracked'] = costTracked
  const budgetOverrun = payload['budgetOverrun']
  if (typeof budgetOverrun === 'boolean') record['budgetOverrun'] = budgetOverrun
  const actualCostUsd = payload['actualCostUsd']
  if (typeof actualCostUsd === 'number' && Number.isFinite(actualCostUsd)) {
    record['actualCostUsd'] = actualCostUsd
  }

  return canonicalizeJson(record)
}

function legacyTypeFor(
  journalType: string,
): CapabilityDispatchEventType | undefined {
  switch (journalType) {
    case 'capability.dispatch.requested':
      return 'capability.dispatch.requested'
    case 'capability.dispatch.approval_requested':
      return 'capability.dispatch.approval_requested'
    case 'capability.dispatch.approval_resolved':
      return 'capability.dispatch.approval_resolved'
    case 'capability.dispatch.started':
      return 'capability.dispatch.started'
    case 'capability.dispatch.accepted':
      return 'capability.dispatch.completed'
    case 'capability.dispatch.rejected':
      return 'capability.dispatch.rejected'
    case 'capability.dispatch.cancelled':
      return 'capability.dispatch.cancelled'
    case 'capability.dispatch.failed':
      return 'capability.dispatch.failed'
    case 'capability.dispatch.indeterminate':
      return 'capability.dispatch.indeterminate'
    default:
      return undefined
  }
}

function isApprovalOutcome(
  value: unknown,
): value is 'approved' | 'denied' | 'expired' | 'cancelled' | 'interrupted' {
  return value === 'approved' || value === 'denied' || value === 'expired' ||
    value === 'cancelled' || value === 'interrupted'
}

export function createCapabilityEvidenceProjectionStore(
  journal: ExecutionJournal,
  evidencePath: string,
): JournalJsonlProjectionStore {
  return new JournalJsonlProjectionStore({
    projectionId: CAPABILITY_EVIDENCE_PROJECTION_ID,
    reducerVersion: CAPABILITY_EVIDENCE_REDUCER_VERSION,
    projectionDirectory: path.join(journal.journalDirectoryPath, 'projections'),
    targetPath: evidencePath,
    // This view lives at `<assignment>/logs/<file>` by contract, so the
    // assignment directory is the anchor every access is checked against. The
    // layout belongs here, in the evidence view's own factory, rather than in
    // the generic store (AC20).
    targetContainerPath: path.dirname(path.dirname(evidencePath)),
  })
}

/**
 * The highest sequence this view could possibly have derived from.
 *
 * Not the journal's last sequence. One journal per assignment carries workflow
 * state as well (ADR §1), and this view projects nothing from those events, so
 * comparing against the journal-wide counter reports every assignment that
 * runs a workflow as permanently behind (N31).
 */
export function lastDispatchSequence(
  events: readonly ExecutionJournalEvent[],
): number {
  let last = 0
  for (const event of events) {
    if (event.streamKind !== DURABLE_DISPATCH_STREAM_KIND) continue
    if (event.sequence > last) last = event.sequence
  }
  return last
}

/** Rebuild the capability-evidence projection from the canonical journal. */
export async function rebuildCapabilityEvidenceProjection(
  journal: ExecutionJournal,
  evidencePath: string,
): Promise<void> {
  const scan = await journal.scan()
  const store = createCapabilityEvidenceProjectionStore(journal, evidencePath)
  await store.rebuild(scan.events, projectCapabilityDispatchEvidenceLine)
}

/**
 * Apply newly appended journal events to the capability-evidence projection.
 * Projection failures are classified as lag rather than failing the canonical
 * append (ADR §11); a reducer-version or target drift requests a rebuild.
 */
export async function applyCapabilityEvidenceProjection(
  store: JournalJsonlProjectionStore,
  newEvents: readonly ExecutionJournalEvent[],
): Promise<'applied' | 'rebuild-required'> {
  try {
    await store.applyEvents(newEvents, projectCapabilityDispatchEvidenceLine)
    return 'applied'
  } catch (error) {
    if (error instanceof ProjectionRebuildRequiredError) {
      return 'rebuild-required'
    }
    throw error
  }
}

/**
 * Bring the capability-evidence view forward from the canonical journal.
 *
 * Reads from the recorded watermark rather than from memory, so a batch whose
 * append failed — in this process or one that has since exited — is recovered
 * rather than lost. Only dispatch-stream events are handed over: everything
 * else projects to nothing, and passing it would advance the watermark past
 * events this view never derived from.
 */
export async function catchUpCapabilityEvidenceProjection(
  journal: ExecutionJournal,
  store: JournalJsonlProjectionStore,
): Promise<'applied' | 'rebuild-required'> {
  const scan = await journal.scan()
  const dispatchEvents = scan.events.filter(
    (event) => event.streamKind === DURABLE_DISPATCH_STREAM_KIND,
  )
  try {
    await store.catchUp(dispatchEvents, projectCapabilityDispatchEvidenceLine)
    return 'applied'
  } catch (error) {
    if (error instanceof ProjectionRebuildRequiredError) {
      return 'rebuild-required'
    }
    throw error
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
