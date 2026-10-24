import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type {
  FileParseRequest,
  FileParserLauncher,
  FileParserRequestOptions,
} from '../../core/file-parser-launcher.js'
import {
  FolderIndex,
  type FolderDocument,
  type FolderIndexOptions,
} from '../../domains/shared-folders/folder-index.js'

/**
 * The document cache of attached folders, driven through its scheduling and
 * publishing rules (docs/feature-local-folder-access.md, "Indexing and the
 * parse cache"; LF-15, LF-12 for parses and cache, LF-16 for documents).
 *
 * The parser process is the one boundary replaced here: a stand-in launcher
 * that "parses" a document into its own bytes, and finishes each run only
 * when the test says so. Folders, the cache and the copies are real files in
 * a temporary directory. Tests synchronize on launches and on the index going
 * idle, never on time.
 */

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface Launch {
  readonly name: string
  readonly request: FileParseRequest
  readonly signal: AbortSignal | undefined
  readonly exit: Deferred<undefined>
}

/**
 * A parser that writes a document's own bytes as its text, in the parser's
 * output format: `_manifest.json` naming a `text` output beside it. In `gated`
 * mode a run writes and exits only when the test calls `finish`.
 */
class StandInParser implements FileParserLauncher {
  readonly requests: FileParseRequest[] = []
  private readonly launched: Launch[] = []
  private readonly waiters: Array<{ readonly name: string; readonly nth: number; readonly ready: Deferred<undefined> }> = []

  constructor(private readonly mode: 'gated' | 'immediate' = 'gated') {}

  async parseDirectory(): Promise<void> {
    throw new Error('Folder indexing parses one file at a time.')
  }

  parseFile(request: FileParseRequest, options: FileParserRequestOptions = {}): Promise<void> {
    this.requests.push(request)
    if (this.mode === 'immediate') return writeParsedText(request)
    const launch: Launch = {
      name: path.basename(request.filePath),
      request,
      signal: options.signal,
      exit: deferred<undefined>(),
    }
    this.launched.push(launch)
    for (const waiter of this.waiters) {
      if (waiter.name === launch.name && this.launches(launch.name) === waiter.nth) waiter.ready.resolve(undefined)
    }
    return launch.exit.promise
  }

  /** Launched names, in order. */
  names(): string[] {
    return this.launched.map((launch) => launch.name)
  }

  launches(name: string): number {
    return this.launched.filter((launch) => launch.name === name).length
  }

  /** Resolves with `name` once its `nth` run has been launched. */
  whenLaunched(name: string, nth = 1): Promise<string> {
    if (this.launches(name) >= nth) return Promise.resolve(name)
    const ready = deferred<undefined>()
    this.waiters.push({ name, nth, ready })
    return ready.promise.then(() => name)
  }

  signalOf(name: string, nth = 1): AbortSignal | undefined {
    return this.launch(name, nth).signal
  }

  /** Write the run's output, then let its process exit cleanly. */
  async finish(name: string, nth = 1): Promise<void> {
    const launch = this.launch(name, nth)
    await writeParsedText(launch.request)
    launch.exit.resolve(undefined)
  }

  fail(name: string, error: Error, nth = 1): void {
    this.launch(name, nth).exit.reject(error)
  }

  private launch(name: string, nth: number): Launch {
    const launch = this.launched.filter((candidate) => candidate.name === name)[nth - 1]
    if (!launch) throw new Error(`${name} has not been launched ${nth} time(s)`)
    return launch
  }
}

async function writeParsedText(request: FileParseRequest): Promise<void> {
  const name = path.basename(request.filePath)
  const text = await fs.promises.readFile(request.filePath, 'utf8').catch(() => '')
  await fs.promises.mkdir(request.outputDir, { recursive: true })
  await fs.promises.writeFile(path.join(request.outputDir, `${name}.md`), text)
  await fs.promises.writeFile(
    path.join(request.outputDir, '_manifest.json'),
    JSON.stringify({ files: [{ source: name, status: 'success', outputs: { text: `${name}.md` }, metadata: {} }] }),
  )
}

interface Setup {
  readonly base: string
  readonly root: string
  readonly workspace: string
}

function makeSetup(t: TestContext): Setup {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-index-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  const workspace = path.join(base, 'workspace')
  fs.mkdirSync(root)
  fs.mkdirSync(workspace)
  return { base, root, workspace }
}

function makeIndex(setup: Setup, launcher: FileParserLauncher, options: Partial<FolderIndexOptions> = {}): FolderIndex {
  return new FolderIndex({
    workspacePath: setup.workspace,
    launcher,
    isRetained: async () => true,
    // A read waits until its parse settles unless a test ends the wait itself.
    waitLimit: () => new Promise<void>(() => undefined),
    ...options,
  })
}

/** Write a document and give it a modification time of its own, so each version is distinct. */
function writeDocument(root: string, relativePath: string, text: string, day: number): FolderDocument {
  const file = path.join(root, ...relativePath.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  const when = new Date(Date.UTC(2026, 0, day, 12))
  fs.utimesSync(file, when, when)
  return measure(root, relativePath)
}

/** A document as a folder scan reports it. */
function measure(root: string, relativePath: string): FolderDocument {
  const stat = fs.statSync(path.join(root, ...relativePath.split('/')))
  return { path: relativePath, size: stat.size, mtimeMs: stat.mtime.getTime() }
}

/** Every published output folder under the workspace's folder index. */
function generationFolders(workspace: string): string[] {
  const indexRoot = path.join(workspace, 'folder-index')
  if (!fs.existsSync(indexRoot)) return []
  return fs.readdirSync(indexRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^generation-\d+$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

test('a background parse and an on-demand read of the same version share one parse', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'Reports/q3.pdf', 'Q3 revenue rose 12 percent.', 1)

  await index.reconcile(setup.root, { documents: [report], complete: true })
  await parser.whenLaunched('q3.pdf')
  const read = index.readDocument(setup.root, report)
  await parser.finish('q3.pdf')

  const result = await read
  assert.equal(result.ok && result.text, 'Q3 revenue rose 12 percent.')
  assert.equal(parser.launches('q3.pdf'), 1)
})

test('every parse the index starts is local-only and reads a copy outside the folder', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'Reports/q3.pdf', 'Q3 revenue rose 12 percent.', 1)
  const minutes = writeDocument(setup.root, 'minutes.docx', 'The board met on Tuesday.', 1)

  await index.reconcile(setup.root, { documents: [report], complete: true })
  await index.readDocument(setup.root, minutes)
  await index.whenIdle()

  assert.equal(parser.requests.length, 2)
  for (const request of parser.requests) {
    assert.equal(request.localOnly, true)
    assert.ok(!request.filePath.startsWith(`${setup.root}${path.sep}`), 'The parser reads a copy, never the folder')
    assert.ok(request.outputDir.startsWith(path.join(setup.workspace, 'folder-index') + path.sep))
  }
})

test('a read waits up to 60 seconds, then answers that it is still parsing; the parse goes on and a later read gets the text', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const waits: number[] = []
  const firstWaitEnds = deferred<undefined>()
  const index = makeIndex(setup, parser, {
    waitLimit: (ms) => {
      waits.push(ms)
      return waits.length === 1 ? firstWaitEnds.promise : new Promise<void>(() => undefined)
    },
  })
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)

  const first = index.readDocument(setup.root, report)
  await parser.whenLaunched('q3.pdf')
  firstWaitEnds.resolve(undefined)

  assert.deepEqual(await first, { ok: false, code: 'still_parsing', message: 'Still parsing; try again shortly.' })
  assert.deepEqual(waits, [60_000])
  assert.equal(parser.signalOf('q3.pdf')?.aborted, false, 'Waiting out does not stop the parse')

  const second = index.readDocument(setup.root, report)
  await parser.finish('q3.pdf')
  const result = await second
  assert.equal(result.ok && result.text, 'Q3 revenue rose 12 percent.')
  assert.equal(parser.launches('q3.pdf'), 1)
})

test('a read asked for on demand is parsed before documents queued ahead of it', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const documents = ['d1.pdf', 'd2.pdf', 'd3.pdf', 'd4.pdf']
    .map((name, day) => writeDocument(setup.root, name, `Text of ${name}`, day + 1))

  await index.reconcile(setup.root, { documents, complete: true })
  await Promise.all([parser.whenLaunched('d1.pdf'), parser.whenLaunched('d2.pdf')])
  const fourth = documents[3]
  assert.ok(fourth)
  const read = index.readDocument(setup.root, fourth)
  await parser.finish('d1.pdf')

  const next = await Promise.race([parser.whenLaunched('d3.pdf'), parser.whenLaunched('d4.pdf')])
  assert.equal(next, 'd4.pdf')
  await parser.finish('d4.pdf')
  const result = await read
  assert.equal(result.ok && result.text, 'Text of d4.pdf')
})

test('a late parse of an older version never replaces the newer text', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const older = writeDocument(setup.root, 'q3.pdf', 'Draft: revenue rose 10 percent.', 1)

  await index.reconcile(setup.root, { documents: [older], complete: true })
  await parser.whenLaunched('q3.pdf', 1)
  const newer = writeDocument(setup.root, 'q3.pdf', 'Final: revenue rose 12 percent.', 2)
  await index.reconcile(setup.root, { documents: [newer], complete: true })
  await parser.whenLaunched('q3.pdf', 2)
  await parser.finish('q3.pdf', 2)
  await parser.finish('q3.pdf', 1)
  await index.whenIdle()

  const result = await index.readCached(setup.root, newer)
  assert.equal(result.ok && result.text, 'Final: revenue rose 12 percent.')
  assert.equal(generationFolders(setup.workspace).length, 1, 'Only the newer generation is kept')
})

test('a parse whose document changed before it finished publishes nothing, and the document stays pending', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const older = writeDocument(setup.root, 'q3.pdf', 'Draft: revenue rose 10 percent.', 1)

  await index.reconcile(setup.root, { documents: [older], complete: true })
  await parser.whenLaunched('q3.pdf')
  writeDocument(setup.root, 'q3.pdf', 'Final: revenue rose 12 percent.', 2)
  await parser.finish('q3.pdf')
  await index.whenIdle()

  assert.deepEqual(generationFolders(setup.workspace), [])
  assert.equal((await index.status(setup.root)).pendingDocuments, 1)
  assert.equal((await index.readCached(setup.root, older)).ok, false)
})

test('a document deleted while its parse runs is never brought back, even when a file returns to its path', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)
  const away = path.join(setup.base, 'q3.pdf')

  await index.reconcile(setup.root, { documents: [report], complete: true })
  await parser.whenLaunched('q3.pdf')
  fs.renameSync(path.join(setup.root, 'q3.pdf'), away)
  await index.reconcile(setup.root, { documents: [], complete: true })
  fs.renameSync(away, path.join(setup.root, 'q3.pdf'))
  await parser.finish('q3.pdf')
  await index.whenIdle()

  assert.deepEqual(generationFolders(setup.workspace), [])
  assert.equal((await index.readCached(setup.root, report)).ok, false)
  assert.equal((await index.status(setup.root)).pendingDocuments, 0)
})

test('a parse finishing after the folder lost its grant or its last attachment publishes nothing', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  let retained = true
  const index = makeIndex(setup, parser, { isRetained: async (root) => root === setup.root && retained })
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)

  await index.reconcile(setup.root, { documents: [report], complete: true })
  await parser.whenLaunched('q3.pdf')
  retained = false
  await parser.finish('q3.pdf')
  await index.whenIdle()

  assert.deepEqual(generationFolders(setup.workspace), [])
  assert.equal((await index.readCached(setup.root, report)).ok, false)
})

test('dropping a folder aborts its parses, deletes its cache, and a parse finishing afterwards writes nothing', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const documents = ['d1.pdf', 'd2.pdf', 'd3.pdf']
    .map((name, day) => writeDocument(setup.root, name, `Text of ${name}`, day + 1))

  await index.reconcile(setup.root, { documents, complete: true })
  await Promise.all([parser.whenLaunched('d1.pdf'), parser.whenLaunched('d2.pdf')])
  const dropped = index.dropFolder(setup.root)
  await Promise.all([parser.finish('d1.pdf'), parser.finish('d2.pdf')])
  await dropped
  await index.whenIdle()

  assert.equal(parser.signalOf('d1.pdf')?.aborted, true)
  assert.equal(parser.signalOf('d2.pdf')?.aborted, true)
  assert.deepEqual([...parser.names()].sort(), ['d1.pdf', 'd2.pdf'], 'The queued document never starts')
  assert.deepEqual(fs.readdirSync(path.join(setup.workspace, 'folder-index')), [])
})

test('a scan sends a changed document back to pending, and its new version never reads as the old text', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const older = writeDocument(setup.root, 'q3.pdf', 'Draft: revenue rose 10 percent.', 1)
  const first = index.readDocument(setup.root, older)
  await parser.whenLaunched('q3.pdf', 1)
  await parser.finish('q3.pdf', 1)
  await first

  const newer = writeDocument(setup.root, 'q3.pdf', 'Final: revenue rose 12 percent.', 2)
  await index.reconcile(setup.root, { documents: [newer], complete: true })

  assert.equal((await index.status(setup.root)).pendingDocuments, 1)
  assert.deepEqual(await index.readCached(setup.root, newer), {
    ok: false,
    code: 'pending',
    message: 'This document has not been parsed yet.',
  })
  await parser.whenLaunched('q3.pdf', 2)
  const read = index.readDocument(setup.root, newer)
  await parser.finish('q3.pdf', 2)
  const result = await read
  assert.equal(result.ok && result.text, 'Final: revenue rose 12 percent.')
  assert.equal(generationFolders(setup.workspace).length, 1, 'The newer generation replaces the older one on disk')
})

test('a scan drops a deleted document and removes its cached text', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)
  await index.readDocument(setup.root, report)
  assert.equal(generationFolders(setup.workspace).length, 1)

  fs.rmSync(path.join(setup.root, 'q3.pdf'))
  await index.reconcile(setup.root, { documents: [], complete: true })

  assert.deepEqual(generationFolders(setup.workspace), [])
  assert.equal((await index.readCached(setup.root, report)).ok, false)
})

test('a scan that stopped part way keeps the documents it did not reach', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)
  await index.readDocument(setup.root, report)

  await index.reconcile(setup.root, { documents: [], complete: false })

  const result = await index.readCached(setup.root, report)
  assert.equal(result.ok && result.text, 'Q3 revenue rose 12 percent.')
})

test('a scan that stopped part way still drops documents gone from disk, removes their text, and stops waiting for them', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)
  const draft = writeDocument(setup.root, 'draft.pdf', 'Draft forecast.', 1)
  await index.reconcile(setup.root, { documents: [report, draft], complete: true })
  await Promise.all([parser.whenLaunched('q3.pdf'), parser.whenLaunched('draft.pdf')])
  await parser.finish('q3.pdf')
  // The draft is deleted while its parse runs, so that parse publishes nothing.
  fs.rmSync(path.join(setup.root, 'draft.pdf'))
  await parser.finish('draft.pdf')
  await index.whenIdle()
  fs.rmSync(path.join(setup.root, 'q3.pdf'))
  const before = { published: generationFolders(setup.workspace).length, pending: (await index.status(setup.root)).pendingDocuments }

  await index.reconcile(setup.root, { documents: [], complete: false })

  assert.deepEqual(before, { published: 1, pending: 1 })
  assert.deepEqual(generationFolders(setup.workspace), [])
  assert.equal((await index.status(setup.root)).pendingDocuments, 0)
  assert.equal((await index.readCached(setup.root, report)).ok, false)
})

test('a document the parser fails on answers that it can not be read, and that version is not parsed again', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser()
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.root, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)

  const first = index.readDocument(setup.root, report)
  await parser.whenLaunched('q3.pdf')
  parser.fail('q3.pdf', new Error('File parser timed out after 300000ms'))

  assert.deepEqual(await first, { ok: false, code: 'failed', message: "This file can't be read." })
  assert.deepEqual(await index.readDocument(setup.root, report), { ok: false, code: 'failed', message: "This file can't be read." })
  assert.equal(parser.launches('q3.pdf'), 1)
})

test('a document over the size limit is never parsed and can not be read', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser, { limits: { maxDocumentBytes: 16 } })
  const large = writeDocument(setup.root, 'large.pdf', 'Seventeen bytes!!', 1)

  await index.reconcile(setup.root, { documents: [large], complete: true })
  const result = await index.readDocument(setup.root, large)
  await index.whenIdle()

  assert.deepEqual(result, { ok: false, code: 'oversized', message: 'This document is too large to read.' })
  assert.deepEqual(parser.requests, [])
  assert.equal((await index.status(setup.root)).pendingDocuments, 0)
})

test('documents past the folder input budget stay unparsed, and the folder says which limit it hit', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser, { limits: { maxInputBytesPerFolder: 30 } })
  const first = writeDocument(setup.root, 'a.pdf', 'Twenty bytes of text', 1)
  const second = writeDocument(setup.root, 'b.pdf', 'Twenty more bytes!!!', 1)

  await index.reconcile(setup.root, { documents: [first, second], complete: true })
  const refused = await index.readDocument(setup.root, second)
  await index.whenIdle()

  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.code, 'over_budget')
  assert.deepEqual(parser.requests.map((request) => path.basename(request.filePath)), ['a.pdf'])
  const status = await index.status(setup.root)
  assert.equal(status.pendingDocuments, 0)
  assert.match(status.limit ?? '', /30 bytes/)
})

test('a folder that holds the app workspace is indexed: its own documents are parsed', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser)
  const report = writeDocument(setup.base, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)

  await index.reconcile(setup.base, { documents: [report], complete: true })
  const result = await index.readDocument(setup.base, report)
  await index.whenIdle()

  // The walk that builds the scan skips the workspace, so its files never reach here.
  assert.equal(result.ok && result.text, 'Q3 revenue rose 12 percent.')
})

test('a folder inside the app workspace is never parsed into', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser)
  const inside = path.join(setup.workspace, 'sessions')
  const report = writeDocument(inside, 'q3.pdf', 'Q3 revenue rose 12 percent.', 1)

  await index.reconcile(inside, { documents: [report], complete: true })
  const result = await index.readDocument(inside, report)
  await index.whenIdle()

  assert.equal(!result.ok && result.code, 'unavailable')
  assert.deepEqual(parser.requests, [])
  assert.equal(fs.existsSync(path.join(setup.workspace, 'folder-index')), false)
})

test('a document path that leads outside the folder, or through a symlink, is never copied or parsed', async (t) => {
  const setup = makeSetup(t)
  const parser = new StandInParser('immediate')
  const index = makeIndex(setup, parser)
  const outside = path.join(setup.base, 'outside')
  const secret = writeDocument(outside, 'secret.pdf', 'Secret salary table.', 1)
  fs.symlinkSync(outside, path.join(setup.root, 'Linked'))
  fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(setup.root, 'alias.pdf'))
  const attempts: FolderDocument[] = [
    { ...secret, path: 'Linked/secret.pdf' },
    { ...secret, path: 'alias.pdf' },
    { ...secret, path: '../outside/secret.pdf' },
  ]

  const results = []
  for (const attempt of attempts) results.push(await index.readDocument(setup.root, attempt))
  await index.whenIdle()

  assert.deepEqual(results.map((result) => !result.ok && result.code), ['unavailable', 'unavailable', 'unavailable'])
  assert.deepEqual(parser.requests, [])
})
