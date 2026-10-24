import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { ExecutionJournalEvent } from '../contracts/execution-journal.js'
import { publishPrivateFileAtomically } from './execution-journal.js'
import {
  ensureOwnedDirectory,
  openOwnedFileForAppend,
  openOwnedFileForRead,
  type OwnedFileRequest,
} from './owned-file.js'

/**
 * Rebuildable projection infrastructure (Phase 8 ADR §4, §9). A projection
 * is a derived compatibility view of the canonical journal; its metadata
 * records the last applied journal sequence and reducer version so recovery
 * can classify lag and rebuild deterministically.
 */

export const JOURNAL_PROJECTION_METADATA_SCHEMA_VERSION = 1

export interface JournalProjectionMetadata {
  readonly schemaVersion: 1
  readonly projectionId: string
  readonly reducerVersion: number
  readonly lastAppliedSequence: number
  readonly updatedAt: string
  /**
   * Lines this projection has written. Distinguishes "nothing has projected
   * yet" from "the view was deleted": only the latter needs a rebuild, and a
   * projection can legitimately advance its sequence while emitting no lines,
   * because canonical-only stages have no legacy counterpart.
   */
  readonly appliedLineCount?: number
}

export type ProjectionLagStatus =
  | 'absent'
  | 'current'
  | 'lagging'
  | 'rebuild-required'

/**
 * `journalLastSequence` is the highest sequence *this* projection derives
 * from, not the journal's last — a view is not behind because of events it
 * never projects (N31).
 *
 * Missing metadata is `absent` only when there is nothing to project. With
 * work waiting it is `lagging`: after a restart, a view whose every derive
 * failed has recorded nothing, and reporting that as `absent` would say "no
 * view is configured" when the truth is "the configured view has applied
 * nothing yet".
 */
export function classifyProjectionLag(
  metadata: JournalProjectionMetadata | undefined,
  journalLastSequence: number,
  expectedReducerVersion: number,
): ProjectionLagStatus {
  if (!metadata) return journalLastSequence > 0 ? 'lagging' : 'absent'
  if (metadata.reducerVersion !== expectedReducerVersion) {
    return 'rebuild-required'
  }
  if (metadata.lastAppliedSequence > journalLastSequence) {
    return 'rebuild-required'
  }
  if (metadata.lastAppliedSequence < journalLastSequence) return 'lagging'
  return 'current'
}

export const JOURNAL_PROJECTIONS_DIRECTORY_NAME = 'projections'

/** The private directory holding every projection's metadata for a journal. */
export function journalProjectionsDirectory(journal: {
  readonly journalDirectoryPath: string
}): string {
  return path.join(journal.journalDirectoryPath, JOURNAL_PROJECTIONS_DIRECTORY_NAME)
}

export interface JournalProjectionMetadataStoreOptions {
  readonly projectionId: string
  readonly reducerVersion: number
  readonly projectionDirectory: string
  /** Distinguishes per-entity projections that share one reducer. */
  readonly metadataFileName?: string
  readonly clock?: { readonly now: () => number }
}

/**
 * The metadata half of a projection: which journal sequence it last applied
 * and under which reducer version. Every projection — JSONL or structured
 * file — records it in this one shape so lag can be classified uniformly.
 */
export class JournalProjectionMetadataStore {
  protected readonly projectionId: string
  protected readonly reducerVersion: number
  private readonly projectionDirectory: string
  private readonly metadataFileName: string
  protected readonly clock: { readonly now: () => number }

  constructor(options: JournalProjectionMetadataStoreOptions) {
    this.projectionId = options.projectionId
    this.reducerVersion = options.reducerVersion
    this.projectionDirectory = options.projectionDirectory
    this.metadataFileName =
      options.metadataFileName ?? `${options.projectionId}.json`
    this.clock = options.clock ?? { now: () => Date.now() }
  }

  get metadataPath(): string {
    return path.join(this.projectionDirectory, this.metadataFileName)
  }

  async readMetadata(): Promise<JournalProjectionMetadata | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(this.metadataPath, 'utf8')
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (
      !isPlainRecord(parsed) ||
      parsed['schemaVersion'] !== JOURNAL_PROJECTION_METADATA_SCHEMA_VERSION ||
      parsed['projectionId'] !== this.projectionId ||
      typeof parsed['reducerVersion'] !== 'number' ||
      typeof parsed['lastAppliedSequence'] !== 'number' ||
      typeof parsed['updatedAt'] !== 'string'
    ) {
      return undefined
    }
    const appliedLineCount = parsed['appliedLineCount']
    return {
      schemaVersion: JOURNAL_PROJECTION_METADATA_SCHEMA_VERSION,
      projectionId: this.projectionId,
      reducerVersion: parsed['reducerVersion'],
      lastAppliedSequence: parsed['lastAppliedSequence'],
      updatedAt: parsed['updatedAt'],
      ...(typeof appliedLineCount === 'number' ? { appliedLineCount } : {}),
    }
  }

  async classifyLag(journalLastSequence: number): Promise<ProjectionLagStatus> {
    const metadata = await this.readMetadata()
    return classifyProjectionLag(metadata, journalLastSequence, this.reducerVersion)
  }

  async recordApplied(
    lastAppliedSequence: number,
    appliedLineCount?: number,
  ): Promise<void> {
    await fs.mkdir(this.projectionDirectory, { recursive: true })
    const metadata: JournalProjectionMetadata = {
      schemaVersion: JOURNAL_PROJECTION_METADATA_SCHEMA_VERSION,
      projectionId: this.projectionId,
      reducerVersion: this.reducerVersion,
      lastAppliedSequence,
      updatedAt: new Date(this.clock.now()).toISOString(),
      ...(appliedLineCount === undefined ? {} : { appliedLineCount }),
    }
    await publishPrivateFileAtomically(
      this.metadataPath,
      `${JSON.stringify(metadata)}\n`,
    )
  }
}

export interface JournalJsonlProjectionStoreOptions
  extends JournalProjectionMetadataStoreOptions {
  readonly targetPath: string
  /**
   * The directory `targetPath` must canonically live under.
   *
   * Required, not optional. This view is written into a workspace an agent can
   * write to, so every access to it is checked against a redirect; an optional
   * anchor would let a caller disable that by omission, which is the failure
   * mode worth designing out (AC20).
   */
  readonly targetContainerPath: string
}

export class JournalJsonlProjectionStore extends JournalProjectionMetadataStore {
  private readonly targetPath: string
  private readonly targetContainerPath: string
  private queueTail: Promise<unknown> = Promise.resolve()

  constructor(options: JournalJsonlProjectionStoreOptions) {
    super(options)
    this.targetPath = options.targetPath
    this.targetContainerPath = options.targetContainerPath
  }

  /** Every access to the derived view goes through this, never a bare path. */
  private get ownedTarget(): OwnedFileRequest {
    return {
      containerPath: this.targetContainerPath,
      filePath: this.targetPath,
    }
  }

  /**
   * Derives are serialised per store. Applying is read-then-write against a
   * shared file, so concurrent derives would otherwise overwrite each other
   * and lose records without any error surfacing.
   */
  applyEvents(
    events: readonly ExecutionJournalEvent[],
    lineFor: (event: ExecutionJournalEvent) => string | undefined,
  ): Promise<void> {
    const result = this.queueTail.then(() =>
      this.applySerialized(events, lineFor),
    )
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Apply events read back from the canonical journal, skipping lines the
   * view already holds.
   *
   * This is the recovery path, and it is deliberately not the append path.
   * A batch whose append failed is gone from memory, but the watermark did
   * not move — `recordApplied` runs only after a successful write — so the
   * journal still says exactly which events are missing. Reading forward from
   * the watermark is what makes recovery survive a process restart; the
   * in-memory buffer is only a latency optimisation.
   *
   * Lines the view already holds are skipped, and so are repeats inside the
   * batch. A crash between the append and the metadata write leaves lines
   * above the recorded watermark, and nothing classifies that state, so replay
   * would otherwise duplicate them. The skip is by line content: this view has
   * other writers, so a line count cannot tell our duplicate from someone
   * else's record, while each dispatch event projects to a unique canonical
   * line.
   */
  catchUp(
    events: readonly ExecutionJournalEvent[],
    lineFor: (event: ExecutionJournalEvent) => string | undefined,
  ): Promise<void> {
    const result = this.queueTail.then(() =>
      this.applySerialized(events, lineFor, { skipExistingLines: true }),
    )
    this.queueTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async applySerialized(
    events: readonly ExecutionJournalEvent[],
    lineFor: (event: ExecutionJournalEvent) => string | undefined,
    options: { readonly skipExistingLines?: boolean } = {},
  ): Promise<void> {
    if (events.length === 0) return
    const metadata = await this.readMetadata()
    if (metadata && metadata.reducerVersion !== this.reducerVersion) {
      throw new ProjectionRebuildRequiredError(this.projectionId)
    }
    const lastApplied = metadata?.lastAppliedSequence ?? 0
    const fresh = events
      .filter((event) => event.sequence > lastApplied)
      .sort((left, right) => left.sequence - right.sequence)
    if (fresh.length === 0) return

    // Metadata written before `appliedLineCount` existed carries no count.
    // Absent means *unknown*, not zero: assuming zero would skip the check
    // below and rebuild the view from here, dropping every historical record.
    const recordedLines = metadata?.appliedLineCount
    const mayHaveLines =
      recordedLines === undefined ? lastApplied > 0 : recordedLines > 0
    if (mayHaveLines) {
      // Only a view that may already hold lines can have lost them; a missing
      // file then means the records the metadata claims are gone. Opened
      // rather than stat'd, so a redirected view is refused here instead of
      // being reported as present (AC20).
      const existing = await openOwnedFileForRead(this.ownedTarget)
      if (!existing) throw new ProjectionRebuildRequiredError(this.projectionId)
      await existing.close()
    }
    const appliedLines = recordedLines ?? 0
    const existingLines = options.skipExistingLines
      ? await this.readTargetLines()
      : undefined
    const projected = fresh
      .map(lineFor)
      .filter((line): line is string => line !== undefined)

    const seen = new Set<string>()
    const toAppend: string[] = []
    // Lines already in the view, written by a run that failed before it could
    // record them. They are applied, so they are counted — leaving them out
    // would understate `appliedLineCount` and let a later deletion of the view
    // slip past the check above.
    let recognisedLines = 0
    for (const line of projected) {
      if (seen.has(line)) continue
      seen.add(line)
      if (existingLines?.has(line)) {
        recognisedLines += 1
        continue
      }
      toAppend.push(line)
    }

    const appendedLines = toAppend.map((line) => `${line}\n`).join('')
    const lastSequence = fresh[fresh.length - 1]?.sequence ?? lastApplied
    const newLineCount = toAppend.length
    if (appendedLines.length === 0) {
      await this.recordApplied(lastSequence, appliedLines + recognisedLines)
      return
    }
    const handle = await openOwnedFileForAppend(this.ownedTarget)
    try {
      await handle.writeFile(appendedLines, 'utf8')
    } finally {
      await handle.close()
    }
    // Metadata last, so a failed write never claims lines that are not there.
    // A crash between the two leaves the opposite: lines present above the
    // recorded watermark. Nothing classifies that — `classifyProjectionLag`
    // compares only sequence and reducer version, and the check above tests
    // the target's existence, not its contents — so it reads as ordinary lag.
    await this.recordApplied(
      lastSequence,
      appliedLines + newLineCount + recognisedLines,
    )
  }

  /**
   * The lines the view already holds, for identity-based skipping.
   *
   * Read through the same owned-file check as the append. A redirected view
   * would otherwise be *read* even where it could not be written, pulling an
   * external file's contents into the comparison (AC20).
   */
  private async readTargetLines(): Promise<ReadonlySet<string>> {
    const handle = await openOwnedFileForRead(this.ownedTarget)
    if (!handle) return new Set()
    try {
      const raw = await handle.readFile('utf8')
      return new Set(raw.split('\n').filter((line) => line.length > 0))
    } finally {
      await handle.close()
    }
  }

  async rebuild(
    events: readonly ExecutionJournalEvent[],
    lineFor: (event: ExecutionJournalEvent) => string | undefined,
  ): Promise<void> {
    const ordered = [...events].sort(
      (left, right) => left.sequence - right.sequence,
    )
    const body = ordered
      .map(lineFor)
      .filter((line): line is string => line !== undefined)
      .map((line) => `${line}\n`)
      .join('')
    await this.publish(body, ordered[ordered.length - 1]?.sequence ?? 0)
  }

  private async publish(
    body: string,
    lastAppliedSequence: number,
  ): Promise<void> {
    // A rebuild writes a temporary file beside the target and renames over it.
    // The rename replaces a symlinked *file* rather than following it, so that
    // shape cannot escape here — but a redirected parent directory takes both
    // the temporary write and the rename with it, so the directory is proven
    // before anything is written into it (AC20).
    await ensureOwnedDirectory(this.ownedTarget)
    await publishPrivateFileAtomically(this.targetPath, body)
    await this.recordApplied(
      lastAppliedSequence,
      body === '' ? 0 : body.split('\n').length - 1,
    )
  }
}

export class ProjectionRebuildRequiredError extends Error {
  constructor(readonly projectionId: string) {
    super(`Projection ${projectionId} requires a rebuild from the journal.`)
    this.name = 'ProjectionRebuildRequiredError'
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
