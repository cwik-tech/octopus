import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { DefaultBatchFolderAccessPolicy } from '../../domains/batches/batch-folder-access.js'
import { BatchStore } from '../../domains/batches/batch-store.js'
import { WorkspaceProjectMembershipStore } from '../../domains/projects/project-membership-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import {
  WorkspaceProjectService,
  WorkspaceProjectServiceError,
} from '../../domains/projects/workspace-project-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import {
  BatchService,
  BatchServiceError,
  hasProjectBatchReferenceInFile,
} from '../../services/batch-service.js'

test('Batch definitions require active projects and block referenced project deletion', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-project-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const sourcePath = path.join(workspacePath, 'source')
  await fs.mkdir(sourcePath)
  await fs.writeFile(path.join(sourcePath, 'one.txt'), 'one')
  const projectStore = new WorkspaceProjectStore({ workspacePath })
  const membershipStore = new WorkspaceProjectMembershipStore({ workspacePath })
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  const projectService = new WorkspaceProjectService({
    projectStore,
    membershipStore,
    sessionStore,
    hasBlockingReference: (projectId) => hasProjectBatchReferenceInFile(definitionsPath, projectId),
  })
  const project = await projectService.createProject({ name: 'Batch owner' })
  const service = new BatchService({
    workspacePath,
    store: new BatchStore({ workspacePath }),
    folderAccessPolicy: new DefaultBatchFolderAccessPolicy({ workspacePath, repoRootPath: workspacePath }),
    validateWorkflow: async () => true,
    validateProject: async (projectId) => {
      const candidate = await projectService.getProject(projectId).catch(() => null)
      return candidate?.status === 'active'
    },
  })
  await service.initialize()
  const batch = await service.create({
    name: 'Project files',
    workflowId: 'workflow',
    folderPath: sourcePath,
    fileExtensions: [],
    rerunPolicy: 'always',
    projectId: project.id,
  })
  assert.equal(batch.projectId, project.id)

  await assert.rejects(
    projectService.hardDeleteProject(project.id),
    (error) => error instanceof WorkspaceProjectServiceError && error.code === 'project_not_empty',
  )
  await projectService.archiveProject(project.id)
  await assert.rejects(
    service.runNow(batch.id),
    (error) => error instanceof BatchServiceError && error.code === 'invalid_batch_request',
  )
})

test('corrupt Batch definition state fails project reference checks closed', async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-project-corrupt-'))
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const definitionsPath = path.join(workspacePath, 'task-queue', 'batches', 'definitions.json')
  await fs.mkdir(path.dirname(definitionsPath), { recursive: true })
  await fs.writeFile(definitionsPath, '{broken')
  await assert.rejects(
    hasProjectBatchReferenceInFile(definitionsPath, '00000000-0000-4000-8000-000000000001'),
    /Batch definitions/i,
  )
  assert.equal(await fs.readFile(definitionsPath, 'utf8'), '{broken')
})
