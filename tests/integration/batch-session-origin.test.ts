import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { WorkspaceProjectService } from '../../domains/projects/workspace-project-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { BatchSessionOrigin } from '../../contracts/sessions.js'

const ORIGIN: BatchSessionOrigin = {
  kind: 'batch',
  batchId: 'batch_00000000-0000-4000-8000-000000000001',
  executionId: 'exec_00000000-0000-4000-8000-000000000002',
  itemId: 'item_00000000-0000-4000-8000-000000000003',
}

test('session metadata persists immutable Batch origin while legacy sessions omit it', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-session-origin-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const store = new FileSystemSessionStore(workspacePath)
  const batchSession = await store.createSession({ title: 'Batch item', origin: ORIGIN })
  const ordinarySession = await store.createSession({ title: 'Ordinary' })

  const restarted = new FileSystemSessionStore(workspacePath)
  assert.deepEqual((await restarted.getSession(batchSession.id))?.origin, ORIGIN)
  assert.equal((await restarted.getSession(ordinarySession.id))?.origin, undefined)

  const metadataPath = path.join(workspacePath, 'sessions', batchSession.id, 'session.json')
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
  metadata.origin.itemId = '../invalid'
  await fs.writeFile(metadataPath, JSON.stringify(metadata))
  assert.equal(await restarted.getSession(batchSession.id), null)
})

test('project-owned session creation preserves the same Batch origin', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-project-session-origin-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const service = new WorkspaceProjectService({
    projectStore: new WorkspaceProjectStore({ workspacePath }),
    membershipStore: new WorkspaceProjectMembershipStore({ workspacePath }),
    sessionStore,
  })
  const project = await service.createProject({ name: 'Owner' })
  const session = await service.createSession({
    title: 'Project Batch item',
    projectId: project.id,
    origin: ORIGIN,
  })
  assert.equal(session.projectId, project.id)
  assert.deepEqual(session.origin, ORIGIN)
  assert.deepEqual((await service.getSession(session.id))?.origin, ORIGIN)
})
