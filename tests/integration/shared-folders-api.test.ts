import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { z } from 'zod'

import {
  SHARED_FOLDERS_PER_OWNER_LIMIT,
  sharedFolderListResponseSchema,
  sharedFolderViewSchema,
} from '../../contracts/shared-folders.js'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

/**
 * `/sessions/:id/folders` through the real loopback API (LF-02, LF-18).
 *
 * The app data folder here is a parent of nothing the workspace needs, laid
 * out like the desktop: a home folder holding Documents and an app data folder.
 */

async function makeApi(t: TestContext) {
  const fixture = createSchedulerFixture('shared-folders-api-')
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folders-home-')))
  const appDataPath = path.join(home, 'Library', 'Octopus')
  const documents = path.join(home, 'Documents')
  const contracts = path.join(documents, 'Contracts')
  fs.mkdirSync(path.join(appDataPath, 'browser-profile'), { recursive: true })
  fs.mkdirSync(contracts, { recursive: true })
  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
  const batchGrants = new BatchFolderGrantStore(path.join(appDataPath, 'batch-folder-grants.json'))
  await batchGrants.initialize()
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    batchFolderGrantStore: batchGrants,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  t.after(async () => {
    await server.close()
    fixture.cleanup()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const created = await fetch(`${server.url}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Folders' }),
  })
  const { id: sessionId } = (await created.json()) as { id: string }
  const folders = `${server.url}/sessions/${sessionId}/folders`
  const attach = (folderPath: string) => fetch(folders, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
  })
  const createProject = async (name: string): Promise<string> => {
    const response = await fetch(`${server.url}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    })
    assert.equal(response.status, 201)
    return projectIdSchema.parse(await response.json()).id
  }
  const joinProject = async (projectId: string): Promise<void> => {
    const response = await fetch(`${server.url}/projects/${projectId}/sessions/${sessionId}`, { method: 'PUT' })
    assert.equal(response.status, 200)
  }
  const projectFolders = (projectId: string) => `${server.url}/projects/${projectId}/folders`
  const attachToProject = (projectId: string, folderPath: string) => fetch(projectFolders(projectId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
  })
  const makeGrantedFolder = async (name: string): Promise<string> => {
    const folder = path.join(documents, name)
    fs.mkdirSync(folder, { recursive: true })
    await grants.grant(folder)
    return folder
  }
  return {
    server, grants, batchGrants, home, appDataPath, documents, contracts, workspace: fixture.workspacePath, folders, attach,
    createProject, joinProject, projectFolders, attachToProject, makeGrantedFolder,
  }
}

const projectIdSchema = z.object({ id: z.string() })
const errorBodySchema = z.object({ error: z.string(), code: z.string() })

async function listed(url: string) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  return sharedFolderListResponseSchema.parse(await response.json()).folders
}

test('a granted folder is attached once, listed, and removed', async (t) => {
  const api = await makeApi(t)
  await api.grants.grant(api.contracts)

  const first = await api.attach(api.contracts)
  const again = await api.attach(api.contracts)
  const listed = (await (await fetch(api.folders)).json()) as { folders: Array<{ id: string; path: string; label: string }> }

  assert.equal(first.status, 201)
  assert.equal(again.status, 200)
  const folder = (await first.json()) as { id: string }
  assert.deepEqual(listed.folders.map((entry) => [entry.path, entry.label]), [[api.contracts, 'Contracts']])
  assert.equal((await fetch(`${api.folders}/${folder.id}`, { method: 'DELETE' })).status, 204)
  assert.deepEqual(((await (await fetch(api.folders)).json()) as { folders: unknown[] }).folders, [])
})

test('a folder the person never picked is refused', async (t) => {
  const api = await makeApi(t)

  const refused = await api.attach(api.contracts)

  assert.equal(refused.status, 403)
  assert.equal(((await refused.json()) as { code: string }).code, 'not_granted')
})

test('the app data and the workspace, and folders inside them, are refused even when granted, while a parent of them is accepted', async (t) => {
  const api = await makeApi(t)
  const insideAppData = path.join(api.appDataPath, 'browser-profile')
  for (const folder of [api.home, api.appDataPath, insideAppData, api.workspace]) await api.grants.grant(folder)

  for (const folder of [api.appDataPath, insideAppData, api.workspace]) {
    const refused = await api.attach(folder)
    assert.equal(refused.status, 403, folder)
    assert.equal(((await refused.json()) as { code: string }).code, 'protected_overlap', folder)
  }
  assert.equal((await api.attach(api.home)).status, 201)
})

test('a chat may hold ten of its own folders and the eleventh is refused', async (t) => {
  const api = await makeApi(t)
  for (let index = 0; index <= SHARED_FOLDERS_PER_OWNER_LIMIT; index += 1) {
    const folder = path.join(api.documents, `Folder ${index}`)
    fs.mkdirSync(folder)
    await api.grants.grant(folder)
    const response = await api.attach(folder)
    assert.equal(response.status, index < SHARED_FOLDERS_PER_OWNER_LIMIT ? 201 : 409, `folder ${index}`)
  }
})

test('an unknown chat is answered with not found', async (t) => {
  const api = await makeApi(t)

  const response = await fetch(`${api.server.url}/sessions/${randomUUID()}/folders`)

  assert.equal(response.status, 404)
})

test('a folder granted only for Batch, or only by a grant on its parent, is refused', async (t) => {
  const api = await makeApi(t)
  await api.batchGrants.grant(api.contracts)
  await api.grants.grant(api.documents)

  const refused = await api.attach(api.contracts)

  assert.equal(refused.status, 403)
  assert.equal(((await refused.json()) as { code: string }).code, 'not_granted')
})

/*
 * Phase 2: `/projects/:id/folders`, and a chat's view of its project's folders
 * (docs/feature-local-folder-access.md, Flows A and B).
 */

test('a granted folder is added to a project once, listed with the project, and removed', async (t) => {
  const api = await makeApi(t)
  const projectId = await api.createProject('Acme')
  await api.grants.grant(api.contracts)

  const first = await api.attachToProject(projectId, api.contracts)
  const again = await api.attachToProject(projectId, api.contracts)
  const folders = await listed(api.projectFolders(projectId))

  assert.equal(first.status, 201)
  assert.equal(again.status, 200)
  const folder = sharedFolderViewSchema.parse(await first.json())
  assert.equal(sharedFolderViewSchema.parse(await again.json()).id, folder.id)
  assert.deepEqual(
    folders.map((entry) => [entry.id, entry.path, entry.label, entry.source, entry.projectId, entry.projectName]),
    [[folder.id, api.contracts, 'Contracts', 'project', projectId, 'Acme']],
  )
  assert.equal((await fetch(`${api.projectFolders(projectId)}/${folder.id}`, { method: 'DELETE' })).status, 204)
  assert.deepEqual(await listed(api.projectFolders(projectId)), [])
})

test('a project may hold ten folders and the eleventh is refused', async (t) => {
  const api = await makeApi(t)
  const projectId = await api.createProject('Acme')
  for (let index = 0; index < SHARED_FOLDERS_PER_OWNER_LIMIT; index += 1) {
    const response = await api.attachToProject(projectId, await api.makeGrantedFolder(`Folder ${index}`))
    assert.equal(response.status, 201, `folder ${index}`)
  }

  const refused = await api.attachToProject(projectId, await api.makeGrantedFolder('One too many'))

  assert.equal(refused.status, 409)
  assert.deepEqual(errorBodySchema.parse(await refused.json()), {
    error: 'A project can have up to 10 folders.',
    code: 'shared_folder_limit',
  })
  assert.equal((await listed(api.projectFolders(projectId))).length, SHARED_FOLDERS_PER_OWNER_LIMIT)
})

test('a project refuses a folder the person never picked, and one inside the app data', async (t) => {
  const api = await makeApi(t)
  const projectId = await api.createProject('Acme')
  const insideAppData = path.join(api.appDataPath, 'browser-profile')
  await api.grants.grant(insideAppData)

  const notPicked = await api.attachToProject(projectId, api.contracts)
  const holdsAppData = await api.attachToProject(projectId, insideAppData)

  assert.equal(notPicked.status, 403)
  assert.equal(errorBodySchema.parse(await notPicked.json()).code, 'not_granted')
  assert.equal(holdsAppData.status, 403)
  assert.equal(errorBodySchema.parse(await holdsAppData.json()).code, 'protected_overlap')
  assert.deepEqual(await listed(api.projectFolders(projectId)), [])
})

test('a chat lists its project folders first, with the project name, then its own', async (t) => {
  const api = await makeApi(t)
  const projectId = await api.createProject('Acme')
  await api.joinProject(projectId)
  const own = await api.makeGrantedFolder('Research notes')
  const shared = await api.makeGrantedFolder('Brand assets')
  assert.equal((await api.attach(own)).status, 201)
  assert.equal((await api.attachToProject(projectId, shared)).status, 201)

  const folders = await listed(api.folders)

  assert.deepEqual(
    folders.map((entry) => [entry.label, entry.source, entry.projectId, entry.projectName]),
    [
      ['Brand assets', 'project', projectId, 'Acme'],
      ['Research notes', 'session', undefined, undefined],
    ],
  )
})

test('a folder the chat project already shares is refused for the chat, and nothing is added', async (t) => {
  const api = await makeApi(t)
  const projectId = await api.createProject('Acme')
  await api.joinProject(projectId)
  await api.grants.grant(api.contracts)
  assert.equal((await api.attachToProject(projectId, api.contracts)).status, 201)

  const refused = await api.attach(api.contracts)

  assert.equal(refused.status, 409)
  assert.deepEqual(errorBodySchema.parse(await refused.json()), {
    error: 'This folder is already shared with the project "Acme".',
    code: 'already_in_project',
  })
  assert.deepEqual((await listed(api.folders)).map((entry) => entry.source), ['project'])
})

test('folders of an unknown project are answered with not found, and a malformed ID with bad request', async (t) => {
  const api = await makeApi(t)
  await api.grants.grant(api.contracts)

  const unknownList = await fetch(api.projectFolders(randomUUID()))
  const unknownAdd = await api.attachToProject(randomUUID(), api.contracts)
  const malformed = await fetch(api.projectFolders('not-a-project'))

  assert.equal(unknownList.status, 404)
  assert.equal(unknownAdd.status, 404)
  assert.equal(malformed.status, 400)
  assert.equal(fs.existsSync(path.join(api.workspace, 'projects', 'not-a-project')), false)
})

test('an archived project lists its folders but refuses to change them', async (t) => {
  const api = await makeApi(t)
  const projectId = await api.createProject('Acme')
  await api.grants.grant(api.contracts)
  const kept = sharedFolderViewSchema.parse(await (await api.attachToProject(projectId, api.contracts)).json())
  const archived = await fetch(`${api.server.url}/projects/${projectId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'archived' }),
  })
  assert.equal(archived.status, 200)
  const other = await api.makeGrantedFolder('Other')

  const add = await api.attachToProject(projectId, other)
  const remove = await fetch(`${api.projectFolders(projectId)}/${kept.id}`, { method: 'DELETE' })

  assert.equal(add.status, 409)
  assert.equal(errorBodySchema.parse(await add.json()).code, 'archived_project')
  assert.equal(remove.status, 409)
  assert.deepEqual((await listed(api.projectFolders(projectId))).map((entry) => entry.id), [kept.id])
})

test('another letter-case spelling of a chat ID is not found, so it cannot bypass the chat\'s project rules', async (t) => {
  const api = await makeApi(t)
  await api.grants.grant(api.contracts)
  const sessionId = api.folders.split('/sessions/')[1]?.split('/')[0] ?? ''
  assert.notEqual(sessionId, '')

  const upper = await fetch(`${api.server.url}/sessions/${sessionId.toUpperCase()}/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: api.contracts }),
  })

  assert.equal(upper.status, 404)
  assert.deepEqual(((await (await fetch(api.folders)).json()) as { folders: unknown[] }).folders, [])
})
