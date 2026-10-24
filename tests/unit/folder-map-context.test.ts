import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { estimateContextTokens } from '../../core/context-tokens.js'
import { folderIndexDocuments } from '../../domains/shared-folders/folder-documents.js'
import { FolderIndex, type FolderIndexOptions } from '../../domains/shared-folders/folder-index.js'
import { buildFolderMapContext } from '../../services/folder-map-context.js'
import type { TurnFolder } from '../../services/folder-tool-adapters.js'
import { StandInFileParser } from '../support/stand-in-file-parser.js'

/**
 * The folder map a turn's prompt carries (LF-04).
 *
 * The map is the agent's only view of a folder before it calls a tool, so it
 * must name the folder and its structure, never its contents, and stay inside
 * its share of the prompt however large or oddly named the folder is.
 */

const granted = { isRootGranted: async () => true, isProtected: async () => false }

function makeRoot(t: TestContext, name = 'Contracts'): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-map-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, name)
  fs.mkdirSync(root, { recursive: true })
  return root
}

function write(root: string, relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true })
  fs.writeFileSync(path.join(root, relativePath), content)
}

test('the map names the folder and its structure, and never its contents', async (t) => {
  const root = makeRoot(t)
  write(root, 'Clients/Acme/notes.md', 'SECRET-CONTENT-ALPHA')
  write(root, 'Templates/nda.txt', 'SECRET-CONTENT-BETA')
  write(root, 'pricing.csv', 'a,b')

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }],
    policy: granted,
    maxTokens: 2_000,
  })

  assert.match(map, /trust="untrusted_user_content"/)
  assert.match(map, /<folder id="f_aaaaaaaaaa" name="Contracts" source="session">/)
  assert.match(map, /3 files/)
  for (const name of ['Clients/', 'Acme/', 'notes.md', 'Templates/', 'nda.txt', 'pricing.csv']) {
    assert.ok(map.includes(name), `map shows ${name}`)
  }
  assert.equal(map.includes('SECRET-CONTENT'), false)
  for (const tool of ['folder_list', 'folder_search', 'folder_read']) assert.ok(map.includes(tool))
})

test('names from disk are escaped, stripped of control characters and cut at a character boundary', async (t) => {
  const root = makeRoot(t, 'Q3 <script>alert(1)')
  // 119 letters and five emoji: 124 characters, under macOS's 255-byte name
  // limit. A 120-character cut lands on the first emoji, which a cut counted in
  // UTF-16 units would split in half.
  const longName = `${'a'.repeat(119)}${'📁'.repeat(5)}.md`
  write(root, longName, 'x')
  write(root, 'bell\u0007name.md', 'x')

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: path.basename(root), root, source: 'project' }],
    policy: granted,
    maxTokens: 2_000,
  })

  assert.ok(map.includes('Q3 &lt;script&gt;alert(1)'))
  assert.equal(map.includes('<script>'), false)
  assert.equal(map.includes('\u0007'), false)
  assert.ok(map.includes('bellname.md'))
  assert.ok(map.includes(`${'a'.repeat(119)}📁`), 'the cut keeps the whole character at the boundary')
  assert.equal(map.includes(`${'a'.repeat(119)}📁📁`), false, 'a long name is cut at 120 characters')
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(map), false, 'no broken surrogate pair')
})

test('a large folder shrinks to fit the token budget and still names the folder', async (t) => {
  const root = makeRoot(t)
  for (let client = 0; client < 40; client += 1) {
    for (let file = 0; file < 12; file += 1) {
      write(root, `Clients/Client ${client}/Year ${2020 + (file % 4)}/contract-${file}.md`, 'x')
    }
  }
  const maxTokens = 400

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }],
    policy: granted,
    maxTokens,
    // This case measures token truncation; deadline behavior has its own
    // injected-clock test below. Real filesystem load must not change the count.
    limits: { now: () => 0 },
  })

  assert.ok(estimateContextTokens(map) <= maxTokens, `map took ${estimateContextTokens(map)} tokens`)
  assert.ok(map.includes('f_aaaaaaaaaa'))
  assert.match(map, /480 files/)
})

test('a folder that was moved away, or whose access was removed, is named with its state', async (t) => {
  const missing = path.join(makeRoot(t), 'gone')
  const revokedRoot = makeRoot(t, 'Revoked')

  const map = await buildFolderMapContext({
    folders: [
      { id: 'f_aaaaaaaaaa', label: 'Gone', root: missing, source: 'session' },
      { id: 'f_bbbbbbbbbb', label: 'Revoked', root: revokedRoot, source: 'session' },
    ],
    policy: { isRootGranted: async (root) => root !== revokedRoot, isProtected: async () => false },
    maxTokens: 2_000,
  })

  assert.match(map, /f_aaaaaaaaaa[\s\S]*Folder not found/)
  assert.match(map, /f_bbbbbbbbbb[\s\S]*Access removed/)
})

test('a folder whose parent was swapped for a symlink is mapped as not found, and nothing outside is named', async (t) => {
  const base = makeRoot(t, 'base')
  const owner = path.join(base, 'owner')
  const root = path.join(owner, 'Shared')
  write(root, 'inside.md', 'x')
  write(path.join(base, 'outside', 'Shared'), 'outside-secret-name.md', 'x')
  fs.renameSync(owner, path.join(base, 'owner-old'))
  fs.symlinkSync(path.join(base, 'outside'), owner)

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Shared', root, source: 'session' }],
    policy: granted,
    maxTokens: 2_000,
  })

  assert.equal(map.includes('outside-secret-name'), false)
  assert.match(map, /f_aaaaaaaaaa[\s\S]*Folder not found/)
})

test('a folder swapped out and back while the map is built never counts an outside file', async (t) => {
  const base = makeRoot(t, 'base')
  const owner = path.join(base, 'owner')
  const root = path.join(owner, 'Shared')
  write(root, 'notes/plan.md', 'x')
  write(root, 'notes/z-last.md', 'x')
  const outsidePlan = path.join(base, 'outside', 'Shared', 'notes', 'plan.md')
  write(path.join(base, 'outside', 'Shared'), 'notes/plan.md', '')
  fs.truncateSync(outsidePlan, 7 * 1024 * 1024)
  // Out just before `plan.md` is measured, back just before `z-last.md` is.
  const swapping = {
    isRootGranted: async () => true,
    isProtected: async (absolutePath: string) => {
      if (absolutePath === path.join(root, 'notes', 'plan.md')) {
        fs.renameSync(owner, path.join(base, 'owner-old'))
        fs.symlinkSync(path.join(base, 'outside'), owner)
      } else if (absolutePath === path.join(root, 'notes', 'z-last.md') && fs.lstatSync(owner).isSymbolicLink()) {
        fs.unlinkSync(owner)
        fs.renameSync(path.join(base, 'owner-old'), owner)
      }
      return false
    },
  }

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Shared', root, source: 'session' }],
    policy: swapping,
    maxTokens: 2_000,
  })

  assert.equal(map.includes('7 MB'), false, map)
})

test("a folder whose own directory can't be read is mapped as Can't read folder",
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const root = makeRoot(t, 'Locked')
    write(root, 'notes.md', 'x')
    fs.chmodSync(root, 0o000)

    // Restored before the folder is removed, which a locked folder would refuse.
    const map = await buildFolderMapContext({
      folders: [{ id: 'f_aaaaaaaaaa', label: 'Locked', root, source: 'session' }],
      policy: granted,
      maxTokens: 2_000,
    }).finally(() => fs.chmodSync(root, 0o755))

    assert.match(map, /f_aaaaaaaaaa[\s\S]*Status: Can't read folder\./)
  })

test('a cancelled turn stops building the map, before or during the walk', async (t) => {
  const root = makeRoot(t)
  write(root, 'a.md', 'x')
  write(root, 'b.md', 'x')
  const before = new AbortController()
  before.abort()
  const during = new AbortController()
  // Cancelled at the moment the walk reaches its first file.
  const abortingPolicy = {
    isRootGranted: async () => true,
    isProtected: async (absolutePath: string) => {
      if (absolutePath === path.join(root, 'a.md')) during.abort()
      return false
    },
  }
  const folders = [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' as const }]

  await assert.rejects(
    buildFolderMapContext({ folders, policy: granted, maxTokens: 2_000, signal: before.signal }),
    { name: 'AbortError' },
  )
  await assert.rejects(
    buildFolderMapContext({ folders, policy: abortingPolicy, maxTokens: 2_000, signal: during.signal }),
    { name: 'AbortError' },
  )
})

test('a subfolder that can be read but not entered marks the map partial, instead of showing it empty',
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const root = makeRoot(t)
    write(root, 'open/a.md', 'x')
    write(root, 'locked/b.md', 'x')
    const locked = path.join(root, 'locked')
    // Its entries can be named but not measured: `r` without `x`.
    fs.chmodSync(locked, 0o644)

    // Restored before the folder is removed, which a locked folder would refuse.
    const map = await buildFolderMapContext({
      folders: [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }],
      policy: granted,
      maxTokens: 2_000,
    }).finally(() => fs.chmodSync(locked, 0o755))

    assert.match(map, /Status: partial \(1 folder can't be read\)\./)
  })

test('a folder moved away while the map is built is mapped as not found', async (t) => {
  const base = makeRoot(t, 'base')
  const root = path.join(base, 'Shared')
  write(root, 'a.md', 'x')
  write(root, 'b.md', 'x')
  // The user moves the folder as the walk reaches its first file.
  const moving = {
    isRootGranted: async () => true,
    isProtected: async (absolutePath: string) => {
      if (absolutePath === path.join(root, 'a.md')) fs.renameSync(root, path.join(base, 'Shared-moved'))
      return false
    },
  }

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Shared', root, source: 'session' }],
    policy: moving,
    maxTokens: 2_000,
  })

  assert.match(map, /f_aaaaaaaaaa[\s\S]*Status: Folder not found at its saved path\./)
})

/** The status line of one folder's block in the map. */
function statusOf(map: string, folderId: string): string | undefined {
  const block = map.slice(map.indexOf(`<folder id="${folderId}"`))
  return block.split('\n').find((line) => line.trim().startsWith('Status:'))?.trim()
}

/** A promise the test settles when an event it waits for has happened. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

test('a map that runs out of time shows the folders it finished, marks the rest partial with the reason, and returns', async (t) => {
  const done = makeRoot(t, 'Done')
  write(done, 'only.md', 'x')
  const slow = makeRoot(t, 'Slow')
  write(slow, 'a.md', 'x')
  write(slow, 'b.md', 'x')
  let clock = 0
  const doneMeasured = deferred()
  // A minute passes while Slow is walked, once Done has reached its last file:
  // far longer than a turn should wait for its map.
  const policy = {
    isRootGranted: async () => true,
    isProtected: async (absolutePath: string) => {
      if (absolutePath === path.join(done, 'only.md')) doneMeasured.resolve()
      if (absolutePath === path.join(slow, 'a.md')) {
        await doneMeasured.promise
        clock = 60_000
      }
      return false
    },
  }

  const map = await buildFolderMapContext({
    folders: [
      { id: 'f_aaaaaaaaaa', label: 'Done', root: done, source: 'session' },
      { id: 'f_bbbbbbbbbb', label: 'Slow', root: slow, source: 'session' },
    ],
    policy,
    maxTokens: 2_000,
    limits: { now: () => clock },
  })

  assert.deepEqual(
    { done: statusOf(map, 'f_aaaaaaaaaa'), slow: statusOf(map, 'f_bbbbbbbbbb') },
    { done: 'Status: ready.', slow: 'Status: partial (ran out of time after listing 1 file).' },
  )
})

test("a folder locked while the map walks it is mapped as Can't read folder, not as an empty ready folder",
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const root = makeRoot(t, 'Locked')
    write(root, 'a.md', 'x')
    write(root, 'b.md', 'x')
    // Locked as the walk measures its first file.
    const locking = {
      isRootGranted: async () => true,
      isProtected: async (absolutePath: string) => {
        if (absolutePath === path.join(root, 'a.md')) fs.chmodSync(root, 0o000)
        return false
      },
    }

    // Restored before the folder is removed, which a locked folder would refuse.
    const map = await buildFolderMapContext({
      folders: [{ id: 'f_aaaaaaaaaa', label: 'Locked', root, source: 'session' }],
      policy: locking,
      maxTokens: 2_000,
    }).finally(() => fs.chmodSync(root, 0o755))

    assert.equal(statusOf(map, 'f_aaaaaaaaaa'), "Status: Can't read folder.")
  })

test('a folder holding paths too long for the system to name is mapped as partial, not ready', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-map-deep-')))
  // `rm` steps down by relative names; a removal that names each path in full can't reach the deep end.
  t.after(() => execFileSync('rm', ['-rf', base]))
  const root = path.join(base, 'Deep')
  fs.mkdirSync(root)
  // Folders with 250-character names, each holding a file named as long, nested
  // past 4,200 bytes: longer than macOS (1,024) or Linux (4,096) lets a call name.
  const levels: string[] = []
  while (Buffer.byteLength(path.join(root, ...levels)) < 4_200) levels.push(`${String(levels.length).padStart(2, '0')}${'d'.repeat(248)}`)
  const longFile = `${'f'.repeat(247)}.md`
  execFileSync('sh', ['-c', levels.map((name) => `mkdir ${name} && cd ${name} && echo x > ${longFile}`).join(' && ')], { cwd: root })

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Deep', root, source: 'session' }],
    policy: granted,
    maxTokens: 2_000,
  })

  assert.match(statusOf(map, 'f_aaaaaaaaaa') ?? '', /^Status: partial \(1 folder can't be read; 1 file can't be read\)\.$/)
})

/**
 * A folder index whose cache sits beside the folder, with only the parser
 * process replaced by a stand-in that "parses" a document into its own bytes.
 */
function indexedPolicy(t: TestContext, parser: StandInFileParser, limits: FolderIndexOptions['limits'] = {}) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-map-workspace-')))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const index = new FolderIndex({ workspacePath: workspace, launcher: parser, isRetained: async () => true, limits })
  return { index, policy: { ...granted, documents: folderIndexDocuments(index) } }
}

test('a folder whose documents are not parsed yet is mapped as indexing, with how many are waiting', async (t) => {
  const root = makeRoot(t)
  write(root, 'Reports/q3.pdf', 'Q3 revenue rose 12 percent.')
  write(root, 'Reports/q4.docx', 'Q4 revenue fell.')
  write(root, 'notes.md', 'Plain text is read live.')
  const parser = new StandInFileParser('gated')
  const { policy } = indexedPolicy(t, parser)

  const map = await buildFolderMapContext({
    folders: [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }],
    policy,
    maxTokens: 2_000,
  })

  assert.equal(statusOf(map, 'f_aaaaaaaaaa'), 'Status: indexing (2 documents waiting to be parsed).')
})

test('a folder whose parsing reached a limit is mapped as partial, naming the limit', async (t) => {
  const root = makeRoot(t)
  write(root, 'a.pdf', 'Twenty bytes of text')
  write(root, 'b.pdf', 'Twenty more bytes!!!')
  const { index, policy } = indexedPolicy(t, new StandInFileParser(), { maxInputBytesPerFolder: 30 })
  const folders: TurnFolder[] = [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }]
  await buildFolderMapContext({ folders, policy, maxTokens: 2_000 })
  await index.whenIdle()

  const map = await buildFolderMapContext({ folders, policy, maxTokens: 2_000 })

  assert.equal(statusOf(map, 'f_aaaaaaaaaa'), 'Status: partial (Documents past 30 bytes were not parsed).')
})

test('a folder whose documents are all parsed is mapped as ready', async (t) => {
  const root = makeRoot(t)
  write(root, 'Reports/q3.pdf', 'Q3 revenue rose 12 percent.')
  const { index, policy } = indexedPolicy(t, new StandInFileParser())
  const folders: TurnFolder[] = [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }]
  await buildFolderMapContext({ folders, policy, maxTokens: 2_000 })
  await index.whenIdle()

  const map = await buildFolderMapContext({ folders, policy, maxTokens: 2_000 })

  assert.equal(statusOf(map, 'f_aaaaaaaaaa'), 'Status: ready.')
  assert.equal(map.includes('Q3 revenue'), false, 'parsed text never enters the map')
})

test("a turn's map is still built, from the walk alone, when the document cache can't be written",
  { skip: process.getuid?.() === 0 ? 'running as root, which ignores folder permissions' : false },
  async (t) => {
    const root = makeRoot(t)
    write(root, 'Reports/q3.pdf', 'Q3 revenue rose 12 percent.')
    const cacheParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-map-locked-')))
    t.after(() => {
      fs.chmodSync(cacheParent, 0o755)
      fs.rmSync(cacheParent, { recursive: true, force: true })
    })
    const locked = new FolderIndex({
      workspacePath: cacheParent,
      launcher: new StandInFileParser(),
      isRetained: async () => true,
    })
    fs.chmodSync(cacheParent, 0o555)

    const map = await buildFolderMapContext({
      folders: [{ id: 'f_aaaaaaaaaa', label: 'Contracts', root, source: 'session' }],
      policy: { ...granted, documents: folderIndexDocuments(locked) },
      maxTokens: 2_000,
    })

    assert.match(map, /<folder id="f_aaaaaaaaaa" name="Contracts" source="session">/)
    assert.ok(map.includes('q3.pdf'))
  })
