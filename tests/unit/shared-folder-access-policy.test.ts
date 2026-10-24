import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { SharedFolderAccessPolicy } from '../../domains/shared-folders/shared-folder-access-policy.js'

/**
 * Which folders may be attached (feature-local-folder-access.md, SEC-2 and
 * SEC-3; LF-02 at its lowest boundary).
 *
 * Real directories throughout: canonical paths, symlinks and containment are
 * filesystem facts, and a stubbed path module would agree with whatever the
 * policy assumed.
 */

function makeTree(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-policy-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const appData = path.join(home, 'Library', 'App')
  const workspace = path.join(appData, 'workspace')
  const documents = path.join(home, 'Documents')
  const projectFolder = path.join(documents, 'Contracts')
  for (const directory of [workspace, projectFolder]) fs.mkdirSync(directory, { recursive: true })
  return { root, home, appData, workspace, documents, projectFolder }
}

function policyFor(protectedPaths: readonly string[], grants: readonly string[]) {
  return new SharedFolderAccessPolicy({ protectedPaths, listGrants: async () => grants })
}

test('a granted folder outside the app data is admitted by its canonical path', async (t) => {
  const tree = makeTree(t)
  const policy = policyFor([tree.appData, tree.workspace], [tree.projectFolder])

  const admitted = await policy.admitRoot(path.join(tree.documents, '.', 'Contracts'))

  assert.deepEqual(admitted, { ok: true, canonicalPath: tree.projectFolder })
})

test('a folder without a grant is refused', async (t) => {
  const tree = makeTree(t)
  const policy = policyFor([tree.appData, tree.workspace], [])

  const admitted = await policy.admitRoot(tree.projectFolder)

  assert.equal(admitted.ok, false)
  assert.equal(admitted.ok ? undefined : admitted.code, 'not_granted')
})

test('a folder inside the workspace is refused even with a grant', async (t) => {
  const tree = makeTree(t)
  const inside = path.join(tree.workspace, 'sessions')
  fs.mkdirSync(inside)
  const policy = policyFor([tree.appData, tree.workspace], [inside])

  const admitted = await policy.admitRoot(inside)

  assert.equal(admitted.ok ? undefined : admitted.code, 'protected_overlap')
})

test('a parent of the app data, such as the home folder, is admitted, and the app data inside it stays protected', async (t) => {
  const tree = makeTree(t)
  const policy = policyFor([tree.appData, tree.workspace], [tree.home])

  const admitted = await policy.admitRoot(tree.home)

  assert.deepEqual(admitted, { ok: true, canonicalPath: tree.home })
  // The tools refuse these paths on every call, so a parent never reveals them.
  assert.equal(await policy.isProtected(path.join(tree.appData, 'provider-settings.json')), true)
  assert.equal(await policy.isProtected(path.join(tree.workspace, 'sessions')), true)
})

test('a workspace moved outside the app data folder is still protected, though its parent can be shared', async (t) => {
  const tree = makeTree(t)
  const movedWorkspace = path.join(tree.documents, 'octopus-workspace')
  const insideMoved = path.join(movedWorkspace, 'sessions')
  fs.mkdirSync(insideMoved, { recursive: true })
  const policy = policyFor([tree.appData, movedWorkspace], [tree.documents, insideMoved])

  const parent = await policy.admitRoot(tree.documents)
  const inside = await policy.admitRoot(insideMoved)

  assert.equal(parent.ok, true)
  assert.equal(inside.ok ? undefined : inside.code, 'protected_overlap')
})

test('a symlink to the app data is judged by where it points', async (t) => {
  const tree = makeTree(t)
  const link = path.join(tree.documents, 'shortcut')
  fs.symlinkSync(tree.appData, link)
  const policy = policyFor([tree.appData, tree.workspace], [tree.documents, tree.appData])

  const admitted = await policy.admitRoot(link)

  assert.equal(admitted.ok ? undefined : admitted.code, 'protected_overlap')
})

test('a relative path, a file, or a missing folder is refused as not a folder', async (t) => {
  const tree = makeTree(t)
  const file = path.join(tree.documents, 'note.txt')
  fs.writeFileSync(file, 'x')
  const policy = policyFor([tree.appData], [tree.documents])

  for (const candidate of ['Documents', file, path.join(tree.documents, 'missing')]) {
    const admitted = await policy.admitRoot(candidate)
    assert.equal(admitted.ok ? undefined : admitted.code, 'not_a_folder', candidate)
  }
})

test('a path inside an attached folder that lies under the app data is reported as protected', async (t) => {
  const tree = makeTree(t)
  const policy = policyFor([tree.appData, tree.workspace], [])

  assert.equal(await policy.isProtected(path.join(tree.workspace, 'sessions', 'x', 'session.json')), true)
  assert.equal(await policy.isProtected(path.join(tree.projectFolder, 'notes.md')), false)
})

test('a grant on a parent folder admits neither the parent\'s subfolders nor a later call for them', async (t) => {
  const tree = makeTree(t)
  // Only the native picker creates grants, and a grant names exactly the folder
  // that was picked. A subfolder of it was never picked.
  const policy = policyFor([tree.appData, tree.workspace], [tree.documents])

  const admitted = await policy.admitRoot(tree.projectFolder)

  assert.equal(admitted.ok ? undefined : admitted.code, 'not_granted')
  assert.equal(await policy.isRootGranted(tree.projectFolder), false)
})

test('a root stays granted only while its own grant exists', async (t) => {
  const tree = makeTree(t)
  let grants: readonly string[] = [tree.projectFolder]
  const policy = new SharedFolderAccessPolicy({
    protectedPaths: [tree.appData],
    listGrants: async () => grants,
  })

  assert.equal(await policy.isRootGranted(tree.projectFolder), true)
  grants = []
  assert.equal(await policy.isRootGranted(tree.projectFolder), false)
})
