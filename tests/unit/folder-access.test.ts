import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  FOLDER_LARGE_TEXT_BYTES,
  listFolder,
  OperationBudget,
  readDirectoryEntries,
  readFolderFile,
  searchFolder,
  walkFolder,
  type FolderAccessContext,
} from '../../domains/shared-folders/folder-access.js'
import { folderIndexDocuments } from '../../domains/shared-folders/folder-documents.js'
import { FolderIndex, type FolderIndexOptions } from '../../domains/shared-folders/folder-index.js'
import { StandInFileParser } from '../support/stand-in-file-parser.js'

/**
 * Reading inside an attached folder (LF-05, LF-16 for plain text, LF-17).
 *
 * Every rule is checked on the call itself, never inherited from what a walk
 * skipped: an agent can name an excluded file directly, so the read is what
 * has to refuse it. Real temporary folders and real symlinks throughout.
 */

function makeFolder(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-access-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  const outside = path.join(base, 'outside')
  const appData = path.join(root, 'nested-app-data')
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.mkdirSync(appData, { recursive: true })
  fs.writeFileSync(path.join(root, 'notes', 'plan.md'), '# Plan\n\nShip the TANGERINE release on Friday.\n')
  fs.writeFileSync(path.join(root, 'notes', '100% done.md'), 'Everything here is finished.\n')
  fs.writeFileSync(path.join(root, 'readme.txt'), 'Welcome to the shared folder.\n')
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=hidden-value\n')
  fs.writeFileSync(path.join(root, 'server.pem'), 'PRIVATE KEY hidden-value\n')
  fs.writeFileSync(path.join(root, 'id_rsa'), 'PRIVATE KEY hidden-value\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'hidden-value\n')
  fs.writeFileSync(path.join(root, '.git', 'config'), 'hidden-value\n')
  fs.writeFileSync(path.join(root, 'photo.bin'), Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'hidden-value outside\n')
  fs.writeFileSync(path.join(appData, 'session.json'), '{"secret":"hidden-value"}\n')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))
  fs.symlinkSync(path.join(root, 'readme.txt'), path.join(root, 'inside-link.txt'))
  fs.symlinkSync(outside, path.join(root, 'linked-dir'))
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) =>
      absolutePath === appData || absolutePath.startsWith(`${appData}${path.sep}`),
  }
  return { root, context }
}

test('a plain text file is read by its path relative to the folder', async (t) => {
  const { context } = makeFolder(t)

  const result = await readFolderFile(context, 'notes/plan.md')

  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.text : '', '# Plan\n\nShip the TANGERINE release on Friday.\n')
  assert.equal(result.ok ? result.nextOffset : 0, undefined)
})

test('a file name with a percent sign is read, not mistaken for an encoded path', async (t) => {
  const { context } = makeFolder(t)

  const result = await readFolderFile(context, 'notes/100% done.md')

  assert.equal(result.ok ? result.text : result.code, 'Everything here is finished.\n')
})

test('paths that leave the folder are refused, and the refusal reads the same as a missing file', async (t) => {
  const { context } = makeFolder(t)
  const attempts = ['../outside/secret.txt', '/etc/hosts', 'notes/../../outside/secret.txt', 'escape.txt', 'linked-dir/secret.txt', 'no/such/file.md']

  for (const attempt of attempts) {
    const result = await readFolderFile(context, attempt)
    assert.equal(result.ok, false, attempt)
    assert.equal(result.ok ? '' : result.code, 'path_not_available', attempt)
  }
})

test('excluded files are refused when named directly, not only skipped by a walk', async (t) => {
  const { context } = makeFolder(t)

  for (const attempt of ['.env', 'server.pem', 'id_rsa', 'node_modules/pkg/index.js', '.git/config', 'inside-link.txt']) {
    const result = await readFolderFile(context, attempt)
    assert.equal(result.ok ? 'read' : result.code, 'path_not_available', attempt)
  }
})

test('node_modules spelled with other letter case is refused when read or listed, on a volume that ignores case', async (t) => {
  const { root, context } = makeFolder(t)
  if (!fs.existsSync(path.join(root, 'NODE_MODULES'))) {
    t.skip('this volume tells names apart by letter case, so the variants name nothing')
    return
  }
  // APFS also folds the long s (U+017F) to "s", so this spelling opens node_modules too.
  const longS = String.fromCodePoint(0x17f)

  const reads = await Promise.all(['Node_Modules/pkg/index.js', `node_module${longS}/pkg/index.js`].map(async (attempt) => {
    const result = await readFolderFile(context, attempt)
    return result.ok ? result.text : result.code
  }))
  const listed = await listFolder(context, 'NODE_MODULES', { depth: 2 })

  assert.deepEqual(reads, ['path_not_available', 'path_not_available'])
  assert.equal(listed.ok ? listed.entries.map((entry) => entry.path).join(', ') : listed.code, 'path_not_available')
})

test('a name typed with other letter case or Unicode normalization still opens the file on a volume that ignores both', async (t) => {
  const { root, context } = makeFolder(t)
  if (!fs.existsSync(path.join(root, 'NOTES'))) {
    t.skip('this volume tells names apart by letter case')
    return
  }
  // Stored decomposed, as older Macs wrote names; agents tend to type them composed.
  const stored = 'Gęś.md'.normalize('NFD')
  fs.writeFileSync(path.join(root, 'notes', stored), 'goose notes\n')

  const byCase = await readFolderFile(context, 'NOTES/PLAN.md')
  const byForm = await readFolderFile(context, `notes/${stored.normalize('NFC')}`)
  const listed = await listFolder(context, 'Notes')

  assert.deepEqual(
    [byCase.ok ? byCase.text : byCase.code, byForm.ok ? byForm.text : byForm.code],
    ['# Plan\n\nShip the TANGERINE release on Friday.\n', 'goose notes\n'],
  )
  assert.equal(listed.ok ? listed.entries.length : listed.code, 3)
})

test('a path under an attached folder that lies inside the app data is refused', async (t) => {
  const { context } = makeFolder(t)

  const result = await readFolderFile(context, 'nested-app-data/session.json')

  assert.equal(result.ok ? 'read' : result.code, 'path_not_available')
})

test('a file type that is neither text nor a readable document is refused as unsupported', async (t) => {
  const { context } = makeFolder(t)

  const result = await readFolderFile(context, 'photo.bin')

  assert.equal(result.ok ? 'read' : result.code, 'unsupported_type')
})

test('a long file is read in bounded windows that join back into the whole file', async (t) => {
  const { root, context } = makeFolder(t)
  const line = 'Zażółć gęślą jaźń — line of text.\n'
  const whole = line.repeat(4_000)
  fs.writeFileSync(path.join(root, 'long.md'), whole)

  let offset: number | undefined = 0
  const parts: string[] = []
  while (offset !== undefined) {
    const result = await readFolderFile(context, 'long.md', { offset, maxBytes: 10_000 })
    assert.ok(result.ok)
    assert.ok(Buffer.byteLength(result.text) <= 10_000)
    parts.push(result.text)
    offset = result.nextOffset
  }

  assert.equal(parts.join(''), whole)
})

test('a text file over the large-text size is still readable by offset', async (t) => {
  const { root, context } = makeFolder(t)
  const handle = fs.openSync(path.join(root, 'big.log'), 'w')
  fs.writeSync(handle, 'first line of a large log\n')
  fs.ftruncateSync(handle, FOLDER_LARGE_TEXT_BYTES + 1)
  fs.closeSync(handle)

  const result = await readFolderFile(context, 'big.log', { offset: 0, maxBytes: 26 })

  assert.equal(result.ok ? result.text : result.code, 'first line of a large log\n')
})

test('listing shows eligible entries and hides excluded ones', async (t) => {
  const { context } = makeFolder(t)

  const listed = await listFolder(context, '', { depth: 2 })

  assert.ok(listed.ok)
  // Hidden: dot entries, node_modules, key files, every symlink, and the
  // folder that stands in for app data.
  assert.deepEqual(
    listed.entries.map((entry) => entry.path).sort(),
    ['notes', 'notes/100% done.md', 'notes/plan.md', 'photo.bin', 'readme.txt'],
  )
  assert.equal(listed.entries.find((entry) => entry.path === 'photo.bin')?.status, 'unsupported')
})

test('search finds files containing every term, with the matching line', async (t) => {
  const { context } = makeFolder(t)

  const found = await searchFolder(context, 'tangerine friday')

  assert.ok(found.ok)
  assert.deepEqual(found.hits.map((hit) => [hit.path, hit.line]), [['notes/plan.md', 3]])
  assert.ok(found.hits[0]?.snippet.includes('TANGERINE release on Friday'))
  assert.equal(found.partial, false)
})

test('search never reads excluded or outside files', async (t) => {
  const { context } = makeFolder(t)

  const found = await searchFolder(context, 'hidden-value')

  assert.ok(found.ok)
  assert.deepEqual(found.hits, [])
})

test('a search that reaches its scan budget returns partial results and says how much it searched', async (t) => {
  const { root, context } = makeFolder(t)
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(root, `batch-${index}.txt`), `apricot ${'x'.repeat(1_000)}\n`)
  }

  const found = await searchFolder(context, 'apricot', { maxScanBytes: 2_500 })

  assert.ok(found.ok)
  assert.equal(found.partial, true)
  assert.ok(found.searchedFiles < found.eligibleFiles, `${found.searchedFiles} of ${found.eligibleFiles}`)
  assert.ok(found.hits.length >= 1 && found.hits.length < 5)
})

/**
 * A folder whose parent can be swapped for a symlink to a look-alike tree.
 * The saved root string stays the same; only what it resolves to changes.
 */
function makeSwappableFolder(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-swap-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const owner = path.join(base, 'owner')
  const root = path.join(owner, 'Shared')
  const outsideRoot = path.join(base, 'outside', 'Shared')
  for (const [directory, text] of [[root, 'Inside plan.\n'], [outsideRoot, 'OUTSIDE-SENTINEL plan.\n']] as const) {
    fs.mkdirSync(path.join(directory, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'notes', 'plan.md'), text)
  }
  fs.writeFileSync(path.join(outsideRoot, 'notes', 'outside-only.md'), 'OUTSIDE-SENTINEL only.\n')
  fs.writeFileSync(path.join(root, 'notes', 'z-last.md'), 'Inside only.\n')
  let swapped = false
  const swapAncestor = (): void => {
    fs.renameSync(owner, path.join(base, 'owner-old'))
    fs.symlinkSync(path.join(base, 'outside'), owner)
    swapped = true
  }
  const swapBack = (): void => {
    if (!swapped) return
    fs.unlinkSync(owner)
    fs.renameSync(path.join(base, 'owner-old'), owner)
    swapped = false
  }
  return { root, outsideRoot, swapAncestor, swapBack }
}

/**
 * A folder with one subfolder whose permissions deny reading it. Mode 0o644
 * lets its entries be named but not entered: `r` without `x`.
 */
function makeFolderWithLockedPart(t: TestContext, lock: 'subfolder' | 'root', mode = 0o000) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-locked-')))
  const root = path.join(base, 'Shared')
  fs.mkdirSync(path.join(root, 'open'), { recursive: true })
  fs.mkdirSync(path.join(root, 'locked', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'open', 'a.md'), 'apricot in the open folder\n')
  fs.writeFileSync(path.join(root, 'locked', 'b.md'), 'apricot in the locked folder\n')
  fs.writeFileSync(path.join(root, 'locked', 'sub', 'c.md'), 'apricot below the locked folder\n')
  const locked = lock === 'root' ? root : path.join(root, 'locked')
  fs.chmodSync(locked, mode)
  t.after(() => {
    fs.chmodSync(locked, 0o755)
    fs.rmSync(base, { recursive: true, force: true })
  })
  const context: FolderAccessContext = { root, isProtected: async () => false }
  return { root, context }
}

// Permission bits do not stop the superuser, so these cases cannot be staged as root.
const needsPermissions = { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false }

test('a read whose folder is swapped out while its path is resolved returns nothing from outside', async (t) => {
  const { root, swapAncestor } = makeSwappableFolder(t)
  // The swap lands after the root was checked and after `notes` was looked
  // at, but before `plan.md` is: the moment a segment-by-segment walk trusts.
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, 'notes')) swapAncestor()
      return false
    },
  }

  const result = await readFolderFile(context, 'notes/plan.md')

  assert.equal(result.ok ? result.text : result.code, 'path_not_available')
})

test('a listing whose folder is swapped out part way returns nothing from outside', async (t) => {
  const { root, swapAncestor } = makeSwappableFolder(t)
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, 'notes')) swapAncestor()
      return false
    },
  }

  const listed = await listFolder(context, '', { depth: 2 })

  assert.equal(listed.ok ? listed.entries.map((entry) => entry.path).join(', ') : listed.code, 'folder_not_found')
})

test("a listing whose folder is swapped out and back between two entries never shows an outside file's size or date", async (t) => {
  const { root, outsideRoot, swapAncestor, swapBack } = makeSwappableFolder(t)
  const outsidePlan = path.join(outsideRoot, 'notes', 'plan.md')
  const outsideDate = new Date('2001-02-03T04:05:06.000Z')
  fs.utimesSync(outsidePlan, outsideDate, outsideDate)
  const outsideSize = fs.statSync(outsidePlan).size
  // Out just before `plan.md` is measured, back just before `z-last.md` is,
  // so the folder is in place whenever the folder itself is checked.
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, 'notes', 'plan.md')) swapAncestor()
      if (absolutePath === path.join(root, 'notes', 'z-last.md')) swapBack()
      return false
    },
  }

  const listed = await listFolder(context, 'notes')

  const fromOutside = listed.ok
    ? listed.entries.filter((entry) => entry.size === outsideSize || entry.modifiedAt === outsideDate.toISOString())
    : []
  assert.deepEqual(fromOutside, [])
})

/**
 * A folder whose `notes` subfolder can be swapped for a symlink to an excluded
 * folder in the same root. Everything stays inside the root; only the name
 * `notes` now leads somewhere the rules hide.
 */
function makeFolderWithSwappableNotes(t: TestContext, excluded: '.private' | 'node_modules') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-inner-swap-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  const notes = path.join(root, 'notes')
  const hidden = path.join(root, excluded)
  fs.mkdirSync(notes, { recursive: true })
  fs.mkdirSync(hidden)
  fs.writeFileSync(path.join(notes, 'plan.md'), 'launch plan from notes\n')
  fs.writeFileSync(path.join(hidden, 'plan.md'), 'launch EXCLUDED-SENTINEL\n')
  fs.writeFileSync(path.join(hidden, 'only-excluded.md'), 'EXCLUDED-SENTINEL only\n')
  let swapped = false
  const swapNotes = (): void => {
    if (swapped) return
    swapped = true
    fs.renameSync(notes, path.join(base, 'notes-old'))
    fs.symlinkSync(hidden, notes)
  }
  return { root, notes, swapNotes }
}

test('a read whose subfolder becomes a symlink to a hidden folder mid-call returns nothing from it', async (t) => {
  const { root, notes, swapNotes } = makeFolderWithSwappableNotes(t, '.private')
  // The swap lands once `notes` has been checked, before `plan.md` is.
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === notes) swapNotes()
      return false
    },
  }

  const result = await readFolderFile(context, 'notes/plan.md')

  assert.equal(result.ok ? result.text : result.code, 'path_not_available')
})

test('a listing whose subfolder becomes a symlink to a hidden folder mid-call is refused', async (t) => {
  const { root, notes, swapNotes } = makeFolderWithSwappableNotes(t, '.private')
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === notes) swapNotes()
      return false
    },
  }

  const listed = await listFolder(context, 'notes')

  assert.equal(listed.ok ? listed.entries.map((entry) => entry.path).join(', ') : 'refused', 'refused')
})

test('a search whose subfolder becomes a symlink to node_modules before a file is read finds nothing in it', async (t) => {
  const { root, notes, swapNotes } = makeFolderWithSwappableNotes(t, 'node_modules')
  // The walk passes `notes/plan.md` untouched; the swap lands when the search
  // resolves `notes` again to read that file.
  let walkedPlan = false
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(notes, 'plan.md')) walkedPlan = true
      else if (absolutePath === notes && walkedPlan) swapNotes()
      return false
    },
  }

  const found = await searchFolder(context, 'launch')

  assert.equal(JSON.stringify(found).includes('EXCLUDED-SENTINEL'), false, JSON.stringify(found))
})

/** Make a named pipe, or skip the test where `mkfifo` is unavailable. */
function makePipe(t: TestContext, pipePath: string): boolean {
  try {
    execFileSync('mkfifo', [pipePath])
    return true
  } catch {
    // Documented environmental prerequisite: without `mkfifo` there is no way
    // to create a named pipe here.
    t.skip('mkfifo is unavailable on this platform')
    return false
  }
}

/**
 * A writer waiting for a pipe's first reader. Whoever opens the pipe for
 * reading lets it through, so `letThrough` records whether anything did.
 */
function waitingWriter(pipePath: string) {
  const state = { letThrough: false }
  const opened = fs.promises.open(pipePath, fs.constants.O_WRONLY).then((handle) => {
    state.letThrough = true
    return handle
  })
  const release = async (): Promise<void> => {
    // Opened without blocking, this reader lets the writer through if nothing did.
    const reader = await fs.promises.open(pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    await (await opened).close()
    await reader.close()
  }
  return { state, release }
}

test('a named pipe in the folder is refused without being opened, so a read never waits on a writer', async (t) => {
  const { root, context } = makeFolder(t)
  const pipe = path.join(root, 'pipe.txt')
  if (!makePipe(t, pipe)) return
  const writer = waitingWriter(pipe)

  const result = await readFolderFile(context, 'pipe.txt')
  const openedByRead = writer.state.letThrough
  await writer.release()

  assert.deepEqual({ result: result.ok ? result.text : result.code, openedByRead }, { result: 'path_not_available', openedByRead: false })
})

test('a file replaced by a named pipe after the walk measured it is skipped by search without being opened', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-pipe-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  const swapped = path.join(root, 'a.md')
  fs.mkdirSync(path.join(root, 'b'), { recursive: true })
  fs.writeFileSync(swapped, 'apricot\n')
  const sparePipe = path.join(base, 'spare-pipe')
  if (!makePipe(t, sparePipe)) return
  // The walk has measured a.md as a text file when it reaches b; then a.md
  // becomes a pipe with a writer waiting on it.
  let writer: ReturnType<typeof waitingWriter> | undefined
  const context: FolderAccessContext = {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, 'b') && !writer) {
        fs.renameSync(sparePipe, swapped)
        writer = waitingWriter(swapped)
      }
      return false
    },
  }

  const found = await searchFolder(context, 'apricot')
  const openedBySearch = writer?.state.letThrough
  await writer?.release()

  assert.deepEqual(
    { found: found.ok ? found.hits.map((hit) => hit.path) : found.code, openedBySearch },
    { found: [], openedBySearch: false },
  )
})

test('a file replaced by a named pipe just before it is opened is refused without waiting for a writer',
  // Bounds a failure only: a passing read never waits on a writer, or on this.
  { timeout: 10_000 },
  async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-pipe-open-')))
    const root = path.join(base, 'Shared')
    const target = path.join(root, 'plan.md')
    fs.mkdirSync(root)
    fs.writeFileSync(target, 'plan\n')
    t.after(async () => {
      // A read left waiting in open(2) would keep the test process alive; a writer releases it.
      const writer = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK).catch(() => null)
      await writer?.close()
      fs.rmSync(base, { recursive: true, force: true })
    })
    const sparePipe = path.join(base, 'spare-pipe')
    if (!makePipe(t, sparePipe)) return
    // plan.md has been measured as a text file; it becomes a pipe before it is opened.
    const context: FolderAccessContext = {
      root,
      isProtected: async (absolutePath) => {
        if (absolutePath === target) fs.renameSync(sparePipe, target)
        return false
      },
    }

    const result = await readFolderFile(context, 'plan.md')

    assert.equal(result.ok ? result.text : result.code, 'path_not_available')
  })

test("a search's deadline starts before the walk, so time spent walking counts against it", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-deadline-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(base, name), 'apricot\n')
  let clock = 0
  // The clock jumps past the deadline while the walk is still listing files.
  const context: FolderAccessContext = {
    root: base,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(base, 'a.txt')) clock = 120
      return false
    },
  }

  const found = await searchFolder(context, 'apricot', { deadlineMs: 5, now: () => clock })

  assert.deepEqual(found.ok === false ? found.code : { partial: found.partial, searchedFiles: found.searchedFiles }, { partial: true, searchedFiles: 0 })
})

test('a search reads no more bytes than its scan budget, even from a file that grew after the walk', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-scan-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const grower = path.join(base, 'a.txt')
  fs.writeFileSync(grower, 'apricot\n')
  fs.mkdirSync(path.join(base, 'b'))
  // The walk has already measured a.txt when it reaches b; then a.txt grows
  // to 240 KB, with the only match in its last line.
  const context: FolderAccessContext = {
    root: base,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(base, 'b')) fs.writeFileSync(grower, `${'x'.repeat(240 * 1024)}\nzebra\n`)
      return false
    },
  }

  const found = await searchFolder(context, 'zebra', { maxScanBytes: 50_000 })

  assert.deepEqual(found.ok === false ? found.code : { partial: found.partial, hits: found.hits.map((hit) => hit.path) }, { partial: true, hits: [] })
})

test('a walk stops at its entry budget and says so, even when the entries are hidden files', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-entries-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(base, `.cache-${index}`), 'x')
  fs.writeFileSync(path.join(base, 'visible.md'), 'x')

  const walked = await walkFolder({ root: base, isProtected: async () => false }, { maxEntries: 10 })

  assert.equal(walked.ok === false ? walked.code : walked.truncated, true)
})

test('a search of a folder that was moved away reports it as not found, not as no matches', async (t) => {
  const { root, context } = makeFolder(t)
  fs.renameSync(root, `${root}-moved`)

  const found = await searchFolder(context, 'tangerine')

  assert.equal(found.ok === false ? found.code : `searched ${found.searchedFiles} files`, 'folder_not_found')
})

test("listing a folder that can't be read says so instead of showing it empty", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedPart(t, 'subfolder')

  const listed = await listFolder(context, 'locked')

  assert.equal(listed.ok ? `listed ${listed.entries.length}` : listed.code, 'path_unreadable')
})

test("a folder whose own directory can't be read is reported as unreadable, not empty", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedPart(t, 'root')

  const listed = await listFolder(context, '')
  const found = await searchFolder(context, 'apricot')

  assert.equal(listed.ok ? `listed ${listed.entries.length}` : listed.code, 'folder_unreadable')
  assert.equal(found.ok === false ? found.code : `searched ${found.searchedFiles} files`, 'folder_unreadable')
})

test("a listing or search that meets a subfolder it can't read names that subfolder", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedPart(t, 'subfolder')

  const listed = await listFolder(context, '', { depth: 2 })
  const found = await searchFolder(context, 'apricot')

  assert.deepEqual(listed.ok ? listed.unreadableFolders : listed.code, ['locked'])
  assert.deepEqual(found.ok === false ? found.code : found.unreadableFolders, ['locked'])
  assert.deepEqual(found.ok === false ? found.code : found.hits.map((hit) => hit.path), ['open/a.md'])
})

test("listing a subfolder that can be read but not entered says it can't be read, instead of showing it empty", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedPart(t, 'subfolder', 0o644)

  const listed = await listFolder(context, 'locked')

  assert.equal(listed.ok ? `listed ${listed.entries.length}` : listed.code, 'path_unreadable')
})

test('a listing, walk or search that meets a subfolder it can read but not enter names that subfolder', needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedPart(t, 'subfolder', 0o644)

  const listed = await listFolder(context, '', { depth: 2 })
  const walked = await walkFolder(context)
  const found = await searchFolder(context, 'apricot')

  assert.deepEqual(
    [listed, walked, found].map((result) => result.ok ? result.unreadableFolders : result.code),
    [['locked'], ['locked'], ['locked']],
  )
})

/**
 * A folder the user moves away part way through a call. The move lands the
 * `moveOn`-th time the call looks at `a.md`: a walk looks once, and a search
 * looks again when it opens the file to read it.
 */
function makeFolderMovedMidCall(t: TestContext, moveOn: number): FolderAccessContext {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-moved-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  for (const name of ['a.md', 'b.md', 'sub/c.md']) fs.writeFileSync(path.join(root, name), 'apricot\n')
  let looks = 0
  return {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, 'a.md')) {
        looks += 1
        if (looks === moveOn) fs.renameSync(root, path.join(base, 'Shared-moved'))
      }
      return false
    },
  }
}

test('a listing, walk or search whose folder is moved away part way reports it as not found, not as empty', async (t) => {
  const listed = await listFolder(makeFolderMovedMidCall(t, 1), '')
  const walked = await walkFolder(makeFolderMovedMidCall(t, 1))
  const found = await searchFolder(makeFolderMovedMidCall(t, 1), 'apricot')

  assert.deepEqual(
    [listed, walked, found].map((result) => result.ok ? 'reported as complete' : result.code),
    ['folder_not_found', 'folder_not_found', 'folder_not_found'],
  )
})

test('a search whose folder is moved away after the walk, before its files are read, reports it as not found', async (t) => {
  const context = makeFolderMovedMidCall(t, 2)

  const found = await searchFolder(context, 'apricot')

  assert.equal(found.ok ? `searched ${found.searchedFiles} of ${found.eligibleFiles}` : found.code, 'folder_not_found')
})

test("a search below a path inside a folder that can't be read says it can't be read, instead of finding nothing", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedPart(t, 'subfolder')

  const found = await searchFolder(context, 'apricot', { pathPrefix: 'locked/sub' })

  assert.equal(
    found.ok ? `searched ${found.searchedFiles}, unreadable [${found.unreadableFolders.join(', ')}]` : found.code,
    'path_unreadable',
  )
})

test('a search below a path that is not in the folder is refused, instead of finding nothing', async (t) => {
  const { root, context } = makeFolder(t)
  fs.renameSync(path.join(root, 'notes'), path.join(path.dirname(root), 'notes-moved'))

  const results = await Promise.all(['notes', '../notes-moved', 'readme.txt'].map(async (pathPrefix) => {
    const found = await searchFolder(context, 'finished', { pathPrefix })
    return found.ok ? `searched ${found.searchedFiles} of ${found.eligibleFiles}` : found.code
  }))

  assert.deepEqual(results, ['path_not_available', 'path_not_available', 'not_a_folder'])
})

/** A folder holding two text files, one of which its owner can't open. */
function makeFolderWithLockedFile(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-locked-file-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'a.md'), 'apricot in a file that opens\n')
  fs.writeFileSync(path.join(root, 'b.md'), 'apricot in a file that does not\n')
  fs.chmodSync(path.join(root, 'b.md'), 0o000)
  const context: FolderAccessContext = { root, isProtected: async () => false }
  return { context }
}

test("a search that meets a text file it can't open names that file instead of passing over it", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedFile(t)

  const found = await searchFolder(context, 'apricot')

  assert.deepEqual(
    found.ok ? { hits: found.hits.map((hit) => hit.path), unreadableFiles: found.unreadableFiles } : found.code,
    { hits: ['a.md'], unreadableFiles: ['b.md'] },
  )
})

test("reading a text file that can't be opened says the file can't be read", needsPermissions, async (t) => {
  const { context } = makeFolderWithLockedFile(t)

  const result = await readFolderFile(context, 'b.md')

  assert.equal(result.ok ? result.text : result.code, 'file_unreadable')
})

/**
 * A folder whose permissions change part way through a call: the check of
 * `lockOn` locks `locked`, and the check of `unlockOn`, if the call ever gets
 * there, unlocks it again.
 */
function makeFolderLockedMidCall(
  t: TestContext,
  input: { readonly locked: 'root' | 'sub'; readonly lockOn: string; readonly unlockOn?: string },
): FolderAccessContext {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-locked-mid-')))
  const root = path.join(base, 'Shared')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  for (const name of ['a.md', 'b.md', 'sub/d.md', 'sub/e.md', 'sub/f.md']) fs.writeFileSync(path.join(root, name), 'apricot\n')
  const locked = input.locked === 'root' ? root : path.join(root, 'sub')
  t.after(() => {
    fs.chmodSync(locked, 0o755)
    fs.rmSync(base, { recursive: true, force: true })
  })
  return {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, input.lockOn)) fs.chmodSync(locked, 0o000)
      if (input.unlockOn !== undefined && absolutePath === path.join(root, input.unlockOn)) fs.chmodSync(locked, 0o755)
      return false
    },
  }
}

test("a listing, walk or search whose folder is locked part way says it can't be read, instead of showing it empty", needsPermissions, async (t) => {
  // Locked as the call measures its first file, and as it walks its last subfolder.
  const results: string[][] = []
  for (const lockOn of ['a.md', 'sub/d.md']) {
    const listed = await listFolder(makeFolderLockedMidCall(t, { locked: 'root', lockOn }), '', { depth: 2 })
    const walked = await walkFolder(makeFolderLockedMidCall(t, { locked: 'root', lockOn }))
    const found = await searchFolder(makeFolderLockedMidCall(t, { locked: 'root', lockOn }), 'apricot')
    results.push([listed, walked, found].map((result) => result.ok ? 'reported as readable' : result.code))
  }

  assert.deepEqual(results, [
    ['folder_unreadable', 'folder_unreadable', 'folder_unreadable'],
    ['folder_unreadable', 'folder_unreadable', 'folder_unreadable'],
  ])
})

test('a subfolder locked part way through its own walk is named as unreadable, and what was seen of it is not passed off as its contents', needsPermissions, async (t) => {
  // Locked as its second file is measured; unlocked at its third, should the call go on regardless.
  const make = (): FolderAccessContext => makeFolderLockedMidCall(t, { locked: 'sub', lockOn: 'sub/e.md', unlockOn: 'sub/f.md' })

  const listed = await listFolder(make(), '', { depth: 2 })
  const walked = await walkFolder(make())
  const found = await searchFolder(make(), 'apricot')

  assert.deepEqual(
    {
      listed: listed.ok ? { paths: listed.entries.map((entry) => entry.path), unreadable: listed.unreadableFolders } : listed.code,
      walked: walked.ok ? { paths: walked.files.map((entry) => entry.path), unreadable: walked.unreadableFolders } : walked.code,
      found: found.ok ? { paths: found.hits.map((hit) => hit.path).sort(), unreadable: found.unreadableFolders } : found.code,
    },
    {
      listed: { paths: ['a.md', 'b.md', 'sub'], unreadable: ['sub'] },
      walked: { paths: ['a.md', 'b.md'], unreadable: ['sub'] },
      found: { paths: ['a.md', 'b.md'], unreadable: ['sub'] },
    },
  )
})

/** A folder whose subfolder the user moves out of it once the call has measured the subfolder's first file. */
function makeFolderWithSubfolderMovedMidWalk(t: TestContext): FolderAccessContext {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sub-moved-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'Shared')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  for (const name of ['a.md', 'sub/c.md', 'sub/d.md', 'sub/e.md']) fs.writeFileSync(path.join(root, name), 'apricot\n')
  return {
    root,
    isProtected: async (absolutePath) => {
      if (absolutePath === path.join(root, 'sub', 'd.md')) fs.renameSync(path.join(root, 'sub'), path.join(base, 'sub-moved'))
      return false
    },
  }
}

test('a subfolder moved away part way through its own walk is named as unreadable, and the files seen in it are dropped', async (t) => {
  const listed = await listFolder(makeFolderWithSubfolderMovedMidWalk(t), '', { depth: 2 })
  const walked = await walkFolder(makeFolderWithSubfolderMovedMidWalk(t))
  const found = await searchFolder(makeFolderWithSubfolderMovedMidWalk(t), 'apricot')

  assert.deepEqual(
    {
      listed: listed.ok ? { paths: listed.entries.map((entry) => entry.path), unreadable: listed.unreadableFolders } : listed.code,
      walked: walked.ok ? { paths: walked.files.map((entry) => entry.path), unreadable: walked.unreadableFolders } : walked.code,
      found: found.ok ? { paths: found.hits.map((hit) => hit.path), unreadable: found.unreadableFolders } : found.code,
    },
    {
      listed: { paths: ['a.md', 'sub'], unreadable: ['sub'] },
      walked: { paths: ['a.md'], unreadable: ['sub'] },
      found: { paths: ['a.md'], unreadable: ['sub'] },
    },
  )
})

const LONG_FILE_NAME = `${'f'.repeat(247)}.md`

/**
 * Folders with 250-character names, nested until the path passes 4,200 bytes:
 * longer than macOS (1,024) or Linux (4,096) lets a call name. Each level
 * holds `note.md` and a file whose name is as long as a folder's. A shell
 * makes them, stepping down by relative names. Returns each level's name.
 */
function makeDeepChain(root: string): string[] {
  const levels: string[] = []
  while (Buffer.byteLength(path.join(root, ...levels)) < 4_200) levels.push(`${String(levels.length).padStart(2, '0')}${'d'.repeat(248)}`)
  const script = levels
    .map((name) => `mkdir ${name} && cd ${name} && echo apricot > note.md && echo apricot > ${LONG_FILE_NAME}`)
    .join(' && ')
  execFileSync('sh', ['-c', script], { cwd: root })
  return levels
}

test('a folder or file whose path is too long for the system to name is reported as unreadable, not left out', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-deep-')))
  // `rm` steps down by relative names; a removal that names each path in full can't reach the deep end.
  t.after(() => execFileSync('rm', ['-rf', base]))
  const root = path.join(base, 'Shared')
  fs.mkdirSync(root)
  const levels = makeDeepChain(root)
  const folders = levels.map((_, index) => levels.slice(0, index + 1).join('/'))
  const files = folders.flatMap((folder) => [`${folder}/note.md`, `${folder}/${LONG_FILE_NAME}`])
  const context: FolderAccessContext = { root, isProtected: async () => false }

  const walked = await walkFolder(context)
  const found = await searchFolder(context, 'apricot', { maxHits: 100 })

  assert.ok(walked.ok && found.ok)
  const atOrBelow = (entry: string, folder: string): boolean => entry === folder || entry.startsWith(`${folder}/`)
  // Every folder and file in the chain is either in the answer or named as unreadable, itself or by a folder above it.
  const walkSaw = new Set([...walked.files, ...walked.folders].map((entry) => entry.path))
  const walkMissing = [...folders, ...files].filter((entry) => !walkSaw.has(entry) &&
    !walked.unreadableFiles.includes(entry) && !walked.unreadableFolders.some((folder) => atOrBelow(entry, folder)))
  const searchSaw = new Set(found.hits.map((hit) => hit.path))
  const searchMissing = files.filter((entry) => !searchSaw.has(entry) &&
    !found.unreadableFiles.includes(entry) && !found.unreadableFolders.some((folder) => atOrBelow(entry, folder)))
  assert.deepEqual({ walkMissing, searchMissing }, { walkMissing: [], searchMissing: [] })
  assert.notDeepEqual(walked.unreadableFolders, [], 'the chain reaches past the longest path the system names')
})

test('a file swapped for a named pipe after its folder was read is never listed as a file', async (t) => {
  /** A folder holding a.md and b.md; b.md becomes a named pipe as the call checks it. */
  const make = (): FolderAccessContext | null => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-pipe-swap-')))
    t.after(() => fs.rmSync(base, { recursive: true, force: true }))
    const root = path.join(base, 'Shared')
    fs.mkdirSync(root)
    for (const name of ['a.md', 'b.md']) fs.writeFileSync(path.join(root, name), 'apricot\n')
    const sparePipe = path.join(base, 'spare-pipe')
    if (!makePipe(t, sparePipe)) return null
    return {
      root,
      isProtected: async (absolutePath) => {
        if (absolutePath === path.join(root, 'b.md') && fs.existsSync(sparePipe)) fs.renameSync(sparePipe, absolutePath)
        return false
      },
    }
  }
  const forList = make()
  const forWalk = make()
  if (!forList || !forWalk) return

  const listed = await listFolder(forList, '')
  const walked = await walkFolder(forWalk)

  assert.deepEqual(
    [listed.ok ? listed.entries.map((entry) => entry.path) : listed.code, walked.ok ? walked.files.map((entry) => entry.path) : walked.code],
    [['a.md'], ['a.md']],
  )
})

test('reading a folder stops at the next entry once the call is cancelled or past its deadline', async () => {
  const outcomes: string[] = []
  for (const stopWith of ['cancel', 'deadline'] as const) {
    const turn = new AbortController()
    let late = false
    const budget = new OperationBudget({ signal: turn.signal, deadline: { expired: () => late } })
    // A folder whose third entry arrives just as the call has to stop; reading a fourth is an error.
    let given = 0
    const directory = {
      read: async (): Promise<string | null> => {
        if (given === 2) {
          if (stopWith === 'cancel') turn.abort()
          else late = true
        }
        if (given === 3) throw new Error('read on after the call had to stop')
        given += 1
        return `entry-${given}`
      },
    }

    const read = await readDirectoryEntries(directory, budget)

    outcomes.push(read.kind)
  }

  assert.deepEqual(outcomes, ['cancelled', 'deadline'])
})

/**
 * Documents (LF-16 for documents; "File eligibility" and "Indexing and the
 * parse cache"). The folder from `makeFolder`, with its excluded files,
 * symlinks and protected area, read through a real folder index whose cache
 * sits beside it. Only the parser process is replaced: a stand-in that
 * "parses" a document into its own bytes.
 */
function makeDocumentFolder(
  t: TestContext,
  options: { readonly parser?: StandInFileParser; readonly index?: Partial<FolderIndexOptions> } = {},
) {
  const { root, context } = makeFolder(t)
  const workspace = path.join(path.dirname(root), 'workspace')
  fs.mkdirSync(workspace)
  const parser = options.parser ?? new StandInFileParser()
  const index = new FolderIndex({
    workspacePath: workspace,
    launcher: parser,
    isRetained: async () => true,
    // A read waits until its parse settles unless a test ends the wait itself.
    waitLimit: () => new Promise<void>(() => undefined),
    ...options.index,
  })
  const documents: FolderAccessContext = { ...context, documents: folderIndexDocuments(index) }
  return { root, parser, index, context: documents }
}

function writeFile(root: string, relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
  fs.writeFileSync(path.join(root, relativePath), content)
}

test('a document is read as its parsed text', async (t) => {
  const { root, context, parser } = makeDocumentFolder(t)
  writeFile(root, 'reports/q3.pdf', 'Q3 revenue rose 12 percent.\n')

  const result = await readFolderFile(context, 'reports/q3.pdf')

  assert.equal(result.ok ? result.text : result.code, 'Q3 revenue rose 12 percent.\n')
  assert.equal(parser.requests.length, 1)
})

test('a document behind a symlink, in an excluded or protected place, or outside the folder is refused and never parsed', async (t) => {
  const { root, context, parser } = makeDocumentFolder(t)
  const outside = path.join(path.dirname(root), 'outside')
  writeFile(outside, 'secret.pdf', 'Outside salary table.\n')
  fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(root, 'alias.pdf'))
  writeFile(root, '.git/report.pdf', 'Hidden report.\n')
  writeFile(root, 'node_modules/pkg/report.pdf', 'Package report.\n')
  writeFile(root, 'nested-app-data/report.pdf', 'App data report.\n')
  writeFile(root, '.draft.pdf', 'Hidden draft.\n')
  const attempts = [
    'linked-dir/secret.pdf', 'alias.pdf', '../outside/secret.pdf', '.git/report.pdf',
    'node_modules/pkg/report.pdf', 'nested-app-data/report.pdf', '.draft.pdf',
  ]

  const results = []
  for (const attempt of attempts) {
    const result = await readFolderFile(context, attempt)
    results.push(result.ok ? result.text : result.code)
  }

  assert.deepEqual(results, attempts.map(() => 'path_not_available'))
  assert.deepEqual(parser.requests, [])
})

test('a document named with other letter case reads the parsed text of the file on disk, from one parse', async (t) => {
  const { root, context, parser } = makeDocumentFolder(t)
  if (!fs.existsSync(path.join(root, 'NOTES'))) {
    t.skip('this volume tells names apart by letter case')
    return
  }
  writeFile(root, 'notes/minutes.docx', 'The board met on Tuesday.\n')

  const typed = await readFolderFile(context, 'NOTES/Minutes.DOCX')
  const onDisk = await readFolderFile(context, 'notes/minutes.docx')

  assert.deepEqual(
    [typed.ok ? typed.text : typed.code, onDisk.ok ? onDisk.text : onDisk.code],
    ['The board met on Tuesday.\n', 'The board met on Tuesday.\n'],
  )
  assert.equal(parser.requests.length, 1)
})

test('a document still being parsed when the read stops waiting answers that it is still parsing', async (t) => {
  const parser = new StandInFileParser('gated')
  const { root, context, index } = makeDocumentFolder(t, { parser, index: { waitLimit: async () => undefined } })
  writeFile(root, 'q3.pdf', 'Q3 revenue rose 12 percent.\n')

  const result = await readFolderFile(context, 'q3.pdf')
  await parser.whenLaunched('q3.pdf')
  await parser.finish('q3.pdf')
  await index.whenIdle()

  assert.deepEqual(result, { ok: false, code: 'still_parsing', message: 'Still parsing; try again shortly.' })
})

test('an oversized document is listed as too large, refused when read, found by its name only, and never parsed', async (t) => {
  const { root, context, parser } = makeDocumentFolder(t, { index: { limits: { maxDocumentBytes: 16 } } })
  writeFile(root, 'budget.pdf', 'Seventeen bytes!!')

  const listed = await listFolder(context, '')
  const read = await readFolderFile(context, 'budget.pdf')
  const found = await searchFolder(context, 'budget')
  const byContent = await searchFolder(context, 'seventeen')

  assert.equal(listed.ok ? listed.entries.find((entry) => entry.path === 'budget.pdf')?.status : listed.code, 'oversized')
  assert.deepEqual(read, { ok: false, code: 'oversized', message: 'This document is too large to read.' })
  assert.deepEqual(found.ok ? found.hits.map((hit) => [hit.path, hit.line]) : found.code, [['budget.pdf', 0]])
  assert.deepEqual(byContent.ok ? byContent.hits : byContent.code, [])
  assert.deepEqual(parser.requests, [])
})

test('listing shows a document as pending until it is parsed, then as ready, and never parses it', async (t) => {
  const { root, context, parser } = makeDocumentFolder(t)
  writeFile(root, 'reports/q3.pdf', 'Q3 revenue rose 12 percent.\n')
  const statusOf = async (): Promise<string | undefined> => {
    const listed = await listFolder(context, 'reports')
    return listed.ok ? listed.entries.find((entry) => entry.path === 'reports/q3.pdf')?.status : listed.code
  }

  const before = await statusOf()
  const requestsAfterListing = parser.requests.length
  await readFolderFile(context, 'reports/q3.pdf')
  const after = await statusOf()

  assert.deepEqual([before, requestsAfterListing, after], ['pending', 0, 'ready'])
})

test('search finds words inside a parsed document, with the matching line', async (t) => {
  const { root, context } = makeDocumentFolder(t)
  writeFile(root, 'reports/q3.pdf', 'Quarterly report\nQ3 revenue rose 12 percent.\n')
  await readFolderFile(context, 'reports/q3.pdf')

  const found = await searchFolder(context, 'revenue rose')

  assert.ok(found.ok)
  assert.deepEqual(found.hits.map((hit) => [hit.path, hit.line, hit.snippet]), [['reports/q3.pdf', 2, 'Q3 revenue rose 12 percent.']])
  assert.deepEqual([found.searchedDocuments, found.eligibleDocuments, found.pendingDocuments], [1, 1, 0])
})

test('search lists a pending document whose name matches as re-indexing, and counts every pending document', async (t) => {
  const { root, context, parser } = makeDocumentFolder(t)
  writeFile(root, 'budget-2026.pdf', 'Capital budget.\n')
  writeFile(root, 'minutes.docx', 'Budget approved.\n')

  const found = await searchFolder(context, 'budget')

  assert.ok(found.ok)
  assert.deepEqual(found.hits.map((hit) => [hit.path, hit.line, hit.pending ?? false]), [['budget-2026.pdf', 0, true]])
  assert.equal(found.pendingDocuments, 2)
  assert.deepEqual(parser.requests, [], 'a search never parses')
})

test('parsed document text a search reads counts against its scan budget', async (t) => {
  const { root, context } = makeDocumentFolder(t)
  const text = `zebra ${'x'.repeat(993)}\n`
  writeFile(root, 'a.pdf', text)
  writeFile(root, 'b.pdf', text)
  await readFolderFile(context, 'a.pdf')
  await readFolderFile(context, 'b.pdf')

  const found = await searchFolder(context, 'zebra', { maxScanBytes: 1_500 })

  assert.ok(found.ok)
  assert.deepEqual([found.hits.length, found.searchedDocuments, found.partial], [1, 1, true])
})
