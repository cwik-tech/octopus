import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'

import { writeFileAtomic } from '../../core/file-mutation.js'
import type { FileParserLauncher } from '../../core/file-parser-launcher.js'
import { errorCodeOf } from '../../core/node-errors.js'
import { isPathEqualOrInside, isPathInside } from '../../core/path-safety.js'
import { FOLDER_READ_MAX_BYTES } from './folder-access.js'
import { FolderParseQueue, waitAtMost, type WaitLimit } from './folder-parse-queue.js'

/**
 * The document cache of attached folders (docs/feature-local-folder-access.md,
 * "Indexing and the parse cache").
 *
 * Documents in a user's folder are parsed into the app workspace, never next
 * to themselves:
 *
 *   <workspace>/folder-index/<folderKey>/
 *     manifest.json                    path -> version, state, generation
 *     files/<fileKey>/generation-<n>/  one parse of one document version
 *     tmp/                             parses not yet published
 *
 * `folderKey` hashes the canonical root and `fileKey` the root-relative path,
 * so two documents with the same name in different subfolders never share an
 * output folder. Neither is ever taken from a caller.
 *
 * The cache never adds access. Every read names the document's version
 * (size and modification time) as the caller measured it just now, after the
 * turn's scope, the grant, path containment and eligibility checks passed for
 * that file, and text is returned only for exactly that version. So a changed
 * document reads as "still parsing", never as its old text.
 *
 * A parse reads a copy, never the folder: the document is opened without
 * following a symlink, checked to be the file its full path names, and copied
 * through that handle into a temporary folder in the cache. The parser runs
 * local-only on the copy and writes beside it. Publishing re-checks that the
 * source is unchanged, that the job is still the document's current one, and
 * that the folder still has its grant and an attachment, then renames the
 * output into a new generation and writes the manifest through a temporary
 * file. Generations only go up, and a parse that lost any of those checks is
 * thrown away, so a late parse of an older version or of a deleted document
 * never comes back.
 */

export const FOLDER_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf',
])
/** A larger document is `oversized`: listed, never parsed, never read. */
export const FOLDER_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024
/** Document bytes one folder may have parsed; documents beyond it stay unparsed. */
export const FOLDER_INPUT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024
/** Parsed output one folder may keep; once a parse would pass it, parsing stops. */
export const FOLDER_OUTPUT_BUDGET_BYTES = 1024 * 1024 * 1024
/** How long `readDocument` waits for a parse before answering "still parsing". */
export const FOLDER_READ_WAIT_MS = 60_000

/** Whether a file name is a document type the folder index parses. */
export function isFolderDocument(name: string): boolean {
  return FOLDER_DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/**
 * A document's version: its size, and its modification time in whole
 * milliseconds, as `Stats.mtime.getTime()` or `Date.parse(FolderEntry.modifiedAt)`
 * gives it.
 */
export interface DocumentVersion {
  readonly size: number
  readonly mtimeMs: number
}

/**
 * A document as the caller measured it. `path` is relative to the folder root,
 * `/`-separated, with each name exactly as read from disk: a path spelled
 * another way, in another letter case or Unicode form, is refused.
 */
export interface FolderDocument extends DocumentVersion {
  readonly path: string
}

/** One scan of a folder's documents, in walk order. */
export interface FolderDocumentScan {
  readonly documents: readonly FolderDocument[]
  /**
   * The walk reached the whole folder. Only then are documents missing from
   * it dropped; a walk stopped by a limit keeps what it did not reach.
   */
  readonly complete: boolean
}

export type FolderDocumentErrorCode =
  /** `readDocument` waited its limit and the parse goes on. */
  | 'still_parsing'
  /** `readCached` only: this version is not parsed yet. */
  | 'pending'
  | 'oversized'
  /** The folder's input or output budget stopped this document being parsed. */
  | 'over_budget'
  /** The parser could not read this version. It is not parsed again until it changes. */
  | 'failed'
  /** Not a document path inside a folder the index can serve. */
  | 'unavailable'
  | 'cancelled'

export type FolderDocumentReadResult =
  | {
      readonly ok: true
      readonly path: string
      readonly text: string
      /** Byte offset of `text` in the parsed text. */
      readonly offset: number
      readonly totalBytes: number
      readonly nextOffset?: number
    }
  | {
      readonly ok: false
      readonly code: FolderDocumentErrorCode
      readonly message: string
    }

export interface FolderDocumentReadOptions {
  readonly offset?: number
  /** At most FOLDER_READ_MAX_BYTES. */
  readonly maxBytes?: number
  /** `readDocument` only: the turn's cancellation. Stops the wait, not the parse. */
  readonly signal?: AbortSignal | undefined
}

/** What the index knows of a folder, for `sharedFolderStatusSchema`. */
export interface FolderIndexStatus {
  /** Documents waiting for a parse: new, changed, or interrupted by a restart. */
  readonly pendingDocuments: number
  /** Set when a budget stopped parsing: which one, in plain words. */
  readonly limit?: string
}

export interface FolderIndexLimits {
  readonly maxDocumentBytes: number
  readonly maxInputBytesPerFolder: number
  readonly maxOutputBytesPerFolder: number
  readonly readWaitMs: number
}

/** The job outcome every parse settles with. */
export type FolderParseOutcome = 'published' | 'failed' | 'over_budget' | 'changed' | 'gone' | 'discarded'

export interface FolderIndexOptions {
  /** The app workspace. The cache is `<workspacePath>/folder-index/`. */
  readonly workspacePath: string
  /** Called with `localOnly: true` for every parse. */
  readonly launcher: FileParserLauncher
  /**
   * Whether the folder's grant still exists and some chat or project still
   * attaches it. Asked before every publish and, at startup, for every cached
   * folder.
   */
  readonly isRetained: (root: string) => Promise<boolean>
  /** One queue for the app, so at most two parses run at once. Default: a new one. */
  readonly queue?: FolderParseQueue<FolderParseOutcome>
  readonly limits?: Partial<FolderIndexLimits>
  /** How `readDocument` measures its wait. Default: a real timer. */
  readonly waitLimit?: WaitLimit
}

const MESSAGES: Record<FolderDocumentErrorCode, string> = {
  still_parsing: 'Still parsing; try again shortly.',
  pending: 'This document has not been parsed yet.',
  oversized: 'This document is too large to read.',
  over_budget: "This document wasn't parsed: the folder reached its parsing limit.",
  failed: "This file can't be read.",
  unavailable: 'This path is not available.',
  cancelled: 'Cancelled before it finished.',
}

function failure(code: FolderDocumentErrorCode): FolderDocumentReadResult {
  return { ok: false, code, message: MESSAGES[code] }
}

const versionSchema = z.strictObject({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().int(),
})

const entrySchema = z.strictObject({
  path: z.string().min(1).max(4096),
  version: versionSchema,
  state: z.enum(['pending', 'ready', 'failed', 'oversized', 'over_budget']),
  budget: z.enum(['input', 'output']).optional(),
  /** The highest generation ever published for this path. */
  generation: z.number().int().nonnegative(),
  /** The output of that generation, while it exists. */
  published: z.strictObject({
    version: versionSchema,
    textFile: z.string().min(1).max(4096),
    outputBytes: z.number().int().nonnegative(),
  }).optional(),
})

const manifestSchema = z.strictObject({
  version: z.literal(1),
  root: z.string().min(1),
  outputLimitReached: z.boolean(),
  entries: z.array(entrySchema),
})

/** The parser's own `_manifest.json`, as far as the index reads it. */
const parserManifestSchema = z.object({
  files: z.array(z.object({
    status: z.string(),
    outputs: z.record(z.string(), z.string()),
  })),
})

type EntryState = z.infer<typeof entrySchema>['state']
type PublishedText = NonNullable<z.infer<typeof entrySchema>['published']>

class ActiveJob {
  done: Promise<FolderParseOutcome> = Promise.resolve('discarded')

  constructor(readonly key: string, readonly version: DocumentVersion) {}
}

interface Entry {
  readonly path: string
  readonly fileKey: string
  version: DocumentVersion
  state: EntryState
  budget?: 'input' | 'output' | undefined
  generation: number
  published?: PublishedText | undefined
  job?: ActiveJob | undefined
}

interface FolderState {
  readonly root: string
  readonly key: string
  readonly dir: string
  readonly entries: Map<string, Entry>
  outputLimitReached: boolean
  dropped: boolean
  /** The manifest as last read or written, so an unchanged scan writes nothing. */
  lastWritten: string
  /** Changes to this folder's entries and manifest run one at a time. */
  tail: Promise<void>
}

type Snapshot =
  | {
      readonly kind: 'copied'
      readonly file: string
      readonly version: DocumentVersion
      readonly dev: number
      readonly ino: number
    }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'changed' }

type ParserOutput =
  | { readonly kind: 'parsed'; readonly textFile: string; readonly outputBytes: number }
  | { readonly kind: 'failed' }

function hashKey(kind: string, value: string): string {
  return createHash('sha256').update(kind).update('\0').update(value).digest('hex').slice(0, 32)
}

function sameVersion(left: DocumentVersion, right: DocumentVersion): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

function versionOf(document: DocumentVersion): DocumentVersion {
  return { size: document.size, mtimeMs: document.mtimeMs }
}

function isPlainSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' &&
    !segment.includes('\\') && !segment.includes('\0')
}

/** The path's names, when it is a plain relative path: no `..`, no absolute start, no empty name. */
function segmentsOf(relativePath: string): string[] | null {
  if (relativePath.length === 0 || relativePath.length > 4096 || path.isAbsolute(relativePath)) return null
  const segments = relativePath.split('/')
  return segments.every(isPlainSegment) ? segments : null
}

function isDocumentPath(relativePath: string): boolean {
  return segmentsOf(relativePath) !== null && isFolderDocument(relativePath)
}

function isVersion(document: DocumentVersion): boolean {
  return Number.isSafeInteger(document.size) && document.size >= 0 && Number.isSafeInteger(document.mtimeMs)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function formatBytes(bytes: number): string {
  const units: Array<[number, string]> = [[1024 ** 3, 'GB'], [1024 ** 2, 'MB'], [1024, 'KB']]
  for (const [size, unit] of units) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size} ${unit}`
  }
  return `${bytes} bytes`
}

export class FolderIndex {
  private readonly limits: FolderIndexLimits
  private readonly queue: FolderParseQueue<FolderParseOutcome>
  private readonly waitLimit: WaitLimit | undefined
  private readonly folders = new Map<string, Promise<FolderState | null>>()
  /** Folders being dropped; loading one waits until its cache is gone. */
  private readonly dropping = new Map<string, Promise<void>>()
  private indexRootPath: Promise<string> | undefined

  constructor(private readonly options: FolderIndexOptions) {
    this.limits = {
      maxDocumentBytes: options.limits?.maxDocumentBytes ?? FOLDER_DOCUMENT_MAX_BYTES,
      maxInputBytesPerFolder: options.limits?.maxInputBytesPerFolder ?? FOLDER_INPUT_BUDGET_BYTES,
      maxOutputBytesPerFolder: options.limits?.maxOutputBytesPerFolder ?? FOLDER_OUTPUT_BUDGET_BYTES,
      readWaitMs: options.limits?.readWaitMs ?? FOLDER_READ_WAIT_MS,
    }
    this.queue = options.queue ?? new FolderParseQueue<FolderParseOutcome>()
    this.waitLimit = options.waitLimit
  }

  /**
   * At app start: delete the cache of every folder that lost its grant or its
   * last attachment, and for the rest delete unfinished parses, drop outputs
   * nothing refers to, and send entries whose output is missing back to pending.
   */
  async startup(): Promise<void> {
    const indexRoot = await this.indexRoot()
    const names = await fs.readdir(indexRoot).catch(() => [])
    for (const name of names) {
      const directory = path.join(indexRoot, name)
      const root = await readManifestRoot(directory)
      if (root === null || hashKey('folder', root) !== name || !await this.options.isRetained(root)) {
        await fs.rm(directory, { recursive: true, force: true })
        continue
      }
      await this.folderState(root)
    }
  }

  /**
   * Bring the index in line with a scan of the folder, as each turn does:
   * new documents and changed ones go to pending and are queued for a
   * background parse, and documents it did not find are dropped with their
   * cached text. A scan that stopped part way did not see the whole folder,
   * so a document it missed is dropped only once it is gone from disk.
   * Returns without waiting for any parse.
   *
   * A folder no longer kept is left alone, so a turn that began before it
   * lost its grant or its last attachment parses nothing and writes nothing.
   */
  async reconcile(root: string, scan: FolderDocumentScan): Promise<void> {
    const state = await this.folderState(root)
    if (!state) return
    await this.serialize(state, async () => {
      if (state.dropped || !await this.options.isRetained(state.root)) return
      const listed = new Map<string, FolderDocument>()
      for (const document of scan.documents) {
        if (isDocumentPath(document.path) && isVersion(document)) listed.set(document.path, document)
      }
      const removed: Entry[] = []
      for (const entry of state.entries.values()) {
        if (listed.has(entry.path)) continue
        if (scan.complete || await isGoneFromDisk(state.root, entry.path)) removed.push(entry)
      }
      for (const entry of removed) this.forget(state, entry)
      for (const document of listed.values()) {
        const entry = state.entries.get(document.path)
        if (!entry) state.entries.set(document.path, newEntry(document))
        else if (!sameVersion(entry.version, document)) this.changeVersion(entry, document)
      }
      this.admit(state, [...listed.keys()])
      await this.writeManifest(state)
      for (const entry of removed) await fs.rm(this.fileDirectory(state, entry), { recursive: true, force: true })
      for (const documentPath of listed.keys()) {
        const entry = state.entries.get(documentPath)
        // Background parses: the turn does not wait for them.
        if (entry) void this.schedule(state, entry, false)
      }
    })
  }

  /**
   * The parsed text of exactly this document version, from `offset`. A
   * version not yet parsed is parsed now, ahead of the folder's queue, and
   * the read waits up to FOLDER_READ_WAIT_MS for it before answering
   * `still_parsing`; the parse goes on either way.
   *
   * The caller has just measured `document` through the turn's scope, grant,
   * containment and eligibility checks.
   */
  async readDocument(
    root: string,
    document: FolderDocument,
    options: FolderDocumentReadOptions = {},
  ): Promise<FolderDocumentReadResult> {
    if (options.signal?.aborted) return failure('cancelled')
    const cached = await this.readCached(root, document, options)
    if (cached.ok || cached.code !== 'pending') return cached
    const state = await this.folderState(root)
    if (!state) return failure('unavailable')
    const admitted = await this.serialize(state, () => this.admitForRead(state, document))
    if (admitted.kind === 'refused') return failure(admitted.code)
    const waited = await waitAtMost(
      admitted.done.catch((): FolderParseOutcome => 'discarded'),
      this.limits.readWaitMs,
      { signal: options.signal, ...(this.waitLimit ? { limit: this.waitLimit } : {}) },
    )
    if (waited.kind === 'cancelled') return failure('cancelled')
    if (waited.kind === 'waited_out') return failure('still_parsing')
    if (waited.value === 'gone') return failure('unavailable')
    const after = await this.readCached(root, document, options)
    return after.ok || after.code !== 'pending' ? after : failure('still_parsing')
  }

  /**
   * The parsed text of exactly this document version, if the cache has it,
   * without parsing or waiting: for search, which flags `pending` documents.
   * The caller's checks are the same as for `readDocument`.
   */
  async readCached(
    root: string,
    document: FolderDocument,
    options: FolderDocumentReadOptions = {},
  ): Promise<FolderDocumentReadResult> {
    if (!isDocumentPath(document.path) || !isVersion(document)) return failure('unavailable')
    const state = await this.folderState(root)
    if (!state) return failure('unavailable')
    if (document.size > this.limits.maxDocumentBytes) return failure('oversized')
    const entry = state.entries.get(document.path)
    if (!entry) return failure('pending')
    const published = entry.published
    if (published && sameVersion(published.version, document)) {
      const offset = Math.max(0, Math.floor(options.offset ?? 0))
      const maxBytes = Math.max(4, Math.min(FOLDER_READ_MAX_BYTES, Math.floor(options.maxBytes ?? FOLDER_READ_MAX_BYTES)))
      const textFile = this.textPath(state, entry, published)
      const window = textFile === null ? null : await readTextWindow(textFile, offset, maxBytes)
      if (window === null) return failure('pending')
      const next = offset + window.consumed
      return {
        ok: true,
        path: document.path,
        text: window.text,
        offset,
        totalBytes: window.totalBytes,
        ...(window.consumed > 0 && next < window.totalBytes ? { nextOffset: next } : {}),
      }
    }
    if (sameVersion(entry.version, document) && entry.state !== 'pending' && entry.state !== 'ready') {
      return failure(entry.state)
    }
    return failure('pending')
  }

  async status(root: string): Promise<FolderIndexStatus> {
    const state = await this.folderState(root)
    if (!state) return { pendingDocuments: 0 }
    let pendingDocuments = 0
    let inputLimit = false
    let outputLimit = state.outputLimitReached
    for (const entry of state.entries.values()) {
      if (entry.state === 'pending') pendingDocuments += 1
      if (entry.state === 'over_budget') {
        inputLimit ||= entry.budget === 'input'
        outputLimit ||= entry.budget === 'output'
      }
    }
    const limits = [
      ...(inputLimit ? [`Documents past ${formatBytes(this.limits.maxInputBytesPerFolder)} were not parsed.`] : []),
      ...(outputLimit ? [`Parsing stopped at ${formatBytes(this.limits.maxOutputBytesPerFolder)} of parsed text.`] : []),
    ]
    return { pendingDocuments, ...(limits.length > 0 ? { limit: limits.join(' ') } : {}) }
  }

  /**
   * Retention: the folder's last attachment was removed or its grant revoked.
   * Its queued parses are dropped, its running ones aborted, and once they
   * have settled its cache folder is deleted.
   */
  async dropFolder(root: string): Promise<void> {
    const key = hashKey('folder', root)
    const previous = this.dropping.get(key)
    const drop = (async () => {
      await previous
      const loading = this.folders.get(key)
      this.folders.delete(key)
      const state = await loading?.catch(() => null)
      if (state) await this.serialize(state, async () => { state.dropped = true })
      await this.queue.cancelFolder(key)
      await fs.rm(path.join(await this.indexRoot(), key), { recursive: true, force: true })
    })()
    this.dropping.set(key, drop)
    try {
      await drop
    } finally {
      if (this.dropping.get(key) === drop) this.dropping.delete(key)
    }
  }

  /**
   * Every folder the index has opened since the app started and not dropped
   * since: the only folders that can have parses queued or running, or
   * parsed text written after startup.
   */
  async openedRoots(): Promise<string[]> {
    const states = await Promise.all([...this.folders.values()].map((loading) => loading.catch(() => null)))
    return states.flatMap((state) => (state ? [state.root] : []))
  }

  /** Resolves once no parse is queued or running. */
  whenIdle(): Promise<void> {
    return this.queue.whenIdle()
  }

  private indexRoot(): Promise<string> {
    this.indexRootPath ??= fs.realpath(this.options.workspacePath)
      .catch(() => path.resolve(this.options.workspacePath))
      .then((workspace) => path.join(workspace, 'folder-index'))
    return this.indexRootPath
  }

  /** The folder's state, loaded once; null for a root the index refuses. */
  private folderState(root: string): Promise<FolderState | null> {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) return Promise.resolve(null)
    const key = hashKey('folder', root)
    const loaded = this.folders.get(key)
    if (loaded) return loaded
    const loading = (async () => {
      await this.dropping.get(key)
      return this.load(root, key)
    })()
    this.folders.set(key, loading)
    loading.catch(() => {
      if (this.folders.get(key) === loading) this.folders.delete(key)
    })
    return loading
  }

  /** Read a folder's manifest, removing what a crash or restart left behind. */
  private async load(root: string, key: string): Promise<FolderState | null> {
    const indexRoot = await this.indexRoot()
    // A shared folder may hold the workspace (the home folder does), because
    // every walk skips the workspace. One inside the workspace is never shared:
    // it holds other chats' data and this cache.
    if (isPathEqualOrInside(path.dirname(indexRoot), root)) return null
    const dir = path.join(indexRoot, key)
    await fs.rm(path.join(dir, 'tmp'), { recursive: true, force: true })
    const manifest = await readManifest(dir, root)
    const state: FolderState = {
      root,
      key,
      dir,
      entries: new Map(),
      outputLimitReached: manifest?.outputLimitReached ?? false,
      dropped: false,
      lastWritten: '',
      tail: Promise.resolve(),
    }
    for (const saved of manifest?.entries ?? []) {
      if (!isDocumentPath(saved.path)) continue
      const entry: Entry = { ...saved, fileKey: hashKey('file', saved.path) }
      if (entry.published && !await this.hasText(state, entry, entry.published)) {
        entry.published = undefined
        if (entry.state === 'ready') entry.state = 'pending'
      }
      state.entries.set(entry.path, entry)
    }
    state.lastWritten = manifest === null ? manifestText(state) : JSON.stringify(manifest)
    await this.removeUnreferencedOutputs(state)
    await this.writeManifest(state)
    return state
  }

  private serialize<T>(state: FolderState, operation: () => Promise<T>): Promise<T> {
    const run = state.tail.then(operation)
    state.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async writeManifest(state: FolderState): Promise<void> {
    if (state.dropped) return
    const text = manifestText(state)
    if (text === state.lastWritten) return
    await writeFileAtomic(path.join(state.dir, 'manifest.json'), text)
    state.lastWritten = text
  }

  /** Forget a document: its job is cancelled; the caller deletes its output after the manifest is written. */
  private forget(state: FolderState, entry: Entry): void {
    this.cancelJob(entry)
    state.entries.delete(entry.path)
  }

  private changeVersion(entry: Entry, version: DocumentVersion): void {
    this.cancelJob(entry)
    entry.version = versionOf(version)
    entry.state = 'pending'
    entry.budget = undefined
  }

  private cancelJob(entry: Entry): void {
    if (!entry.job) return
    this.queue.cancel(entry.job.key)
    entry.job = undefined
  }

  /**
   * Decide, in walk order, which documents may be parsed. Work already done
   * or under way counts first; the rest is admitted while the folder's input
   * budget lasts. Once the output budget has been reached, nothing more is.
   */
  private admit(state: FolderState, order: readonly string[]): void {
    let used = 0
    for (const entry of state.entries.values()) {
      if (isAdmittedWork(entry)) used += entry.version.size
    }
    for (const documentPath of order) {
      const entry = state.entries.get(documentPath)
      if (!entry || isAdmittedWork(entry)) continue
      if (entry.version.size > this.limits.maxDocumentBytes) {
        entry.state = 'oversized'
        entry.budget = undefined
      } else if (used + entry.version.size > this.limits.maxInputBytesPerFolder) {
        entry.state = 'over_budget'
        entry.budget = 'input'
      } else if (state.outputLimitReached) {
        entry.state = 'over_budget'
        entry.budget = 'output'
      } else {
        entry.state = 'pending'
        entry.budget = undefined
        used += entry.version.size
      }
    }
  }

  private async admitForRead(
    state: FolderState,
    document: FolderDocument,
  ): Promise<{ readonly kind: 'refused'; readonly code: FolderDocumentErrorCode } | { readonly kind: 'parsing'; readonly done: Promise<FolderParseOutcome> }> {
    // A folder no longer kept is never parsed, even for a turn that began before it lost its grant or attachment.
    if (state.dropped || !await this.options.isRetained(state.root)) return { kind: 'refused', code: 'unavailable' }
    let entry = state.entries.get(document.path)
    if (!entry) {
      entry = newEntry(document)
      state.entries.set(entry.path, entry)
    } else if (!sameVersion(entry.version, document)) {
      this.changeVersion(entry, document)
    } else if (entry.published && sameVersion(entry.published.version, document)) {
      // Published since the read looked.
      return { kind: 'parsing', done: Promise.resolve('published') }
    }
    this.admit(state, [entry.path])
    const done = this.schedule(state, entry, true)
    await this.writeManifest(state)
    if (done) return { kind: 'parsing', done }
    return { kind: 'refused', code: entry.state === 'pending' || entry.state === 'ready' ? 'unavailable' : entry.state }
  }

  /** Queue a pending document's parse, or join and promote the one queued. */
  private schedule(state: FolderState, entry: Entry, urgent: boolean): Promise<FolderParseOutcome> | null {
    if (state.dropped || entry.state !== 'pending') return null
    const existing = entry.job
    if (existing) {
      if (urgent) {
        void this.queue.submit({
          folderKey: state.key,
          key: existing.key,
          run: (signal) => this.runParse(state, entry, existing, signal),
        }, { urgent: true })
      }
      return existing.done
    }
    const version = entry.version
    const job = new ActiveJob(`${state.key}:${entry.fileKey}:${version.size}:${version.mtimeMs}`, version)
    entry.job = job
    job.done = this.queue.submit({
      folderKey: state.key,
      key: job.key,
      run: (signal) => this.runParse(state, entry, job, signal),
    }, { urgent })
    const clear = () => {
      if (entry.job === job) entry.job = undefined
    }
    void job.done.then(clear, clear)
    return job.done
  }

  /** Whether `job` is still what `entry` waits for, in a folder still kept. */
  private isCurrent(state: FolderState, entry: Entry, job: ActiveJob): boolean {
    return !state.dropped && state.entries.get(entry.path) === entry && entry.job === job
  }

  private async runParse(state: FolderState, entry: Entry, job: ActiveJob, signal: AbortSignal): Promise<FolderParseOutcome> {
    const temporary = path.join(state.dir, 'tmp', randomUUID())
    try {
      if (!this.isCurrent(state, entry, job)) return 'discarded'
      const snapshot = await snapshotDocument(state.root, entry.path, job.version, path.join(temporary, 'source'), signal)
      if (snapshot.kind === 'changed') return 'changed'
      if (snapshot.kind === 'gone') return await this.serialize(state, () => this.forgetGone(state, entry, job))
      const outputDir = path.join(temporary, 'output')
      const output: ParserOutput = snapshot.kind === 'unreadable'
        ? { kind: 'failed' }
        : await this.parseCopy(snapshot.file, outputDir, signal)
      return await this.serialize(state, () => this.publish(state, entry, job, snapshot, output, outputDir))
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return 'discarded'
      throw error
    } finally {
      if (entry.job === job) entry.job = undefined
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }

  private async parseCopy(file: string, outputDir: string, signal: AbortSignal): Promise<ParserOutput> {
    try {
      await this.options.launcher.parseFile({ filePath: file, outputDir, localOnly: true }, { signal })
    } catch (error) {
      if (signal.aborted) throw error
      return { kind: 'failed' }
    }
    return readParserOutput(outputDir)
  }

  private async forgetGone(state: FolderState, entry: Entry, job: ActiveJob): Promise<FolderParseOutcome> {
    if (!this.isCurrent(state, entry, job)) return 'discarded'
    this.forget(state, entry)
    await this.writeManifest(state)
    await fs.rm(this.fileDirectory(state, entry), { recursive: true, force: true })
    return 'gone'
  }

  /** Runs in the folder's turn. Every check comes before anything is moved into place. */
  private async publish(
    state: FolderState,
    entry: Entry,
    job: ActiveJob,
    snapshot: Snapshot,
    output: ParserOutput,
    outputDir: string,
  ): Promise<FolderParseOutcome> {
    if (!this.isCurrent(state, entry, job)) return 'discarded'
    if (snapshot.kind === 'copied' && !await sourceUnchanged(state.root, entry.path, snapshot)) return 'changed'
    if (!await this.options.isRetained(state.root)) return 'discarded'
    if (output.kind === 'failed') {
      entry.state = 'failed'
      await this.writeManifest(state)
      return 'failed'
    }
    const previous = entry.published ? entry.generation : null
    const otherOutput = [...state.entries.values()]
      .reduce((sum, other) => sum + (other === entry ? 0 : other.published?.outputBytes ?? 0), 0)
    if (state.outputLimitReached || otherOutput + output.outputBytes > this.limits.maxOutputBytesPerFolder) {
      state.outputLimitReached = true
      entry.state = 'over_budget'
      entry.budget = 'output'
      await this.writeManifest(state)
      return 'over_budget'
    }
    const generation = entry.generation + 1
    const target = this.generationDirectory(state, entry, generation)
    await fs.rm(target, { recursive: true, force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(outputDir, target)
    entry.generation = generation
    entry.published = { version: job.version, textFile: output.textFile, outputBytes: output.outputBytes }
    entry.state = 'ready'
    entry.budget = undefined
    await this.writeManifest(state)
    if (previous !== null) {
      await fs.rm(this.generationDirectory(state, entry, previous), { recursive: true, force: true })
    }
    return 'published'
  }

  private fileDirectory(state: FolderState, entry: Entry): string {
    return path.join(state.dir, 'files', entry.fileKey)
  }

  private generationDirectory(state: FolderState, entry: Entry, generation: number): string {
    return path.join(this.fileDirectory(state, entry), `generation-${generation}`)
  }

  /** The published text file, resolved inside its generation folder, or null if the manifest names anything else. */
  private textPath(state: FolderState, entry: Entry, published: PublishedText): string | null {
    const segments = segmentsOf(published.textFile)
    if (!segments) return null
    const generationDir = this.generationDirectory(state, entry, entry.generation)
    const textFile = path.join(generationDir, ...segments)
    return isPathInside(generationDir, textFile) ? textFile : null
  }

  private async hasText(state: FolderState, entry: Entry, published: PublishedText): Promise<boolean> {
    const textFile = this.textPath(state, entry, published)
    if (textFile === null) return false
    const stat = await fs.lstat(textFile).catch(() => null)
    return stat?.isFile() ?? false
  }

  /** Delete output folders no entry refers to: older generations, and documents no longer indexed. */
  private async removeUnreferencedOutputs(state: FolderState): Promise<void> {
    const filesDir = path.join(state.dir, 'files')
    const fileKeys = await fs.readdir(filesDir).catch(() => [])
    const kept = new Map<string, Entry>()
    for (const entry of state.entries.values()) {
      if (entry.published) kept.set(entry.fileKey, entry)
    }
    for (const fileKey of fileKeys) {
      const entry = kept.get(fileKey)
      const fileDir = path.join(filesDir, fileKey)
      if (!entry) {
        await fs.rm(fileDir, { recursive: true, force: true })
        continue
      }
      const keep = `generation-${entry.generation}`
      for (const name of await fs.readdir(fileDir).catch(() => [])) {
        if (name !== keep) await fs.rm(path.join(fileDir, name), { recursive: true, force: true })
      }
    }
  }
}

function newEntry(document: FolderDocument): Entry {
  return {
    path: document.path,
    fileKey: hashKey('file', document.path),
    version: versionOf(document),
    state: 'pending',
    generation: 0,
  }
}

/** Parsed, or being parsed: the document's bytes already count against the folder's input budget. */
function isAdmittedWork(entry: Entry): boolean {
  return entry.state === 'ready' || entry.state === 'failed' || (entry.state === 'pending' && entry.job !== undefined)
}

function manifestText(state: FolderState): string {
  const entries = [...state.entries.values()].map((entry) => ({
    path: entry.path,
    version: entry.version,
    state: entry.state,
    ...(entry.budget ? { budget: entry.budget } : {}),
    generation: entry.generation,
    ...(entry.published ? { published: entry.published } : {}),
  }))
  return JSON.stringify({ version: 1, root: state.root, outputLimitReached: state.outputLimitReached, entries })
}

async function readManifest(dir: string, root: string): Promise<z.infer<typeof manifestSchema> | null> {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = manifestSchema.safeParse(json)
  return parsed.success && parsed.data.root === root ? parsed.data : null
}

async function readManifestRoot(dir: string): Promise<string | null> {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = manifestSchema.safeParse(json)
  return parsed.success ? parsed.data.root : null
}

/** What the parser left in `outputDir`: its text output, and how many bytes the output takes. */
async function readParserOutput(outputDir: string): Promise<ParserOutput> {
  const raw = await fs.readFile(path.join(outputDir, '_manifest.json'), 'utf8').catch(() => null)
  if (raw === null) return { kind: 'failed' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { kind: 'failed' }
  }
  const parsed = parserManifestSchema.safeParse(json)
  const file = parsed.success ? parsed.data.files[0] : undefined
  const textFile = file?.status === 'success' ? file.outputs['text'] : undefined
  const segments = textFile === undefined ? null : segmentsOf(textFile)
  if (textFile === undefined || segments === null) return { kind: 'failed' }
  const stat = await fs.lstat(path.join(outputDir, ...segments)).catch(() => null)
  if (!stat?.isFile()) return { kind: 'failed' }
  return { kind: 'parsed', textFile, outputBytes: await treeBytes(outputDir) }
}

async function treeBytes(directory: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const stat = await fs.lstat(path.join(entry.parentPath, entry.name)).catch(() => null)
    total += stat?.size ?? 0
  }
  return total
}

const COPY_CHUNK_BYTES = 1024 * 1024

/** Whether a path, resolved in full, names itself and leads to this very file. */
async function namesFile(absolutePath: string, identity: { readonly dev: number; readonly ino: number }): Promise<boolean> {
  const real = await fs.realpath(absolutePath).catch(() => null)
  if (real !== absolutePath) return false
  const named = await fs.lstat(real).catch(() => null)
  return named !== null && named.isFile() && named.dev === identity.dev && named.ino === identity.ino
}

/**
 * Copy one document version out of the user's folder. The file is opened
 * without following a symlink and must be the file its full path names, with
 * no symlink or swapped folder anywhere above it; it is copied through that
 * handle, so the bytes parsed are the bytes checked. A file that is no longer
 * the expected version is not copied at all.
 */
async function snapshotDocument(
  root: string,
  relativePath: string,
  expected: DocumentVersion,
  destination: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const segments = segmentsOf(relativePath)
  const name = segments?.at(-1)
  if (!segments || name === undefined) return { kind: 'gone' }
  const absolutePath = path.join(root, ...segments)
  let handle: FileHandle
  try {
    // O_NONBLOCK: a file swapped for a named pipe would otherwise hold the open until a writer came.
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  } catch (error) {
    const code = errorCodeOf(error)
    return code === 'EACCES' || code === 'EPERM' ? { kind: 'unreadable' } : { kind: 'gone' }
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !await namesFile(absolutePath, opened)) return { kind: 'gone' }
    const version = { size: opened.size, mtimeMs: opened.mtime.getTime() }
    if (!sameVersion(version, expected)) return { kind: 'changed' }
    await fs.mkdir(destination, { recursive: true })
    const file = path.join(destination, name)
    const output = await fs.open(file, 'wx', 0o600)
    try {
      const buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(1, opened.size)))
      let position = 0
      while (position < opened.size) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('The parse was cancelled.', 'AbortError')
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position)
        if (bytesRead === 0) return { kind: 'changed' }
        await output.write(buffer, 0, bytesRead)
        position += bytesRead
      }
    } finally {
      await output.close()
    }
    return { kind: 'copied', file, version, dev: opened.dev, ino: opened.ino }
  } finally {
    await handle.close()
  }
}

/**
 * Whether a document is no longer at its path: nothing is there, or no plain
 * file reached without a symlink. A path that can't be checked, such as one
 * inside a folder that can't be read, may still hold it.
 */
async function isGoneFromDisk(root: string, relativePath: string): Promise<boolean> {
  const segments = segmentsOf(relativePath)
  if (!segments) return true
  const absolutePath = path.join(root, ...segments)
  let real: string
  try {
    real = await fs.realpath(absolutePath)
  } catch (error) {
    const code = errorCodeOf(error)
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
  if (real !== absolutePath) return true
  const stat = await fs.lstat(real).catch(() => null)
  return stat !== null && !stat.isFile()
}

/** Whether the source is still the file that was copied: same file, same path, same size and time. */
async function sourceUnchanged(
  root: string,
  relativePath: string,
  snapshot: Extract<Snapshot, { readonly kind: 'copied' }>,
): Promise<boolean> {
  const segments = segmentsOf(relativePath)
  if (!segments) return false
  const absolutePath = path.join(root, ...segments)
  const stat = await fs.lstat(absolutePath).catch(() => null)
  if (!stat?.isFile() || !await namesFile(absolutePath, snapshot)) return false
  return sameVersion({ size: stat.size, mtimeMs: stat.mtime.getTime() }, snapshot.version)
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

/** One window of a cached text file, cut at character boundaries, or null if it is missing or not a plain file. */
async function readTextWindow(
  file: string,
  offset: number,
  maxBytes: number,
): Promise<{ readonly text: string; readonly consumed: number; readonly totalBytes: number } | null> {
  let handle: FileHandle
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const totalBytes = stat.size
    if (offset >= totalBytes) return { text: '', consumed: 0, totalBytes }
    const buffer = Buffer.alloc(Math.min(maxBytes, totalBytes - offset))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    let start = 0
    // An offset chosen by the agent may land inside a character; skip to the next one.
    while (start < bytesRead && start < 3 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1
    const atEnd = offset + bytesRead >= totalBytes
    const end = atEnd ? bytesRead : completeUtf8Length(buffer, bytesRead)
    const safeEnd = end <= start ? bytesRead : end
    return { text: buffer.toString('utf8', start, safeEnd), consumed: safeEnd, totalBytes }
  } finally {
    await handle.close()
  }
}
