import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION,
  CAPABILITY_RESULT_MEDIA_TYPE,
  type CapabilityResultContentRead,
  type CapabilityResultContentReceipt,
  type CapabilityResultContentStore,
  type CapabilityResultContentWrite,
} from '../contracts/durable-dispatch.js'
import { publishPrivateFileExclusively } from '../core/execution-journal.js'
import { errorCodeOf, hasErrorCode } from '../core/node-errors.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../core/run-assignment-location.js'

/**
 * The assignment-owned store for exact capability results
 * (`docs/adr/2026-08-26-Execution-Journal-Content-Separation.md`).
 *
 * It sits beside the execution journal under the same private runtime
 * directory, never inside it. That placement is the whole design: the journal
 * directory can then be scanned byte by byte and shown to hold no result
 * content, while a recursive removal of the assignment still takes the results
 * with it, because both owners are below the same root.
 */
export const CAPABILITY_RESULTS_DIRECTORY_NAME = 'capability-results'

/**
 * How large a single retained result may be.
 *
 * A deliberate operational cap, not a restatement of an old one: the journal
 * receipt path this replaces had no bound at all, so a canonical result above
 * 32 MiB that a previous build would have stored is now refused, and its
 * dispatch reports `indeterminate` rather than retaining it. That is the
 * accepted tradeoff for bounding what one adapter can write into an
 * assignment's storage. Existing records above the bound are unaffected —
 * they are read back through the legacy path, which this constant does not
 * gate.
 *
 * Injectable so a test can observe the refusal without a 32 MiB fixture.
 */
export const MAX_CAPABILITY_RESULT_BYTES = 32 * 1024 * 1024

/** A content identity is the lowercase SHA-256 hex of the bytes it names. */
const CONTENT_ID_PATTERN = /^[a-f0-9]{64}$/

/**
 * How much one read pulls at a time. Memory then scales with the result being
 * read rather than with the largest one the store would accept.
 */
const READ_CHUNK_BYTES = 64 * 1024

export function capabilityResultsDirectoryPath(assignmentPath: string): string {
  return path.join(
    assignmentPath,
    RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
    CAPABILITY_RESULTS_DIRECTORY_NAME,
  )
}

export function createAssignmentCapabilityResultStore(input: {
  readonly assignmentPath: string
  readonly maxByteLength?: number
}): CapabilityResultContentStore {
  return new AssignmentCapabilityResultStore(
    input.assignmentPath,
    input.maxByteLength ?? MAX_CAPABILITY_RESULT_BYTES,
  )
}

/** A resolved store directory, or the reason there is nothing safe to read. */
type ResolvedStoreDirectory =
  | { readonly kind: 'directory'; readonly path: string }
  | CapabilityResultContentRead

class AssignmentCapabilityResultStore implements CapabilityResultContentStore {
  private readonly directoryPath: string

  constructor(
    private readonly assignmentPath: string,
    private readonly maxByteLength: number,
  ) {
    this.directoryPath = capabilityResultsDirectoryPath(assignmentPath)
  }

  /**
   * Store one canonical result and return the identity that names it.
   *
   * Content-addressed, so writing the same bytes again is the same file and
   * the same receipt. What that leaves is the tamper case: an identity whose
   * file no longer holds the bytes it names. Publishing over it would make the
   * store agree with whichever writer went last; refusing says the identity is
   * already spoken for by something else, which is what actually happened.
   *
   * The publication itself is a `link` onto an unused name, so it never opens
   * the destination and a symbolic link sitting there loses the race rather
   * than redirecting the write.
   */
  async write(canonical: string): Promise<CapabilityResultContentWrite> {
    const byteLength = Buffer.byteLength(canonical, 'utf8')
    if (byteLength > this.maxByteLength) {
      return { kind: 'too_large', byteLength, maxByteLength: this.maxByteLength }
    }
    const contentId = digestOf(canonical)
    try {
      const directory = await this.ensureDirectory()
      if (directory.kind !== 'directory') {
        return { kind: 'unavailable', reason: unsafeReasonOf(directory) }
      }
      const filePath = path.join(directory.path, contentFileName(contentId))
      const published = await publishPrivateFileExclusively(filePath, canonical)
      if (published) {
        return { kind: 'stored', receipt: receiptFor(contentId, byteLength) }
      }
      // The name was already taken — by an identical earlier write, by a
      // concurrent one, or by something that is not this content at all. The
      // bytes decide which, and only the first two are the same fact. Read
      // them without following a link, for the same reason `read` does not.
      const existing = await readFileNoFollow(filePath, this.maxByteLength)
      return existing.kind === 'text' && existing.text === canonical
        ? { kind: 'stored', receipt: receiptFor(contentId, byteLength) }
        : { kind: 'conflict', contentId }
    } catch (error) {
      return { kind: 'unavailable', reason: describeFault(error) }
    }
  }

  /**
   * Return the exact bytes a receipt names, or say precisely why it cannot.
   *
   * Every arm is a different fact about durable evidence: never written,
   * written and changed, written and unreadable, or reached through a path
   * that is no longer the store's own. A caller that saw one empty answer for
   * all of them would replay a tampered result as a missing one.
   */
  async read(
    receipt: CapabilityResultContentReceipt,
  ): Promise<CapabilityResultContentRead> {
    if (!isWellFormedReceipt(receipt)) {
      return { kind: 'mismatched', reason: 'receipt' }
    }
    let directory: ResolvedStoreDirectory
    try {
      directory = await this.resolveDirectoryForReading()
    } catch (error) {
      return { kind: 'unavailable', reason: describeFault(error) }
    }
    if (directory.kind !== 'directory') return directory

    const filePath = path.join(directory.path, contentFileName(receipt.contentId))
    // Opened, sized and read through one handle. A `lstat` followed by a
    // separate read would decide safety about a name and then read whatever
    // that name meant a moment later, which is the swap this has to survive.
    const read = await readFileNoFollow(filePath, this.maxByteLength)
    switch (read.kind) {
      case 'absent':
        return { kind: 'absent' }
      case 'symlink':
        return { kind: 'unsafe', reason: 'symlink' }
      case 'not-a-file':
        return { kind: 'unsafe', reason: 'not_a_file' }
      case 'relaxed-permissions':
        return { kind: 'unsafe', reason: 'permissions' }
      case 'over-bound':
        // The closed diagnostic deliberately coarsens two different causes
        // into one answer: content past this store's cap, and content whose
        // length disagrees with its receipt. A receipt and its file can agree
        // with each other and still both exceed the cap. The cap is an
        // implementation limit rather than a fact about the record, so it does
        // not earn an arm of its own in a contract callers switch on.
        return { kind: 'mismatched', reason: 'byte_length' }
      case 'unavailable':
        return { kind: 'unavailable', reason: read.reason }
      case 'text':
        break
    }
    if (Buffer.byteLength(read.text, 'utf8') !== receipt.byteLength) {
      return { kind: 'mismatched', reason: 'byte_length' }
    }
    if (digestOf(read.text) !== receipt.contentSha256) {
      return { kind: 'mismatched', reason: 'digest' }
    }
    return isJsonObjectText(read.text)
      ? { kind: 'content', canonical: read.text }
      : { kind: 'corrupt' }
  }

  private async ensureDirectory(): Promise<ResolvedStoreDirectory> {
    await fs.mkdir(this.directoryPath, { mode: 0o700, recursive: true })
    return this.resolveDirectoryForReading()
  }

  /**
   * A read path never provisions storage, so a missing store simply means the
   * content is not there. Containment is judged against the assignment root
   * this store belongs to, not against the store's own parent: a private
   * runtime directory replaced by a link satisfies "the store is inside its
   * parent" while putting both of them outside the assignment.
   */
  private async resolveDirectoryForReading(): Promise<ResolvedStoreDirectory> {
    let canonicalAssignment: string
    let canonicalStore: string
    try {
      canonicalAssignment = await fs.realpath(this.assignmentPath)
      canonicalStore = await fs.realpath(this.directoryPath)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { kind: 'absent' }
      throw error
    }
    if (
      canonicalStore !==
      path.join(
        canonicalAssignment,
        RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
        CAPABILITY_RESULTS_DIRECTORY_NAME,
      )
    ) {
      return { kind: 'unsafe', reason: 'escapes_store' }
    }
    const stat = await fs.lstat(canonicalStore)
    if (!stat.isDirectory()) return { kind: 'unsafe', reason: 'not_a_file' }
    if ((stat.mode & 0o077) !== 0) {
      return { kind: 'unsafe', reason: 'permissions' }
    }
    return { kind: 'directory', path: canonicalStore }
  }
}

type NoFollowRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'symlink' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'relaxed-permissions' }
  | { readonly kind: 'over-bound' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Read one file by name without ever traversing a symbolic link.
 *
 * `O_NOFOLLOW` makes the kernel refuse the open when the final component is a
 * link, so the decision and the read are the same operation. Everything after
 * that is judged through the handle rather than the name.
 */
async function readFileNoFollow(
  filePath: string,
  maxByteLength: number,
): Promise<NoFollowRead> {
  let handle
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
  } catch (error) {
    const code = errorCodeOf(error)
    if (code === 'ENOENT') return { kind: 'absent' }
    // A link at the final component. macOS and Linux both report `ELOOP`;
    // some platforms use `EMLINK` for exactly this refusal.
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'symlink' }
    if (code === 'EISDIR') return { kind: 'not-a-file' }
    return { kind: 'unavailable', reason: code ?? 'unknown' }
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return { kind: 'not-a-file' }
    // Judged through the handle, so this is the mode of the file that was
    // opened rather than of whatever the name means now.
    if ((stat.mode & 0o077) !== 0) return { kind: 'relaxed-permissions' }
    if (stat.size > maxByteLength) return { kind: 'over-bound' }
    // Read in chunks rather than into one buffer the size of the bound: the
    // bound is what a result may reach, not what an ordinary one costs, and
    // allocating it up front would pay the maximum on every replay of a
    // hundred-byte result. The bound is still enforced against the running
    // total rather than against the size taken above, because a file can grow
    // between the two — one byte past the bound ends the read without pulling
    // in the remainder.
    const chunks: Buffer[] = []
    let filled = 0
    for (;;) {
      const chunk = Buffer.alloc(
        Math.min(READ_CHUNK_BYTES, maxByteLength + 1 - filled),
      )
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, filled)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      filled += bytesRead
      if (filled > maxByteLength) return { kind: 'over-bound' }
    }
    return { kind: 'text', text: Buffer.concat(chunks, filled).toString('utf8') }
  } catch (error) {
    return { kind: 'unavailable', reason: describeFault(error) }
  } finally {
    await handle.close()
  }
}

function receiptFor(
  contentId: string,
  byteLength: number,
): CapabilityResultContentReceipt {
  return {
    contentId,
    contentSha256: contentId,
    byteLength,
    mediaType: CAPABILITY_RESULT_MEDIA_TYPE,
    resultSchemaVersion: CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION,
  }
}

function contentFileName(contentId: string): string {
  return `${contentId}.json`
}

function digestOf(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * A receipt may arrive from an operator's request body, so its own shape is
 * checked before it is allowed to name a path. A content id that is not a
 * digest is refused here rather than sanitized into one that is.
 */
function isWellFormedReceipt(receipt: CapabilityResultContentReceipt): boolean {
  return (
    CONTENT_ID_PATTERN.test(receipt.contentId) &&
    receipt.contentSha256 === receipt.contentId &&
    Number.isSafeInteger(receipt.byteLength) &&
    receipt.byteLength >= 0 &&
    receipt.mediaType === CAPABILITY_RESULT_MEDIA_TYPE &&
    receipt.resultSchemaVersion === CAPABILITY_RESULT_CONTENT_SCHEMA_VERSION
  )
}

/** A retained result is a JSON object; anything else is not one of ours. */
function isJsonObjectText(canonical: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(canonical)
  } catch {
    return false
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
}

/** Names why a resolved directory was refused, without naming its path. */
function unsafeReasonOf(resolved: CapabilityResultContentRead): string {
  return resolved.kind === 'unsafe' ? resolved.reason : resolved.kind
}

/** An error code, never a message: a message can carry a path. */
function describeFault(error: unknown): string {
  return errorCodeOf(error) ?? 'unknown'
}
