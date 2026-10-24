import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { z } from 'zod'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { StandInFileParser } from '../support/stand-in-file-parser.js'

/**
 * Deleting the chat or project that holds a folder's last attachment
 * (docs/feature-local-folder-access.md, "Scheduling and publishing",
 * Retention; LF-12 for parses and cache).
 *
 * Through the real loopback API, session and project stores, grant list,
 * folder store and folder index. Only the parser process is replaced, by a
 * gated stand-in, because each test needs parses still running when the
 * owner is deleted; no real parse can promise that.
 */

/** These journeys start no workflow runs. */
const noRuns: RunLauncher = { async startRun() { return { launched: true, pid: 0, cwd: '' } } }
const createdSchema = z.object({ id: z.string() })

async function makeApi(t: TestContext) {
  const fixture = createSchedulerFixture('shared-folder-owner-deletion-')
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-owner-deletion-user-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-owner-deletion-appdata-')))
  fs.writeFileSync(path.join(userFolder, 'a.pdf'), 'Alpha secret text.\n')
  fs.writeFileSync(path.join(userFolder, 'b.pdf'), 'Beta still being parsed.\n')
  fs.writeFileSync(path.join(userFolder, 'c.pdf'), 'Gamma still being parsed.\n')
  const parser = new StandInFileParser('gated')
  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
  await grants.grant(userFolder)
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: noRuns,
    fileParserLauncher: parser,
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  t.after(async () => {
    await server.close()
    fixture.cleanup()
    fs.rmSync(userFolder, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })
  const post = async (url: string, body: unknown): Promise<string> => {
    const response = await fetch(`${server.url}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 201, await response.clone().text())
    return createdSchema.parse(await response.json()).id
  }
  const indexRoot = path.join(fixture.workspacePath, 'folder-index')
  return {
    server,
    parser,
    userFolder,
    post,
    /** One folder per entry in the workspace's folder index. */
    cachedFolders: (): string[] => (fs.existsSync(indexRoot) ? fs.readdirSync(indexRoot) : []),
    /** The names of every parsed text file in the folder index. */
    parsedTexts: (): string[] => (fs.existsSync(indexRoot)
      ? fs.readdirSync(indexRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.pdf.md'))
        .map((entry) => entry.name)
      : []),
  }
}

/**
 * Attaching started the folder's parses: a.pdf and b.pdf run, c.pdf waits for
 * a slot. Once a.pdf finishes, c.pdf takes its slot, which happens only after
 * a.pdf's text was published.
 */
async function parseFirstDocument(api: Awaited<ReturnType<typeof makeApi>>): Promise<void> {
  await Promise.all([api.parser.whenLaunched('a.pdf'), api.parser.whenLaunched('b.pdf')])
  await api.parser.finish('a.pdf')
  await api.parser.whenLaunched('c.pdf')
}

async function deleted(response: Response): Promise<void> {
  assert.equal(response.status, 204, await response.clone().text())
}

test("deleting the chat that held a folder's last attachment stops its parses and deletes its parsed text", async (t) => {
  const api = await makeApi(t)
  const sessionId = await api.post('/sessions', { title: 'Board' })
  await api.post(`/sessions/${sessionId}/folders`, { path: api.userFolder })
  await parseFirstDocument(api)
  const textBefore = api.parsedTexts()

  await deleted(await fetch(`${api.server.url}/sessions/${sessionId}`, { method: 'DELETE' }))

  assert.deepEqual(textBefore, ['a.pdf.md'])
  assert.deepEqual(
    { b: api.parser.isAborted('b.pdf'), c: api.parser.isAborted('c.pdf'), cached: api.cachedFolders() },
    { b: true, c: true, cached: [] },
  )
})

test("deleting the project that held a folder's last attachment, keeping its chats, stops its parses and deletes its parsed text", async (t) => {
  const api = await makeApi(t)
  const projectId = await api.post('/projects', { name: 'Board' })
  await api.post(`/projects/${projectId}/folders`, { path: api.userFolder })
  await parseFirstDocument(api)
  const textBefore = api.parsedTexts()

  await deleted(await fetch(`${api.server.url}/projects/${projectId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'ungroup_sessions' }),
  }))

  assert.deepEqual(textBefore, ['a.pdf.md'])
  assert.deepEqual(
    { b: api.parser.isAborted('b.pdf'), c: api.parser.isAborted('c.pdf'), cached: api.cachedFolders() },
    { b: true, c: true, cached: [] },
  )
})

test("deleting an empty project that held a folder's last attachment stops its parses and deletes its parsed text", async (t) => {
  const api = await makeApi(t)
  const projectId = await api.post('/projects', { name: 'Board' })
  await api.post(`/projects/${projectId}/folders`, { path: api.userFolder })
  await parseFirstDocument(api)
  const textBefore = api.parsedTexts()

  await deleted(await fetch(`${api.server.url}/projects/${projectId}`, { method: 'DELETE' }))

  assert.deepEqual(textBefore, ['a.pdf.md'])
  assert.deepEqual(
    { b: api.parser.isAborted('b.pdf'), c: api.parser.isAborted('c.pdf'), cached: api.cachedFolders() },
    { b: true, c: true, cached: [] },
  )
})
