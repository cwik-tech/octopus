import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

import { writeFileAtomic } from '../core/file-mutation.js'
import { hasErrorCode } from '../core/node-errors.js'
import { logRuntimeEvent } from '../domains/runtime/logger.js'
import { ensureRunPrivateRuntimeDirectory } from '../domains/runtime/runtime-paths.js'

/**
 * What to do when an authoritative cancellation cannot reach the journal.
 *
 * Both cancel sites swallow the error, and that part is right: the fenced task
 * compare-and-set is the cancellation authority, and failing the caller's
 * request because a *journal* was unreachable would deny a cancellation that
 * has already happened. What is not right is discarding the fact. A journal
 * failure here means the durable record and the task record now disagree, and
 * nothing else in the system will notice (ADR §7, §9).
 *
 * So the swallow stays and the divergence is reported twice over:
 *
 * - a distinct runtime event, appended to the assignment's own event log, so
 *   the sequence of divergences is preserved with everything else that
 *   happened to that run; and
 * - a small record under the assignment's run-private runtime directory,
 *   holding the most recent divergence, which is what the operator report
 *   reads. It is an index, not a history: bounded, cheap to read during a
 *   workspace-wide walk, and last-writer-wins across the two sites, which is
 *   safe because both statements are true when both are written.
 *
 * Reporting a failure must never itself fail a caller, so everything here is
 * best effort and swallows its own errors.
 */

export const WORKFLOW_JOURNAL_DIVERGENCE_FILENAME = 'journal-divergence.json'

/** The distinct diagnostic, kept apart from `run.terminal_journal_repair_failed`. */
export const WORKFLOW_JOURNAL_DIVERGENCE_EVENT = 'workflow.journal_divergence'

const WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA_VERSION = 1

/**
 * The longest detail this writes, and the longest it will accept back.
 *
 * An error message is attacker-influenced in the ordinary sense that it can
 * carry a path, a tenant, or a provider response, so it is bounded on the way
 * in as well as on the way out. Bounding both keeps the file small by
 * construction rather than by hope.
 */
const MAX_DIVERGENCE_DETAIL_LENGTH = 2_000

/**
 * The largest divergence file that will be read at all.
 *
 * A record written by this build is a few hundred bytes. The cap exists for
 * the file this build did *not* write: the reader runs inside the activation
 * preflight's workspace-wide walk, so one oversized diagnostic must not be
 * able to exhaust it. It is applied before any content is read.
 */
const MAX_DIVERGENCE_FILE_BYTES = 64 * 1024

/** Which authoritative cancellation could not reach the journal. */
export const WORKFLOW_JOURNAL_DIVERGENCE_SITE_SCHEMA = z.enum([
  'task-cancellation',
  'terminal-reconciliation',
])

export type WorkflowJournalDivergenceSite = z.infer<
  typeof WORKFLOW_JOURNAL_DIVERGENCE_SITE_SCHEMA
>

/**
 * The record's shape, validated from `unknown` on every read.
 *
 * The schema is the source and the type is derived from it, so a field cannot
 * be added to one and forgotten in the other. `schemaVersion` is a literal on
 * purpose: a record written by a build this one does not know is refused, not
 * reconstructed as though it were this version. An earlier hand-written parser
 * dropped the version entirely, so a record claiming version 999 was reported
 * as a valid version 1.
 */
export const WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA = z.object({
  schemaVersion: z.literal(WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA_VERSION),
  taskId: z.string().min(1).max(512),
  site: WORKFLOW_JOURNAL_DIVERGENCE_SITE_SCHEMA,
  detail: z.string().max(MAX_DIVERGENCE_DETAIL_LENGTH),
  recordedAt: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'must be a timestamp',
    }),
})

export type WorkflowJournalDivergenceRecord = z.infer<
  typeof WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA
>

/**
 * What one assignment's divergence file says.
 *
 * `unreadable` is a third answer, distinct from both a record and absence: a
 * file exists and this build could not establish what it says. Reporting that
 * as "nothing diverged" would be the one mistake this whole boundary exists to
 * avoid, and it is the same rule the surrounding discovery already applies to
 * manifests and to traversals it cannot read.
 */
export type WorkflowJournalDivergenceRead =
  | { readonly kind: 'recorded'; readonly record: WorkflowJournalDivergenceRecord }
  | { readonly kind: 'unreadable'; readonly detail: string }

export function workflowJournalDivergencePath(assignmentPath: string): string {
  return path.join(
    assignmentPath,
    '.runtime',
    WORKFLOW_JOURNAL_DIVERGENCE_FILENAME,
  )
}

export async function reportWorkflowJournalDivergence(input: {
  readonly assignmentPath: string
  readonly taskId: string
  readonly site: WorkflowJournalDivergenceSite
  readonly error: unknown
  readonly now?: () => Date
}): Promise<void> {
  const recordedAt = (input.now?.() ?? new Date()).toISOString()
  const message =
    input.error instanceof Error ? input.error.message : String(input.error)
  const detail = message.slice(0, MAX_DIVERGENCE_DETAIL_LENGTH)

  try {
    logRuntimeEvent(input.assignmentPath, {
      event: WORKFLOW_JOURNAL_DIVERGENCE_EVENT,
      timestamp: recordedAt,
      assignment_path: input.assignmentPath,
      task_id: input.taskId,
      site: input.site,
      error: detail,
    })
  } catch {
    // An unwritable event log must not turn a reported divergence into a
    // thrown one; the record below is the operator report's copy.
  }

  try {
    ensureRunPrivateRuntimeDirectory(input.assignmentPath)
    const record: WorkflowJournalDivergenceRecord = {
      schemaVersion: WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA_VERSION,
      taskId: input.taskId.slice(0, 512),
      site: input.site,
      detail,
      recordedAt,
    }
    await writeFileAtomic(
      workflowJournalDivergencePath(input.assignmentPath),
      `${JSON.stringify(record, null, 2)}\n`,
    )
  } catch {
    // Best effort by contract. The runtime event above already recorded it.
  }
}

/**
 * The most recent divergence recorded for this assignment.
 *
 * `null` means absence, and `ENOENT` is the only thing that produces it.
 * Everything else — a symbolic link, a directory, a file owned by someone
 * else, a file too large to read, malformed JSON, a schema this build does not
 * know — is `unreadable`.
 *
 * The file is opened with `O_NOFOLLOW` rather than only `lstat`-ed, so the
 * refusal cannot be raced: an `lstat` that saw a regular file and an `open`
 * that followed a link swapped in afterwards would defeat the check entirely.
 * The size is taken from the open handle and enforced before any content is
 * read.
 */
export async function readWorkflowJournalDivergence(
  assignmentPath: string,
): Promise<WorkflowJournalDivergenceRead | null> {
  const recordPath = workflowJournalDivergencePath(assignmentPath)

  let entry: Awaited<ReturnType<typeof fs.lstat>>
  try {
    entry = await fs.lstat(recordPath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    return unreadable('the divergence record could not be examined')
  }
  if (entry.isSymbolicLink()) {
    return unreadable(
      'the divergence record is a symbolic link; a diagnostic reached through ' +
        'a link is decided by whoever controls the link target',
    )
  }
  if (!entry.isFile()) {
    return unreadable('the divergence record is not a regular file')
  }

  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    // O_NOFOLLOW closes the window between the check above and this open.
    handle = await fs.open(recordPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    return unreadable('the divergence record could not be opened')
  }

  try {
    const opened = await handle.stat()
    if (!opened.isFile()) {
      return unreadable('the divergence record is not a regular file')
    }
    if (currentUserId !== undefined && opened.uid !== currentUserId) {
      return unreadable('the divergence record is owned by another user')
    }
    if (opened.size > MAX_DIVERGENCE_FILE_BYTES) {
      return unreadable(
        `the divergence record is ${opened.size} bytes, over the ` +
          `${MAX_DIVERGENCE_FILE_BYTES}-byte limit, and was not read`,
      )
    }

    const buffer = Buffer.allocUnsafe(Number(opened.size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return parseDivergenceRecord(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch {
    return unreadable('the divergence record could not be read')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function parseDivergenceRecord(raw: string): WorkflowJournalDivergenceRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unreadable('the divergence record is not valid JSON')
  }
  const result = WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA.safeParse(parsed)
  if (!result.success) {
    return unreadable(
      `the divergence record does not match schema version ` +
        `${WORKFLOW_JOURNAL_DIVERGENCE_SCHEMA_VERSION}`,
    )
  }
  return { kind: 'recorded', record: result.data }
}

function unreadable(detail: string): WorkflowJournalDivergenceRead {
  return { kind: 'unreadable', detail }
}

/** `undefined` on platforms without POSIX ownership, where the check cannot apply. */
const currentUserId: number | undefined =
  typeof process.getuid === 'function' ? process.getuid() : undefined
