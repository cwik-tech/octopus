/**
 * The conversation's retention record: which turns are open, and which have
 * finished and are still being kept.
 *
 * Retention asks two per-conversation questions — how many finished turns are
 * being kept, and which are the oldest — and neither can be answered from a
 * window of activities: the excess may sit entirely outside whatever the window
 * covered. Listing the activity directory instead makes the newest turn pay for
 * every turn before it, which is the growth per-activity journals exist to
 * avoid, and it is unbounded raw work in a directory a caller can influence.
 *
 * So both answers live in one small document beside the activities, holding an
 * exact entry per retained turn, ordered by when that turn ended.
 *
 * Ordered by when it ended, not by when it was written down. Those differ: a
 * turn whose process died before it could record its ending is projected later,
 * by reconciliation, and finished earlier than everything recorded since. A
 * record that reclaimed in the order it learned things would delete the newest
 * history and keep the oldest, which is the opposite of what the cap is for.
 *
 * The open set lives in the same document on purpose. Giving a slot back and
 * writing down that the turn finished have to be one atomic step — two steps
 * mean a crash between them either loses the finished turn forever or counts it
 * twice on retry, and the count cap then deletes history that was never over
 * the limit. One document, one rename, one lock: a crash before it keeps the
 * slot for reconciliation to find, and a crash after it has already recorded
 * both.
 *
 * This is a projection, never an authority. The journals own what happened. If
 * the record is damaged or falls behind, no turn changes; retention simply does
 * less until reconciliation refills it. Every caller must re-verify an
 * activity's state before deleting it, because a name here is a hint that
 * something is probably reclaimable, not a licence. Rewriting it whole is not
 * the compaction the journal ADR forbids, for the same reason: it owns nothing.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { withFileLock } from '../domains/sessions/session-file-locks.js'
import { CONVERSATION_MAX_PROJECTED_IDS } from '../domains/conversations/conversation-turn-retention-policy.js'
import {
  buildConversationActivitiesRoot,
  CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
  isConversationActivityId,
} from '../core/conversation-activity-location.js'
import {
  ensureSafeWorkspaceDirectory,
  readPrivateFile,
  replacePrivateFileAtomically,
  UnsafeWorkspacePathError,
} from './safe-workspace-directory.js'
import type { ConversationOwner } from '../core/conversation-activity-location.js'

const DOCUMENT_FILENAME = '.unresolved.json'
const DOCUMENT_TEMP_FILENAME = `${DOCUMENT_FILENAME}.tmp`
const LOCK_FILENAME = '.unresolved.lock'

export const MAX_OPEN_ENTRIES = 1_000
export const MAX_TURN_ID_LENGTH = 200
/** How many finished turns the record names exactly at once. */
export const MAX_PROJECTED_IDS = CONVERSATION_MAX_PROJECTED_IDS

/**
 * The largest retention document this will read.
 *
 * Computed from what the document is allowed to hold rather than picked: a
 * bound smaller than the population the policy permits would turn a
 * conversation at its cap into a `'damaged'` read, and a damaged record is one
 * that stops projecting exactly — so the failure would arrive only for the
 * conversations big enough to reach it.
 */
export const MAX_DOCUMENT_BYTES =
  4096 + (MAX_PROJECTED_IDS + MAX_OPEN_ENTRIES) * (MAX_TURN_ID_LENGTH + 48)

const DEFAULT_SELECT_LIMIT = 32
const MAX_SELECT_LIMIT = 1_000

export interface TerminalLedgerEntry {
  readonly activityId: string
  /** When the turn reached its terminal, in epoch milliseconds. */
  readonly atMs: number
}

export type TerminalRecordOutcome =
  | 'recorded'
  /** Already recorded. The count is unchanged, which is the point. */
  | 'duplicate'
  /** Could not be written. Retention does less; nothing else changes. */
  | 'unavailable'

export interface ConversationRetentionDocument {
  /** Turns holding an admission slot. */
  readonly openTurnIds: ReadonlySet<string>
  /**
   * Finished turns still being kept, oldest ending first.
   *
   * Exact, not a window. Knowing whether a turn has already been recorded has
   * to hold for every turn still kept, or a replay eventually records one twice
   * and the cap deletes history that was never over the limit.
   */
  readonly retained: readonly TerminalLedgerEntry[]
  /** Where the next reservation reconciliation resumes. */
  readonly reconcileCursor: number
}

export const EMPTY_RETENTION_DOCUMENT: ConversationRetentionDocument = {
  openTurnIds: new Set(),
  retained: [],
  reconcileCursor: 0,
}

/** One candidate, and which rule put it there. */
export interface ReclaimCandidate extends TerminalLedgerEntry {
  readonly reason: 'aged' | 'overflow'
}

export interface ReclaimSelection {
  /** Finished turns still kept, across the whole conversation. */
  readonly liveCount: number
  /** The oldest of them, bounded by `limit`. */
  readonly candidates: readonly ReclaimCandidate[]
  /**
   * Whether another pass would find anything.
   *
   * A full page is not the same fact. A conversation whose remaining turns are
   * inside both limits has nothing left to reclaim however many sweeps run, and
   * inferring "more" from the page being full sends a caller back for work that
   * does not exist. Only the record can tell the difference, so it says.
   */
  readonly hasMoreReclaimable: boolean
  /** Set when the record could not be read exactly. */
  readonly degraded?: string
}

export function conversationRetentionLockPath(root: string): string {
  return path.join(root, LOCK_FILENAME)
}

export function conversationRetentionRoot(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
}): string | null {
  if (input.owner.kind !== 'run-session') return null
  return buildConversationActivitiesRoot(
    input.workspacePath,
    input.owner.sessionId,
  )
}

export async function ensureConversationRetentionRoot(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
}): Promise<void> {
  if (input.owner.kind !== 'run-session') {
    throw new Error('Run retention requires a Run-session owner.')
  }
  await ensureSafeWorkspaceDirectory({
    workspacePath: input.workspacePath,
    segments: [
      'sessions',
      input.owner.sessionId,
      CONVERSATION_ACTIVITIES_DIRECTORY_NAME,
    ],
    // The conversation's own directory is this caller's to create. The session
    // that owns it is not: a turn arriving just after its session was deleted
    // must fail, not rebuild the owner on its way past.
    requireExisting: 2,
  })
}

/**
 * Add one finished turn to the record, without releasing anything.
 *
 * Callers hold the retention lock, so this is half of an atomic step rather
 * than a step of its own. Throws when the record is full, so the caller can
 * decline to commit and leave the turn's admission slot in place as a retry
 * anchor.
 */
export function projectTerminalUnderLock(input: {
  readonly document: ConversationRetentionDocument
  readonly entry: TerminalLedgerEntry
}): ConversationRetentionDocument {
  if (input.document.retained.length + 1 > MAX_PROJECTED_IDS) {
    throw new Error(
      'The retention record is full; this turn cannot be recorded until ' +
        'retention reclaims some of it.',
    )
  }
  return {
    ...input.document,
    retained: insertByEnding(input.document.retained, {
      activityId: input.entry.activityId,
      atMs: Math.trunc(input.entry.atMs),
    }),
  }
}

/** Whether this turn is already recorded as finished. */
export function isTerminalRecorded(
  document: ConversationRetentionDocument,
  activityId: string,
): boolean {
  return document.retained.some((entry) => entry.activityId === activityId)
}

/**
 * Record one finished turn on its own.
 *
 * The production path records inside the same locked step that releases the
 * turn's admission slot, which is what makes it exactly-once. This is the
 * standalone form, for callers that have no slot to release.
 */
export async function recordTerminalActivity(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly activityId: string
  readonly atMs: number
}): Promise<TerminalRecordOutcome> {
  const root = conversationRetentionRoot(input)
  if (!root) return 'unavailable'
  if (!isTurnId(input.activityId) || !Number.isFinite(input.atMs)) {
    return 'unavailable'
  }
  try {
    await ensureConversationRetentionRoot(input)
    return await withFileLock(conversationRetentionLockPath(root), async () => {
      const stored = await readRetentionDocument(root)
      if (stored === 'damaged') return 'unavailable'
      if (isTerminalRecorded(stored, input.activityId)) return 'duplicate'
      const next = projectTerminalUnderLock({
        document: stored,
        entry: { activityId: input.activityId, atMs: input.atMs },
      })
      await writeRetentionDocument(root, next)
      return 'recorded'
    })
  } catch {
    return 'unavailable'
  }
}

/**
 * The oldest finished turns, and how many are being kept.
 *
 * Read-only and lock-free. The entries are already in ending order, so the
 * oldest are simply the front of them.
 */
export async function selectReclaimableActivities(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly now: () => number
  readonly retentionMs?: number
  readonly maxTerminalActivities?: number
  readonly limit?: number
}): Promise<ReclaimSelection> {
  const root = conversationRetentionRoot(input)
  if (!root) return { liveCount: 0, candidates: [], hasMoreReclaimable: false }

  let stored: ConversationRetentionDocument | 'damaged'
  try {
    stored = await readRetentionDocument(root)
  } catch {
    return {
      liveCount: 0,
      candidates: [],
      hasMoreReclaimable: false,
      degraded: 'the record could not be read',
    }
  }
  if (stored === 'damaged') {
    return {
      liveCount: 0,
      candidates: [],
      hasMoreReclaimable: false,
      degraded: 'the retention document could not be trusted',
    }
  }

  const liveCount = stored.retained.length
  if (liveCount === 0) {
    return { liveCount: 0, candidates: [], hasMoreReclaimable: false }
  }

  const limit = Math.min(
    Math.max(1, input.limit ?? DEFAULT_SELECT_LIMIT),
    MAX_SELECT_LIMIT,
  )
  const retentionMs = input.retentionMs ?? Number.POSITIVE_INFINITY
  const now = input.now()
  const cap = Math.min(input.maxTerminalActivities ?? liveCount, MAX_PROJECTED_IDS)

  const candidates: ReclaimCandidate[] = []
  let hasMoreReclaimable = false
  for (const entry of stored.retained) {
    const aged = now - entry.atMs >= retentionMs
    // Every reclaim relieves the pressure, whichever rule chose it. Counting
    // age and volume separately meant a conversation with two turns past the
    // window and two turns of excess lost four — the two that were old, and
    // then two more that were neither old nor excess.
    const overCap = liveCount - candidates.length > cap
    if (!aged && !overCap) break
    // The page is full and this one qualified: that, and only that, is what
    // makes another pass worth running.
    if (candidates.length >= limit) {
      hasMoreReclaimable = true
      break
    }
    candidates.push({ ...entry, reason: aged ? 'aged' : 'overflow' })
  }
  return { liveCount, candidates, hasMoreReclaimable }
}

/**
 * Forget exactly the turns a caller dealt with.
 *
 * By identity rather than by count: a caller that stopped early, or skipped one
 * it could not delete, must not have the record advance past anything it left
 * behind.
 */
/**
 * What became of an attempt to forget reclaimed activities.
 *
 * `unavailable` is the one that matters. The activities are already gone from
 * disk at that point, so a record that still lists them describes a
 * conversation that no longer exists — and a sweep reporting success over that
 * is the caller being told the work is done when the two halves disagree.
 */
export type ReclaimCommitOutcome = 'committed' | 'unchanged' | 'unavailable'

export async function commitReclaimedActivities(input: {
  readonly workspacePath: string
  readonly owner: ConversationOwner
  readonly reclaimedIds: readonly string[]
}): Promise<ReclaimCommitOutcome> {
  if (input.reclaimedIds.length === 0) return 'unchanged'
  const root = conversationRetentionRoot(input)
  if (!root) return 'unchanged'
  const forgotten = new Set(input.reclaimedIds)
  try {
    return await withFileLock(
      conversationRetentionLockPath(root),
      async (): Promise<ReclaimCommitOutcome> => {
        const stored = await readRetentionDocument(root)
        if (stored === 'damaged') return 'unavailable'
        const retained = stored.retained.filter(
          (entry) => !forgotten.has(entry.activityId),
        )
        if (retained.length === stored.retained.length) return 'unchanged'
        await writeRetentionDocument(root, { ...stored, retained })
        return 'committed'
      },
    )
  } catch {
    // Not swallowed into a success. The next pass does repeat the work, but a
    // record that can never be written repeats it forever, and nobody is told.
    return 'unavailable'
  }
}

/**
 * Insert in ending order, then by id so the same set always reads the same way.
 *
 * A linear insert into an array the cap already bounds. The alternative — append
 * and sort on read — is what made the order a property of when things were
 * written down rather than when they happened.
 */
function insertByEnding(
  retained: readonly TerminalLedgerEntry[],
  entry: TerminalLedgerEntry,
): TerminalLedgerEntry[] {
  const next = [...retained, entry]
  next.sort(
    (left, right) =>
      left.atMs - right.atMs ||
      (left.activityId < right.activityId
        ? -1
        : left.activityId > right.activityId
          ? 1
          : 0),
  )
  return next
}

/**
 * The retention document, `'damaged'` when it exists and cannot be trusted.
 *
 * Absent and damaged are different facts and only one of them is safe to treat
 * as an empty record. Collapsing them is how a damaged document silently
 * becomes a licence to admit unlimited work.
 */
export async function readRetentionDocument(
  root: string,
): Promise<ConversationRetentionDocument | 'damaged'> {
  let raw: string | undefined
  try {
    // A verified directory says nothing about the files in it. A document that
    // is a link would let something outside this conversation answer a question
    // about what is inside it, so a link here is damage, not a redirect.
    raw = await readPrivateFile(path.join(root, DOCUMENT_FILENAME), {
      maxBytes: MAX_DOCUMENT_BYTES,
    })
  } catch (error) {
    if (error instanceof UnsafeWorkspacePathError) return 'damaged'
    throw error
  }
  if (raw === undefined) return EMPTY_RETENTION_DOCUMENT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'damaged'
  }
  if (!isRecord(parsed)) return 'damaged'

  const turnIds = parsed.turnIds
  if (!Array.isArray(turnIds) || turnIds.length > MAX_OPEN_ENTRIES) return 'damaged'
  const openTurnIds = new Set<string>()
  for (const value of turnIds) {
    if (!isTurnId(value)) return 'damaged'
    openTurnIds.add(value)
  }
  if (turnIds.length !== openTurnIds.size) return 'damaged'

  const retainedField = parsed.retained
  if (retainedField === undefined) {
    return { openTurnIds, retained: [], reconcileCursor: cursorOf(parsed) ?? 0 }
  }
  if (!Array.isArray(retainedField) || retainedField.length > MAX_PROJECTED_IDS) {
    return 'damaged'
  }
  const retained: TerminalLedgerEntry[] = []
  const seen = new Set<string>()
  let previous: TerminalLedgerEntry | undefined
  for (const value of retainedField) {
    if (!isRecord(value)) return 'damaged'
    const activityId = value.id
    const atMs = value.atMs
    if (!isTurnId(activityId)) return 'damaged'
    if (typeof atMs !== 'number' || !Number.isSafeInteger(atMs)) return 'damaged'
    if (seen.has(activityId)) return 'damaged'
    // Stored in ending order, so a document out of order is one this build did
    // not write — and reclaiming from the front of it would forget the wrong
    // turns.
    if (previous && !endsBefore(previous, { activityId, atMs })) return 'damaged'
    seen.add(activityId)
    previous = { activityId, atMs }
    retained.push(previous)
  }

  const reconcileCursor = cursorOf(parsed)
  if (reconcileCursor === undefined) return 'damaged'
  return { openTurnIds, retained, reconcileCursor }
}

function endsBefore(
  left: TerminalLedgerEntry,
  right: TerminalLedgerEntry,
): boolean {
  return (
    left.atMs < right.atMs ||
    (left.atMs === right.atMs && left.activityId < right.activityId)
  )
}

function cursorOf(source: Record<string, unknown>): number | undefined {
  const value = source.reconcileCursor
  if (value === undefined) return 0
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether this value names a turn this record may hold.
 *
 * The activity identity, not a bounded string. A record that accepts any short
 * word can be handed names no activity ever had, and every count derived from
 * it — the unresolved cap, the retained cap, the reclaim order — is then a
 * count of something else. The length bound stays as the document's own
 * ceiling: it is what `MAX_DOCUMENT_BYTES` is computed from.
 */
function isTurnId(value: unknown): value is string {
  return (
    isConversationActivityId(value) && value.length <= MAX_TURN_ID_LENGTH
  )
}

export async function writeRetentionDocument(
  root: string,
  document: ConversationRetentionDocument,
): Promise<void> {
  assertWritableRetentionDocument(document)
  await replacePrivateFileAtomically({
    targetPath: path.join(root, DOCUMENT_FILENAME),
    temporaryPath: path.join(root, DOCUMENT_TEMP_FILENAME),
    contents: JSON.stringify({
      turnIds: [...document.openTurnIds].sort(),
      retained: document.retained.map((entry) => ({
        id: entry.activityId,
        atMs: entry.atMs,
      })),
      reconcileCursor: document.reconcileCursor,
    }),
  })
  await fs.rm(path.join(root, DOCUMENT_TEMP_FILENAME), { force: true }).catch(
    () => undefined,
  )
}

function assertWritableRetentionDocument(
  document: ConversationRetentionDocument,
): void {
  // Refused rather than written. A document past these bounds is one the next
  // reader has to classify as damaged, and a damaged record is one that stops
  // recording exactly — so the failure would arrive later, somewhere else, as a
  // lost count.
  if (document.retained.length > MAX_PROJECTED_IDS) {
    throw new Error(
      `The retention record would name ${document.retained.length} finished ` +
        `turns, over its ${MAX_PROJECTED_IDS} bound.`,
    )
  }
  if (document.openTurnIds.size > MAX_OPEN_ENTRIES) {
    throw new Error(
      `The retention record would hold ${document.openTurnIds.size} open turns, ` +
      `over its ${MAX_OPEN_ENTRIES} bound.`,
    )
  }
  for (const activityId of document.openTurnIds) {
    if (!isTurnId(activityId)) {
      throw new Error(
        'The retention record contains an open turn that is not a canonical activity id.',
      )
    }
  }
  const retainedIds = new Set<string>()
  let previous: TerminalLedgerEntry | undefined
  for (const entry of document.retained) {
    if (!isTurnId(entry.activityId)) {
      throw new Error(
        'The retention record contains a finished turn that is not a canonical activity id.',
      )
    }
    if (!Number.isSafeInteger(entry.atMs)) {
      throw new Error(
        'The retention record contains a terminal time that is not a safe integer.',
      )
    }
    if (retainedIds.has(entry.activityId)) {
      throw new Error('The retention record contains a duplicate finished turn.')
    }
    if (previous && !endsBefore(previous, entry)) {
      throw new Error('The retention record is not in terminal order.')
    }
    retainedIds.add(entry.activityId)
    previous = entry
  }
  if (
    !Number.isSafeInteger(document.reconcileCursor) ||
    document.reconcileCursor < 0
  ) {
    throw new Error('The retention record contains an invalid reconciliation cursor.')
  }
}
