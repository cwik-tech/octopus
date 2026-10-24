import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  DefaultBatchFolderAccessPolicy,
} from '../../domains/batches/batch-folder-access.js'
import {
  isPathEqualOrInside,
  isPathInside,
  resolveCanonicalDirectory,
} from '../../core/path-safety.js'

test('Batch path helpers preserve equal-or-inside and strict-inside semantics', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-path-safety-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const child = path.join(root, 'child')
  await fs.mkdir(child)

  assert.equal(await resolveCanonicalDirectory(root), await fs.realpath(root))
  assert.equal(await resolveCanonicalDirectory(path.join(root, 'missing')), null)
  assert.equal(isPathEqualOrInside(root, root), true)
  assert.equal(isPathEqualOrInside(root, child), true)
  assert.equal(isPathInside(root, root), false)
  assert.equal(isPathInside(root, child), true)
})

test('Batch folder access accepts canonical workspace/repository roots and exact grants', async (t) => {
  const owner = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-access-'))
  t.after(() => fs.rm(owner, { recursive: true, force: true }))
  const workspacePath = path.join(owner, 'workspace')
  const repoRootPath = path.join(owner, 'repo')
  const externalPath = path.join(owner, 'external')
  await Promise.all([
    fs.mkdir(path.join(workspacePath, 'inside'), { recursive: true }),
    fs.mkdir(path.join(repoRootPath, 'inside'), { recursive: true }),
    fs.mkdir(path.join(externalPath, 'inside'), { recursive: true }),
  ])
  const grants = new Set([await fs.realpath(externalPath)])
  const policy = new DefaultBatchFolderAccessPolicy({
    workspacePath,
    repoRootPath,
    listGrants: async () => [...grants],
  })

  assert.equal(await policy.resolveAllowedFolder(path.join(workspacePath, 'inside')), await fs.realpath(path.join(workspacePath, 'inside')))
  assert.equal(await policy.resolveAllowedFolder(path.join(repoRootPath, 'inside')), await fs.realpath(path.join(repoRootPath, 'inside')))
  assert.equal(await policy.resolveAllowedFolder(path.join(externalPath, 'inside')), await fs.realpath(path.join(externalPath, 'inside')))
  grants.clear()
  assert.equal(await policy.resolveAllowedFolder(path.join(externalPath, 'inside')), null)
})

test('Batch folder access rejects missing paths and symlink escapes', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-access-workspace-'))
  const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-access-outside-'))
  t.after(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true })
    await fs.rm(outsidePath, { recursive: true, force: true })
  })
  const policy = new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath })

  assert.equal(await policy.resolveAllowedFolder(path.join(workspacePath, 'missing')), null)
  if (process.platform !== 'win32') {
    const linked = path.join(workspacePath, 'linked')
    await fs.symlink(outsidePath, linked)
    assert.equal(await policy.resolveAllowedFolder(linked), null)
  }
})
