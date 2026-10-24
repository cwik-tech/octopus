import { constants as fsConstants, type Dir, type Dirent, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'

import { errorCodeOf } from '../../core/node-errors.js'
import { isPathEqualOrInside, isPathInside } from '../../core/path-safety.js'
import type {
  FolderDocument,
  FolderDocumentReadOptions,
  FolderDocumentReadResult,
} from './folder-index.js'

type FolderDocumentReadFailure = Extract<FolderDocumentReadResult, { readonly ok: false }>

/**
 * Reading inside an attached folder (docs/feature-local-folder-access.md,
 * "File eligibility: one policy for every access").
 *
 * Listing, reading and searching share one classification, and every call
 * applies it again. A walk that skips `.env` protects nothing on its own: the
 * agent can name `.env` directly, so the read is what refuses it.
 *
 * Paths from the agent are plain relative paths with `/` separators. They are
 * not URL-encoded, so a real file called `100% done.md` is an ordinary name.
 *
 * The saved root is a canonical path, and a path is only a name: a parent of
 * the folder swapped for a symlink sends the same string somewhere else while
 * every segment below it still looks ordinary to `lstat`. So each operation
 * resolves the root, every directory it reads and every entry it reports in
 * full and checks that the path still names that place, and a file is checked
 * again after it is open.
 *
 * Every operation also carries one budget, started before it touches the disk
 * and checked between directory entries and between read windows: a
 * cancellation, a deadline (a search's, or a folder map's) and an entry limit
 * all stop it part way.
 *
 * Documents (PDF, Office and OpenDocument files, RTF) are read as their parsed
 * text from the folder index, and only after their source file has passed
 * every check a text file does: the cache never adds access. The index answers
 * for the exact version just measured, so a changed document is never read as
 * its old text. A listing or a search only reports what the cache holds; a
 * read parses a document on demand and waits a bounded time for it.
 */

export const FOLDER_LARGE_TEXT_BYTES = 10 * 1024 * 1024
export const FOLDER_READ_MAX_BYTES = 24_000
export const FOLDER_LIST_MAX_ENTRIES = 500
export const FOLDER_LIST_MAX_DEPTH = 5
export const FOLDER_WALK_MAX_FILES = 5_000
/** Directory entries one operation may examine, hidden and excluded ones included. */
export const FOLDER_WALK_MAX_ENTRIES = 50_000
export const FOLDER_SEARCH_MAX_HITS = 20
export const FOLDER_SEARCH_MAX_SCAN_BYTES = 200 * 1024 * 1024
export const FOLDER_SEARCH_DEADLINE_MS = 5_000
const SNIPPET_MAX_CHARS = 300

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.tex', '.log', '.csv', '.tsv', '.json', '.jsonl',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env.example', '.xml', '.html', '.htm',
  '.css', '.scss', '.svg', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh',
  '.zsh', '.bash', '.sql', '.r', '.lua', '.pl', '.scala', '.dart', '.vue', '.svelte',
])

const KEY_FILE_PATTERNS = [/\.(?:pem|key|p12|pfx)$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)/i]

/**
 * A file's class under the eligibility policy. Documents are `pending` until
 * the index holds text for their current version, then `ready`; `oversized`,
 * `failed` and `over-budget` documents are never parsed and found by name only.
 */
export type FolderEntryStatus =
  | 'ready'
  | 'large-text'
  | 'unsupported'
  | 'pending'
  | 'oversized'
  | 'failed'
  | 'over-budget'

export interface FolderEntry {
  readonly path: string
  readonly kind: 'file' | 'folder'
  readonly size?: number
  readonly modifiedAt: string
  readonly status?: FolderEntryStatus
}

/**
 * The parsed text of documents, from the folder index. Every call names a
 * source file that folder access has just checked and measured.
 */
export interface FolderDocuments {
  /** Whether a file name is a document type the index parses. */
  isDocument(name: string): boolean
  /** Parse on demand when needed, waiting a bounded time. */
  readDocument(root: string, document: FolderDocument, options?: FolderDocumentReadOptions): Promise<FolderDocumentReadResult>
  /** Only what is already parsed for exactly this version; never parses or waits. */
  readCached(root: string, document: FolderDocument, options?: FolderDocumentReadOptions): Promise<FolderDocumentReadResult>
}

export interface FolderAccessContext {
  /** The folder's canonical path, as admitted when it was attached. */
  readonly root: string
  isProtected(absolutePath: string): Promise<boolean>
  /** Without it, documents are files of a type that can't be read. */
  readonly documents?: FolderDocuments | undefined
}

export type FolderAccessErrorCode =
  | 'folder_not_found'
  | 'folder_unreadable'
  | 'path_not_available'
  | 'path_unreadable'
  | 'file_unreadable'
  | 'not_a_file'
  | 'not_a_folder'
  | 'unsupported_type'
  | 'still_parsing'
  | 'oversized'
  | 'not_parsed'
  | 'cancelled'

export interface FolderAccessFailure {
  readonly ok: false
  readonly code: FolderAccessErrorCode
  readonly message: string
}

export type FolderReadResult =
  | {
      readonly ok: true
      readonly path: string
      readonly text: string
      readonly offset: number
      readonly totalBytes: number
      readonly nextOffset?: number
    }
  | FolderAccessFailure

export type FolderListResult =
  | {
      readonly ok: true
      readonly entries: readonly FolderEntry[]
      readonly nextCursor?: number
      /** Subfolders met on the way that could not be read, or not to their end. */
      readonly unreadableFolders: readonly string[]
      /** Files met on the way that could not be measured. */
      readonly unreadableFiles: readonly string[]
      /** The entry limit stopped the listing before it was complete. */
      readonly partial: boolean
    }
  | FolderAccessFailure

export interface FolderSearchHit {
  readonly path: string
  /** 1-based line of the first match in the text, or 0 for a file-name match. */
  readonly line: number
  readonly snippet: string
  /** A document matched by name whose current version is not parsed yet. */
  readonly pending?: boolean
}

export type FolderSearchResult =
  | {
      readonly ok: true
      readonly hits: readonly FolderSearchHit[]
      /** A limit or the deadline stopped the search before every file was read. */
      readonly partial: boolean
      readonly searchedFiles: number
      readonly eligibleFiles: number
      /** Documents whose parsed text was searched. */
      readonly searchedDocuments: number
      /** Documents in scope, parsed or not. */
      readonly eligibleDocuments: number
      /** Documents the search met whose current version is not parsed yet. */
      readonly pendingDocuments: number
      /** Subfolders in scope whose files could not be searched because they can't be read. */
      readonly unreadableFolders: readonly string[]
      /** Text files in scope that could not be searched because they can't be measured or opened. */
      readonly unreadableFiles: readonly string[]
    }
  | FolderAccessFailure

export type FolderWalkResult =
  | {
      readonly ok: true
      readonly files: readonly FolderEntry[]
      readonly folders: readonly FolderEntry[]
      /** A limit or the deadline stopped the walk before it was complete. */
      readonly truncated: boolean
      /** The deadline was what stopped it. */
      readonly deadlineReached: boolean
      /** Subfolders met on the way that could not be read, or not to their end. */
      readonly unreadableFolders: readonly string[]
      /** Files met on the way that could not be measured. */
      readonly unreadableFiles: readonly string[]
    }
  | FolderAccessFailure

export type FolderWalk = Extract<FolderWalkResult, { readonly ok: true }>

/** The time and bytes a search may spend; each defaults to the documented limit. */
export interface FolderSearchLimits {
  readonly maxScanBytes?: number
  readonly deadlineMs?: number
  readonly now?: () => number
}

const MESSAGES: Record<FolderAccessErrorCode, string> = {
  folder_not_found: 'Folder not found at its saved path.',
  folder_unreadable: "Can't read folder.",
  path_not_available: 'This path is not available.',
  path_unreadable: "This folder can't be read.",
  file_unreadable: "This file can't be read.",
  not_a_file: 'This path is a folder, not a file.',
  not_a_folder: 'This path is not a folder.',
  unsupported_type: "This file type can't be read.",
  still_parsing: 'Still parsing; try again shortly.',
  oversized: 'This document is too large to read.',
  not_parsed: "This document wasn't parsed: the folder reached its parsing limit.",
  cancelled: 'Cancelled before it finished.',
}

function failure(code: FolderAccessErrorCode): FolderAccessFailure {
  return { ok: false, code, message: MESSAGES[code] }
}

export function classifyFile(name: string, size: number): FolderEntryStatus {
  if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) return 'unsupported'
  return size > FOLDER_LARGE_TEXT_BYTES ? 'large-text' : 'ready'
}

/**
 * A file's class as a walk sees it. A document is `pending` here, because
 * only the index knows whether its current version is parsed; a listing asks.
 */
function classifyEntry(context: FolderAccessContext, name: string, size: number): FolderEntryStatus {
  return context.documents?.isDocument(name) ? 'pending' : classifyFile(name, size)
}

/** How the index's answer for a document reads as a tool failure. */
const DOCUMENT_FAILURES: Record<FolderDocumentReadFailure['code'], FolderAccessErrorCode> = {
  still_parsing: 'still_parsing',
  pending: 'still_parsing',
  oversized: 'oversized',
  over_budget: 'not_parsed',
  failed: 'file_unreadable',
  unavailable: 'path_not_available',
  cancelled: 'cancelled',
}

/** A document's state for a listing, by the index's answer for its current version. */
const DOCUMENT_STATUSES: Record<FolderDocumentReadFailure['code'], FolderEntryStatus> = {
  still_parsing: 'pending',
  pending: 'pending',
  oversized: 'oversized',
  over_budget: 'over-budget',
  failed: 'failed',
  unavailable: 'failed',
  cancelled: 'pending',
}

/**
 * A name as a volume that ignores case and Unicode normalization compares it.
 * APFS on macOS opens `NODE_MODULES`, and even `node_module` with a long s
 * (U+017F), as `node_modules`, so the rules judge the folded name.
 */
function foldName(name: string): string {
  return name.normalize('NFC').toUpperCase().toLowerCase()
}

function isExcludedName(name: string, isDirectory: boolean): boolean {
  const folded = foldName(name)
  if (folded.startsWith('.') || folded === 'node_modules') return true
  return !isDirectory && KEY_FILE_PATTERNS.some((pattern) => pattern.test(folded))
}

function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' &&
    !segment.includes('\\') && !segment.includes('\0')
}

function toSegments(relativePath: string): string[] | null {
  const trimmed = relativePath.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '.') return []
  if (trimmed.startsWith('/') || path.isAbsolute(trimmed)) return null
  const segments = trimmed.split('/')
  return segments.every(isPlainSegment) ? segments : null
}

/** Why an operation stops before its next step: the caller cancelled, or its deadline passed. */
type BudgetStop = 'cancelled' | 'deadline'

/** A time an operation must stop by, shared by every folder one call covers. */
export interface FolderDeadline {
  expired(): boolean
}

/**
 * The time and bytes one search call may spend, started before it touches the
 * disk. A call over several folders shares one, so ten folders get the same
 * 200 MB and 5 seconds as one.
 */
export class FolderSearchBudget implements FolderDeadline {
  private readonly now: () => number
  private readonly deadline: number
  private readonly maxBytes: number
  private scannedBytes = 0

  constructor(limits: FolderSearchLimits = {}) {
    this.now = limits.now ?? Date.now
    this.deadline = this.now() + (limits.deadlineMs ?? FOLDER_SEARCH_DEADLINE_MS)
    this.maxBytes = limits.maxScanBytes ?? FOLDER_SEARCH_MAX_SCAN_BYTES
  }

  expired(): boolean {
    return this.now() > this.deadline
  }

  /** Whether `length` more bytes stay within the scan limit. */
  fits(length: number): boolean {
    return this.scannedBytes + length <= this.maxBytes
  }

  /** Bytes the scan limit still allows. */
  remaining(): number {
    return Math.max(0, this.maxBytes - this.scannedBytes)
  }

  spend(bytes: number): void {
    this.scannedBytes += bytes
  }
}

/** One operation's limits, started before it touches the disk. */
export class OperationBudget {
  private entriesLeft: number

  constructor(private readonly limits: {
    readonly signal?: AbortSignal | undefined
    /** A search's or a folder map's deadline; other operations have none. */
    readonly deadline?: FolderDeadline | undefined
    readonly maxEntries?: number | undefined
  }) {
    this.entriesLeft = limits.maxEntries ?? FOLDER_WALK_MAX_ENTRIES
  }

  /** Why the operation must stop before its next step, or null to go on. */
  check(): BudgetStop | null {
    if (this.limits.signal?.aborted) return 'cancelled'
    return this.limits.deadline?.expired() ? 'deadline' : null
  }

  /** Spend one directory entry; false once none are left. */
  takeEntry(): boolean {
    if (this.entriesLeft <= 0) return false
    this.entriesLeft -= 1
    return true
  }
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

type DirectoryLocation =
  | { readonly kind: 'inside'; readonly identity: FileIdentity }
  | { readonly kind: 'gone' | 'outside' | 'unreadable' }

/** Errors that mean the path no longer leads to a directory, rather than one that can't be read. */
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])

function failureKind(error: unknown): 'gone' | 'unreadable' {
  const code = errorCodeOf(error)
  return code !== undefined && GONE_CODES.has(code) ? 'gone' : 'unreadable'
}

/** Errors that mean permissions refused an eligible path, rather than that the path leads nowhere. */
const DENIED_CODES = new Set(['EACCES', 'EPERM'])

function isDenied(error: unknown): boolean {
  const code = errorCodeOf(error)
  return code !== undefined && DENIED_CODES.has(code)
}

/**
 * Whether a fully resolved path is the entry the call named: inside the root
 * exactly, and below it different at most in case or normalization, the way
 * APFS answers a name typed another way. Being somewhere inside the root is
 * not enough: a subfolder swapped for a symlink to `.git` stays inside it.
 */
function isSameEntry(root: string, real: string, expected: string): boolean {
  if (!isPathEqualOrInside(root, real)) return false
  return real === expected || foldName(path.relative(root, real)) === foldName(path.relative(root, expected))
}

/** Where a directory really is, with every symlink on the way resolved: the directory its path names, or not. */
async function locateDirectory(root: string, directory: string): Promise<DirectoryLocation> {
  let real: string
  try {
    real = await fs.realpath(directory)
  } catch (error) {
    return { kind: failureKind(error) }
  }
  if (!isSameEntry(root, real, directory)) return { kind: 'outside' }
  const stat = await fs.lstat(real).catch(() => null)
  return stat?.isDirectory() ? { kind: 'inside', identity: { dev: stat.dev, ino: stat.ino } } : { kind: 'gone' }
}

/**
 * The folder itself, checked at the start of every operation: a directory,
 * still at its canonical path with no symlink anywhere above it, and readable.
 */
async function checkRoot(context: FolderAccessContext): Promise<FolderAccessFailure | null> {
  const located = await locateDirectory(context.root, context.root)
  if (located.kind === 'unreadable') return failure('folder_unreadable')
  if (located.kind !== 'inside') return failure('folder_not_found')
  return await isSearchable(context.root) ? null : failure('folder_unreadable')
}

/**
 * The folder itself, as a status shows it, without walking it: at its saved
 * path with no symlink above it and readable, or moved away, or unreadable.
 */
export async function folderRootState(root: string): Promise<'available' | 'not_found' | 'unreadable'> {
  const failed = await checkRoot({ root, isProtected: async () => false })
  if (!failed) return 'available'
  return failed.code === 'folder_unreadable' ? 'unreadable' : 'not_found'
}

/** Whether a directory's names can be listed and looked up: read and search permission both. */
async function isSearchable(directory: string): Promise<boolean> {
  return fs.access(directory, fsConstants.R_OK | fsConstants.X_OK).then(() => true, () => false)
}

/**
 * Resolve a relative path one segment at a time.
 *
 * Every segment is checked with `lstat`, so a symlink anywhere below the root
 * is refused rather than followed, and every segment is checked against the
 * exclusion rules and the protected areas. `lstat` cannot see above the root:
 * `checkRoot` covers the folder's parents, and `openInsideRoot` checks the file
 * again once it is open.
 *
 * `unreadable` means a folder on the way, already found eligible, can't be
 * entered. The answer is the same whatever the next name is, so it says
 * nothing about what lies inside.
 */
async function resolveEntry(
  context: FolderAccessContext,
  segments: readonly string[],
): Promise<{ readonly absolutePath: string; readonly isDirectory: boolean; readonly size: number; readonly dev: number; readonly ino: number } | 'unreadable' | null> {
  let current = context.root
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) return null
    const isLast = index === segments.length - 1
    current = path.join(current, segment)
    let stat: Stats
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      return isDenied(error) ? 'unreadable' : null
    }
    if (stat.isSymbolicLink()) return null
    // Folders and regular files only: opening a named pipe waits for a writer.
    if (!stat.isDirectory() && !stat.isFile()) return null
    if (isExcludedName(segment, stat.isDirectory())) return null
    if (!isPathInside(context.root, current)) return null
    if (await context.isProtected(current)) return null
    if (!isLast && !stat.isDirectory()) return null
    if (isLast) {
      return { absolutePath: current, isDirectory: stat.isDirectory(), size: stat.size, dev: stat.dev, ino: stat.ino }
    }
  }
  return null
}

/** The largest prefix of `buffer[0, length)` that ends on a UTF-8 character boundary. */
function completeUtf8Length(buffer: Buffer, length: number): number {
  let index = length - 1
  let continuation = 0
  while (index >= 0 && continuation < 3 && ((buffer[index] ?? 0) & 0xc0) === 0x80) {
    index -= 1
    continuation += 1
  }
  if (index < 0) return length
  const lead = buffer[index] ?? 0
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return length - index >= needed ? length : index
}

/**
 * Whether a path, resolved in full, still names itself, with no symlink or
 * swapped folder on the way, and leads to the file or folder that was measured.
 */
async function isStillAt(root: string, absolutePath: string, measured: FileIdentity): Promise<boolean> {
  const real = await fs.realpath(absolutePath).catch(() => null)
  if (real === null || !isSameEntry(root, real, absolutePath)) return false
  const named = await fs.lstat(real).catch(() => null)
  return named !== null && sameIdentity(named, measured)
}

/**
 * Open a resolved file and prove the open landed on the file its path names.
 *
 * O_NOFOLLOW guards only the last segment, and the identity taken while
 * resolving is only as good as that walk. So once the file is open, its path
 * is resolved in full and must name itself and lead to the very file that is
 * open. A swap before the open moves the resolved path elsewhere, outside the
 * root or into a hidden folder; a swap and swap back leaves the open file
 * somewhere the path no longer leads.
 *
 * `unreadable` is a file its permissions refuse, and only while its path still
 * leads to the file that was measured.
 */
async function openInsideRoot(
  context: FolderAccessContext,
  entry: FileIdentity & { readonly absolutePath: string },
): Promise<{ readonly handle: FileHandle; readonly size: number } | 'unreadable' | null> {
  let handle: FileHandle
  try {
    // O_NONBLOCK: a file swapped for a named pipe since it was resolved would
    // otherwise hold this call, and a thread of Node's file pool, until a writer
    // came. Reads of a regular file ignore the flag.
    handle = await fs.open(
      entry.absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    )
  } catch (error) {
    return isDenied(error) && await isStillAt(context.root, entry.absolutePath, entry) ? 'unreadable' : null
  }
  let verified = false
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(opened, entry)) return null
    if (!await isStillAt(context.root, entry.absolutePath, opened)) return null
    verified = true
    return { handle, size: opened.size }
  } finally {
    if (!verified) await handle.close()
  }
}

/**
 * A document's version, measured through a handle checked exactly as a read
 * of a text file is, and its path spelled as the disk stores it, so a name
 * typed in another letter case or Unicode form reaches the same cache entry.
 */
async function measureDocument(
  context: FolderAccessContext,
  entry: FileIdentity & { readonly absolutePath: string },
): Promise<FolderDocument | 'unreadable' | null> {
  const opened = await openInsideRoot(context, entry)
  if (opened === 'unreadable' || opened === null) return opened
  try {
    const stat = await opened.handle.stat()
    const real = await fs.realpath(entry.absolutePath).catch(() => null)
    if (real === null || !isPathInside(context.root, real)) return null
    return {
      path: path.relative(context.root, real).split(path.sep).join('/'),
      size: stat.size,
      mtimeMs: stat.mtime.getTime(),
    }
  } finally {
    await opened.handle.close()
  }
}

async function readWindow(
  handle: FileHandle,
  totalBytes: number,
  offset: number,
  maxBytes: number,
): Promise<{ readonly text: string; readonly consumed: number }> {
  if (offset >= totalBytes) return { text: '', consumed: 0 }
  const buffer = Buffer.alloc(Math.min(maxBytes, totalBytes - offset))
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
  let start = 0
  // An offset chosen by the agent may land inside a character; skip to the next one.
  while (start < bytesRead && start < 3 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1
  const atEnd = offset + bytesRead >= totalBytes
  const end = atEnd ? bytesRead : completeUtf8Length(buffer, bytesRead)
  const safeEnd = end <= start ? bytesRead : end
  return { text: buffer.toString('utf8', start, safeEnd), consumed: safeEnd }
}

export async function readFolderFile(
  context: FolderAccessContext,
  relativePath: string,
  options: { readonly offset?: number; readonly maxBytes?: number; readonly signal?: AbortSignal | undefined } = {},
): Promise<FolderReadResult> {
  if (options.signal?.aborted) return failure('cancelled')
  const rootFailure = await checkRoot(context)
  if (rootFailure) return rootFailure
  const segments = toSegments(relativePath)
  if (!segments || segments.length === 0) return failure('path_not_available')
  const entry = await resolveEntry(context, segments)
  if (entry === 'unreadable') return failure('path_unreadable')
  if (!entry) return failure('path_not_available')
  if (entry.isDirectory) return failure('not_a_file')
  const name = segments[segments.length - 1] ?? ''
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const maxBytes = Math.max(4, Math.min(FOLDER_READ_MAX_BYTES, Math.floor(options.maxBytes ?? FOLDER_READ_MAX_BYTES)))
  if (context.documents?.isDocument(name)) {
    return readDocumentFile(context, context.documents, entry, segments.join('/'), { offset, maxBytes, signal: options.signal })
  }
  if (classifyFile(name, entry.size) === 'unsupported') return failure('unsupported_type')
  const opened = await openInsideRoot(context, entry)
  if (opened === 'unreadable') return failure('file_unreadable')
  if (!opened) return failure('path_not_available')
  try {
    // The last point before any content leaves the disk.
    if (options.signal?.aborted) return failure('cancelled')
    const window = await readWindow(opened.handle, opened.size, offset, maxBytes)
    const next = offset + window.consumed
    return {
      ok: true,
      path: segments.join('/'),
      text: window.text,
      offset,
      totalBytes: opened.size,
      ...(window.consumed > 0 && next < opened.size ? { nextOffset: next } : {}),
    }
  } finally {
    await opened.handle.close()
  }
}

/**
 * A document's parsed text, read only once its source file has passed every
 * check a text file does. The index parses on demand when the cache has no
 * text for this version, and waits a bounded time for it.
 */
async function readDocumentFile(
  context: FolderAccessContext,
  documents: FolderDocuments,
  entry: FileIdentity & { readonly absolutePath: string },
  requestedPath: string,
  options: { readonly offset: number; readonly maxBytes: number; readonly signal?: AbortSignal | undefined },
): Promise<FolderReadResult> {
  const measured = await measureDocument(context, entry)
  if (measured === 'unreadable') return failure('file_unreadable')
  if (!measured) return failure('path_not_available')
  if (options.signal?.aborted) return failure('cancelled')
  const read = await documents.readDocument(context.root, measured, options)
  if (!read.ok) return failure(DOCUMENT_FAILURES[read.code])
  return {
    ok: true,
    path: requestedPath,
    text: read.text,
    offset: read.offset,
    totalBytes: read.totalBytes,
    ...(read.nextOffset === undefined ? {} : { nextOffset: read.nextOffset }),
  }
}

type DirectoryListing =
  | {
      readonly kind: 'listed'
      readonly identity: FileIdentity
      readonly dirents: readonly Dirent[]
      /** The entry budget ran out before the directory was read to its end. */
      readonly truncated: boolean
    }
  | { readonly kind: 'gone' | 'outside' | 'unreadable' | BudgetStop }

/** One directory's entries, sorted, read only once it is located inside the root and within the entry budget. */
async function readDirectory(root: string, directory: string, budget: OperationBudget): Promise<DirectoryListing> {
  const located = await locateDirectory(root, directory)
  if (located.kind !== 'inside') return { kind: located.kind }
  let handle: Dir
  try {
    // Read permission alone lists the names, but without search permission
    // not one entry can be measured, and the folder would look empty.
    await fs.access(directory, fsConstants.R_OK | fsConstants.X_OK)
    handle = await fs.opendir(directory)
  } catch (error) {
    return { kind: failureKind(error) }
  }
  let read: DirectoryEntries<Dirent>
  try {
    read = await readDirectoryEntries(handle, budget)
  } catch (error) {
    return { kind: failureKind(error) }
  } finally {
    await handle.close().catch(() => undefined)
  }
  if (read.kind !== 'read') return { kind: read.kind }
  const dirents = [...read.entries].sort((left, right) => left.name.localeCompare(right.name))
  return { kind: 'listed', identity: located.identity, dirents, truncated: read.truncated }
}

type DirectoryEntries<T> =
  | {
      readonly kind: 'read'
      readonly entries: readonly T[]
      /** The entry budget ran out before the directory was read to its end. */
      readonly truncated: boolean
    }
  | { readonly kind: BudgetStop }

/**
 * The entries of an open directory, one at a time, within the entry budget.
 * The budget is checked before each one is kept, so a cancellation or a passed
 * deadline stops the read at the next entry, not after fifty thousand.
 */
export async function readDirectoryEntries<T>(
  directory: { read(): Promise<T | null> },
  budget: OperationBudget,
): Promise<DirectoryEntries<T>> {
  const entries: T[] = []
  for (let entry = await directory.read(); entry !== null; entry = await directory.read()) {
    const stop = budget.check()
    if (stop) return { kind: stop }
    if (!budget.takeEntry()) return { kind: 'read', entries, truncated: true }
    entries.push(entry)
  }
  return { kind: 'read', entries, truncated: false }
}

type EntryCheck =
  | { readonly kind: 'eligible'; readonly entry: FolderEntry }
  /** Excluded, protected, not a folder or regular file, or removed since its directory was read. */
  | { readonly kind: 'skipped' }
  /** The directory refused to look the name up: it was locked after it was read. */
  | { readonly kind: 'directory_unreadable' }
  /** The entry is there but can't be measured, such as one whose path is longer than the system can name. */
  | { readonly kind: 'entry_unreadable'; readonly path: string; readonly isDirectory: boolean }

const SKIPPED: EntryCheck = { kind: 'skipped' }

/** One directory entry as the agent may see it, or why it is not shown. */
async function eligibleEntry(
  context: FolderAccessContext,
  directory: string,
  relativeDirectory: string,
  dirent: Dirent,
): Promise<EntryCheck> {
  if (dirent.isSymbolicLink()) return SKIPPED
  const isDirectory = dirent.isDirectory()
  if (!isDirectory && !dirent.isFile()) return SKIPPED
  if (isExcludedName(dirent.name, isDirectory)) return SKIPPED
  const absolutePath = path.join(directory, dirent.name)
  if (await context.isProtected(absolutePath)) return SKIPPED
  const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name
  let stat: Stats
  try {
    stat = await fs.lstat(absolutePath)
  } catch (error) {
    // Removed since the directory was read, so nothing is missing; a directory
    // that moved is caught when it is located again after its entries.
    if (failureKind(error) === 'gone') return SKIPPED
    // Looking a name up needs search permission on the directory, so a refusal
    // means the directory itself was locked after it was read.
    if (isDenied(error)) return { kind: 'directory_unreadable' }
    return { kind: 'entry_unreadable', path: relativePath, isDirectory }
  }
  // Still the kind of entry the directory listed: a file swapped for a named
  // pipe since then is no file, and a symlink is neither.
  if (isDirectory ? !stat.isDirectory() : !stat.isFile()) return SKIPPED
  // `lstat` went through every parent by name. A parent swapped out and back
  // around it measured a file elsewhere, which checking the folder before and
  // after its entries cannot see.
  if (!await isStillAt(context.root, absolutePath, stat)) return SKIPPED
  return {
    kind: 'eligible',
    entry: isDirectory
      ? { path: relativePath, kind: 'folder', modifiedAt: stat.mtime.toISOString() }
      : {
          path: relativePath,
          kind: 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          status: classifyEntry(context, dirent.name, stat.size),
        },
  }
}

/**
 * How a traversal ended. `stopped` is the visitor asking to stop; `limit` is
 * the entry limit. `unreadable` and `gone` describe the starting directory
 * only: below it, a folder that can't be read to its end is recorded instead.
 */
type TraversalEnd = 'complete' | 'stopped' | 'limit' | BudgetStop | 'outside' | 'unreadable' | 'gone'

/** What a traversal met but could not read, by path relative to the folder. */
interface Unreadable {
  readonly folders: string[]
  readonly files: string[]
}

/** Remove, in place, every item whose path lies below `folder`. */
function dropBelow<T>(items: T[], folder: string, pathOf: (item: T) => string): void {
  let kept = 0
  for (const item of items) {
    if (pathOf(item).startsWith(`${folder}/`)) continue
    items[kept] = item
    kept += 1
  }
  items.length = kept
}

/** Visit eligible entries depth first, in name order, checking the budget between entries. */
async function traverse(input: {
  readonly context: FolderAccessContext
  readonly budget: OperationBudget
  readonly start: string
  readonly startRelative: string
  readonly maxDepth: number
  readonly unreadable: Unreadable
  /** Called for each eligible entry; false stops the traversal. */
  readonly visit: (entry: FolderEntry) => boolean
  /** Forget what `visit` was given from below `folder`, a folder that was not read to its end. */
  readonly forget: (folder: string) => void
}): Promise<TraversalEnd> {
  const { unreadable } = input
  const walkDirectory = async (directory: string, relativeDirectory: string, level: number): Promise<TraversalEnd> => {
    const listing = await readDirectory(input.context.root, directory, input.budget)
    if (listing.kind !== 'listed') return listing.kind
    let end: TraversalEnd = listing.truncated ? 'limit' : 'complete'
    for (const dirent of listing.dirents) {
      const stop = input.budget.check()
      if (stop) {
        end = stop
        break
      }
      const checked = await eligibleEntry(input.context, directory, relativeDirectory, dirent)
      if (checked.kind === 'skipped') continue
      if (checked.kind === 'directory_unreadable') {
        end = 'unreadable'
        break
      }
      if (checked.kind === 'entry_unreadable') {
        (checked.isDirectory ? unreadable.folders : unreadable.files).push(checked.path)
        continue
      }
      const { entry } = checked
      if (!input.visit(entry)) {
        end = 'stopped'
        break
      }
      if (entry.kind !== 'folder' || level >= input.maxDepth) continue
      const inner = await walkDirectory(path.join(directory, dirent.name), entry.path, level + 1)
      if (inner === 'unreadable' || inner === 'gone') {
        // Locked, moved or removed before it was read to its end: what it gave
        // is not what it holds, so only its name stays, marked unreadable.
        input.forget(entry.path)
        dropBelow(unreadable.folders, entry.path, (folder) => folder)
        dropBelow(unreadable.files, entry.path, (file) => file)
        unreadable.folders.push(entry.path)
      } else if (inner !== 'complete') {
        end = inner
        break
      }
    }
    if (end === 'cancelled' || end === 'outside') return end
    // Located again once its entries are done: a directory swapped while it
    // was being read is not trusted for what it returned, and one moved away
    // or locked meanwhile held more than the entries read before.
    const after = await locateDirectory(input.context.root, directory)
    if (after.kind !== 'inside') return after.kind
    if (!sameIdentity(after.identity, listing.identity)) return 'outside'
    return await isSearchable(directory) ? end : 'unreadable'
  }
  return walkDirectory(input.start, input.startRelative, 1)
}

/** The absolute path of the folder a listing or search starts from, or why there is none. */
async function resolveFolder(context: FolderAccessContext, segments: readonly string[]): Promise<string | FolderAccessFailure> {
  if (segments.length === 0) return context.root
  const entry = await resolveEntry(context, segments)
  if (entry === 'unreadable') return failure('path_unreadable')
  if (!entry) return failure('path_not_available')
  return entry.isDirectory ? entry.absolutePath : failure('not_a_folder')
}

/** The failure a traversal's end stands for, or null when what it gathered can be returned. */
function traversalFailure(end: TraversalEnd, atRoot: boolean): FolderAccessFailure | null {
  if (end === 'cancelled') return failure('cancelled')
  if (end === 'outside') return failure('folder_not_found')
  if (end === 'unreadable') return failure(atRoot ? 'folder_unreadable' : 'path_unreadable')
  if (end === 'gone') return failure(atRoot ? 'folder_not_found' : 'path_not_available')
  return null
}

export async function listFolder(
  context: FolderAccessContext,
  relativePath: string,
  options: {
    readonly depth?: number
    readonly cursor?: number
    readonly limit?: number
    readonly maxEntries?: number
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<FolderListResult> {
  const budget = new OperationBudget({ signal: options.signal, maxEntries: options.maxEntries })
  if (budget.check() === 'cancelled') return failure('cancelled')
  const rootFailure = await checkRoot(context)
  if (rootFailure) return rootFailure
  const segments = toSegments(relativePath)
  if (!segments) return failure('path_not_available')
  const start = await resolveFolder(context, segments)
  if (typeof start !== 'string') return start
  const depth = Math.max(1, Math.min(FOLDER_LIST_MAX_DEPTH, Math.floor(options.depth ?? 1)))
  const cursor = Math.max(0, Math.floor(options.cursor ?? 0))
  const limit = Math.max(1, Math.min(FOLDER_LIST_MAX_ENTRIES, Math.floor(options.limit ?? FOLDER_LIST_MAX_ENTRIES)))
  const wanted = cursor + limit + 1
  const collected: FolderEntry[] = []
  const unreadable: Unreadable = { folders: [], files: [] }
  const end = await traverse({
    context,
    budget,
    start,
    startRelative: segments.join('/'),
    maxDepth: depth,
    unreadable,
    visit: (entry) => {
      if (collected.length >= wanted) return false
      collected.push(entry)
      return true
    },
    forget: (folder) => dropBelow(collected, folder, (entry) => entry.path),
  })
  const failed = traversalFailure(end, segments.length === 0)
  if (failed) return failed
  const page: FolderEntry[] = []
  for (const entry of collected.slice(cursor, cursor + limit)) {
    if (budget.check() === 'cancelled') return failure('cancelled')
    page.push(await withDocumentStatus(context, entry))
  }
  return {
    ok: true,
    entries: page,
    ...(collected.length > cursor + limit ? { nextCursor: cursor + limit } : {}),
    unreadableFolders: unreadable.folders,
    unreadableFiles: unreadable.files,
    partial: end === 'limit',
  }
}

/**
 * A listed document with the index's state for the version the listing
 * measured. A listing never parses; it only reports what the cache holds.
 */
async function withDocumentStatus(context: FolderAccessContext, entry: FolderEntry): Promise<FolderEntry> {
  const documents = context.documents
  if (!documents || entry.kind !== 'file' || entry.status !== 'pending') return entry
  const cached = await documents.readCached(
    context.root,
    { path: entry.path, size: entry.size ?? 0, mtimeMs: Date.parse(entry.modifiedAt) },
    { maxBytes: 4 },
  )
  return { ...entry, status: cached.ok ? 'ready' : DOCUMENT_STATUSES[cached.code] }
}

/** Every eligible file and folder, depth first, up to the file and entry limits and the deadline, if any. */
export async function walkFolder(
  context: FolderAccessContext,
  options: {
    readonly maxFiles?: number
    readonly maxEntries?: number
    readonly signal?: AbortSignal | undefined
    /** A time the walk stops by, such as the one a turn's folder map shares across its folders. */
    readonly deadline?: FolderDeadline
  } = {},
): Promise<FolderWalkResult> {
  const budget = new OperationBudget({ signal: options.signal, deadline: options.deadline, maxEntries: options.maxEntries })
  if (budget.check() === 'cancelled') return failure('cancelled')
  const rootFailure = await checkRoot(context)
  if (rootFailure) return rootFailure
  return walkWithin(context, budget, options.maxFiles ?? FOLDER_WALK_MAX_FILES, context.root, '')
}

/** Walk below `start`, a folder already resolved inside a root that was checked. */
async function walkWithin(
  context: FolderAccessContext,
  budget: OperationBudget,
  maxFiles: number,
  start: string,
  startRelative: string,
): Promise<FolderWalkResult> {
  const files: FolderEntry[] = []
  const folders: FolderEntry[] = []
  const unreadable: Unreadable = { folders: [], files: [] }
  const end = await traverse({
    context,
    budget,
    start,
    startRelative,
    maxDepth: Number.POSITIVE_INFINITY,
    unreadable,
    visit: (entry) => {
      if (entry.kind === 'folder') {
        folders.push(entry)
        return true
      }
      if (files.length >= maxFiles) return false
      files.push(entry)
      return true
    },
    forget: (folder) => {
      dropBelow(files, folder, (entry) => entry.path)
      dropBelow(folders, folder, (entry) => entry.path)
    },
  })
  const failed = traversalFailure(end, startRelative === '')
  if (failed) return failed
  return {
    ok: true,
    files,
    folders,
    truncated: end === 'stopped' || end === 'limit' || end === 'deadline',
    deadlineReached: end === 'deadline',
    unreadableFolders: unreadable.folders,
    unreadableFiles: unreadable.files,
  }
}

export async function searchFolder(
  context: FolderAccessContext,
  query: string,
  options: FolderSearchLimits & {
    readonly pathPrefix?: string
    readonly maxHits?: number
    readonly maxEntries?: number
    /** Shared by every folder one search call covers; without it the search starts its own. */
    readonly budget?: FolderSearchBudget
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<FolderSearchResult> {
  // One budget for the whole search, started before the walk: listing a large
  // tree spends the same seconds that reading it does.
  const search = options.budget ?? new FolderSearchBudget(options)
  const budget = new OperationBudget({ signal: options.signal, deadline: search, maxEntries: options.maxEntries })
  if (budget.check() === 'cancelled') return failure('cancelled')
  const rootFailure = await checkRoot(context)
  if (rootFailure) return rootFailure
  // The scope is resolved the way a listing resolves its path: one that is
  // missing or can't be entered is an answer of its own, never "no matches".
  const segments = toSegments(options.pathPrefix ?? '')
  if (!segments) return failure('path_not_available')
  const start = await resolveFolder(context, segments)
  if (typeof start !== 'string') return start
  const walked = await walkWithin(context, budget, FOLDER_WALK_MAX_FILES, start, segments.join('/'))
  if (!walked.ok) return walked
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  const { unreadableFolders } = walked
  const documents = context.documents
  const isDocument = (file: string): boolean => documents?.isDocument(path.posix.basename(file)) ?? false
  const eligibleFiles = walked.files.filter((file) => file.status === 'ready').length
  const eligibleDocuments = walked.files.filter((file) => isDocument(file.path)).length
  // Text files and documents the walk could not even measure can't be searched either.
  const unreadableFiles = walked.unreadableFiles.filter((file) => classifyEntry(context, file, 0) !== 'unsupported')
  if (terms.length === 0) {
    return {
      ok: true, hits: [], partial: false, searchedFiles: 0, eligibleFiles,
      searchedDocuments: 0, eligibleDocuments, pendingDocuments: 0, unreadableFolders, unreadableFiles,
    }
  }
  const scored: ScoredHit[] = []
  let searchedFiles = 0
  let searchedDocuments = 0
  let pendingDocuments = 0
  let partial = walked.truncated
  for (const file of walked.files) {
    const lowerPath = file.path.toLowerCase()
    const nameMatches = terms.every((term) => lowerPath.includes(term))
    const nameHit: ScoredHit = { path: file.path, line: 0, snippet: '(file name match)', score: 1_000_000 }
    const asDocument = documents !== undefined && isDocument(file.path)
    if (!asDocument && file.status !== 'ready') {
      if (nameMatches) scored.push(nameHit)
      continue
    }
    const read = documents !== undefined && asDocument
      ? await readDocumentWithin(context, documents, file.path, budget, search)
      : await readTextWithin(context, file.path, budget, search)
    if (read.kind === 'cancelled') return failure('cancelled')
    if (read.kind === 'limit' || read.kind === 'deadline') {
      partial = true
      break
    }
    if (read.kind === 'unreadable') {
      unreadableFiles.push(file.path)
      continue
    }
    if (read.kind === 'skipped') continue
    if (read.kind === 'pending') {
      // Never the text of an older version: the document is named, flagged, and counted.
      pendingDocuments += 1
      if (nameMatches) scored.push({ ...nameHit, snippet: '(changed, re-indexing)', pending: true })
      continue
    }
    if (read.kind === 'name_only') {
      if (nameMatches) scored.push(nameHit)
      continue
    }
    if (asDocument) searchedDocuments += 1
    else searchedFiles += 1
    const hit = scoreText(file.path, read.text, terms, nameMatches)
    if (hit) scored.push(hit)
  }
  // Checked again once the reads are done: files that vanished because the
  // folder itself was moved away or locked leave no answer, not an empty one.
  const rootAfter = await checkRoot(context)
  if (rootAfter) return rootAfter
  const hits = scored
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, options.maxHits ?? FOLDER_SEARCH_MAX_HITS)
    .map(({ score: _score, ...hit }) => hit)
  return {
    ok: true, hits, partial, searchedFiles, eligibleFiles,
    searchedDocuments, eligibleDocuments, pendingDocuments, unreadableFolders, unreadableFiles,
  }
}

type ScoredHit = FolderSearchHit & { readonly score: number }

/** A hit for a file whose text contains every term, or whose path supplies the rest; null when it does not match. */
function scoreText(filePath: string, text: string, terms: readonly string[], nameMatches: boolean): ScoredHit | null {
  const lowerPath = filePath.toLowerCase()
  const lower = text.toLowerCase()
  if (!terms.every((term) => lower.includes(term) || lowerPath.includes(term))) return null
  const occurrences = terms.reduce((sum, term) => sum + countOccurrences(lower, term), 0)
  const firstIndex = Math.min(...terms.map((term) => {
    const found = lower.indexOf(term)
    return found === -1 ? Number.POSITIVE_INFINITY : found
  }))
  const hit = Number.isFinite(firstIndex)
    ? lineHit(filePath, text, firstIndex)
    : { path: filePath, line: 0, snippet: '(file name match)' }
  return { ...hit, score: occurrences + (nameMatches ? 1_000_000 : 0) }
}

type TextRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'limit' }
  /** A document whose current version is not parsed yet. */
  | { readonly kind: 'pending' }
  /** A document that is never parsed, such as an oversized one: searched by name only. */
  | { readonly kind: 'name_only' }

/**
 * The parsed text of one document for a search, from the cache only: a search
 * never parses and never waits. The source file is resolved and opened first,
 * exactly as a text file is, and the cache answers only for the version that
 * handle measured. Every byte read counts against the scan limit, and no
 * window asks for more than the limit has left.
 */
async function readDocumentWithin(
  context: FolderAccessContext,
  documents: FolderDocuments,
  relativePath: string,
  budget: OperationBudget,
  search: FolderSearchBudget,
): Promise<TextRead> {
  const stop = budget.check()
  if (stop) return { kind: stop }
  const segments = toSegments(relativePath)
  const entry = segments && segments.length > 0 ? await resolveEntry(context, segments) : null
  if (entry === 'unreadable') return { kind: 'unreadable' }
  if (!entry || entry.isDirectory) return { kind: 'skipped' }
  const measured = await measureDocument(context, entry)
  if (measured === 'unreadable') return { kind: 'unreadable' }
  if (!measured) return { kind: 'skipped' }
  const parts: string[] = []
  let offset = 0
  for (;;) {
    const stopped = budget.check()
    if (stopped) return { kind: stopped }
    const room = Math.min(FOLDER_READ_MAX_BYTES, search.remaining())
    if (room < 4) return { kind: 'limit' }
    const read = await documents.readCached(context.root, measured, { offset, maxBytes: room })
    if (!read.ok) return read.code === 'pending' ? { kind: 'pending' } : { kind: 'name_only' }
    const next = read.nextOffset ?? read.totalBytes
    search.spend(Math.max(0, next - offset))
    parts.push(read.text)
    if (read.nextOffset === undefined) return { kind: 'text', text: parts.join('') }
    offset = read.nextOffset
  }
}

/**
 * The whole text of one file for a search, read window by window from one
 * open handle. The budget is checked before every window and every byte read
 * counts against the scan limit, because the size the walk measured is not
 * trusted: the file may have grown since.
 */
async function readTextWithin(
  context: FolderAccessContext,
  relativePath: string,
  budget: OperationBudget,
  search: FolderSearchBudget,
): Promise<TextRead> {
  const stop = budget.check()
  if (stop) return { kind: stop }
  const segments = toSegments(relativePath)
  const entry = segments && segments.length > 0 ? await resolveEntry(context, segments) : null
  if (entry === 'unreadable') return { kind: 'unreadable' }
  if (!entry || entry.isDirectory) return { kind: 'skipped' }
  const opened = await openInsideRoot(context, entry)
  if (opened === 'unreadable') return { kind: 'unreadable' }
  if (!opened) return { kind: 'skipped' }
  try {
    if (opened.size > FOLDER_LARGE_TEXT_BYTES) return { kind: 'skipped' }
    const chunks: Buffer[] = []
    let position = 0
    while (position < opened.size) {
      const stopped = budget.check()
      if (stopped) return { kind: stopped }
      const length = Math.min(FOLDER_READ_MAX_BYTES, opened.size - position)
      if (!search.fits(length)) return { kind: 'limit' }
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await opened.handle.read(buffer, 0, length, position)
      if (bytesRead === 0) break
      search.spend(bytesRead)
      position += bytesRead
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return { kind: 'text', text: Buffer.concat(chunks).toString('utf8') }
  } finally {
    await opened.handle.close()
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function lineHit(filePath: string, text: string, index: number): FolderSearchHit {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  const lineEndIndex = text.indexOf('\n', index)
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex
  const line = text.slice(0, lineStart).split('\n').length
  const whole = text.slice(lineStart, lineEnd).trim()
  return {
    path: filePath,
    line,
    snippet: whole.length <= SNIPPET_MAX_CHARS ? whole : `${whole.slice(0, SNIPPET_MAX_CHARS)}…`,
  }
}
