import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import {
  isProviderHealthProbe,
  startFakeChatCompletionsServer,
  type FakeChatCompletionsRequest,
} from '../support/fake-chat-completions-server.js'

/**
 * Revoking a shared folder grant from Settings (docs/feature-local-folder-access.md,
 * "Alternative flows": the person revokes the grant in Settings; SEC-9).
 *
 * One journey through the real API, grant store, folder store, turn assembly
 * and native tool loop. The folder stays attached to the chat, so only the
 * grant decides what the agent may read. Only the model is replaced, at its
 * HTTP boundary: after the revocation it asks for a file it could read before.
 */

const SECRET_SENTENCE = 'The vault code is PERSIMMON-7.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultContents(request: FakeChatCompletionsRequest): string[] {
  const messages = request.body.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: unknown) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [])
}

test('revoking a shared folder grant in Settings stops the agent reading that folder on its next tool call', async (t) => {
  const fixture = createSchedulerFixture('shared-folder-grant-settings-')
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-grant-user-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-grant-appdata-')))
  fs.writeFileSync(path.join(userFolder, 'vault.md'), `# Vault\n\n${SECRET_SENTENCE}\n`, 'utf8')

  // The folder ID is only known once the folder is attached.
  const readArguments: Record<string, unknown> = { path: 'vault.md' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          !isProviderHealthProbe(request) &&
          request.toolCount > 0 &&
          toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-vault', name: 'folder_read', arguments: readArguments }],
      },
      { content: 'I could not read it.', deltas: ['I could not read it.'] },
    ],
  })

  const agentName = 'folder-reader'
  const agentDir = path.join(fixture.repoRootPath, 'agents', agentName)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${agentName}.md`),
    [
      '---',
      `name: ${agentName}`,
      'description: Reads attached folders.',
      'tier: execution',
      'provider: lm-studio',
      'model: local-7b',
      'thinking: low',
      `provider_options: ${JSON.stringify({ base_url: provider.url })}`,
      '---',
      '',
      '# Folder reader',
      '',
    ].join('\n'),
    'utf8',
  )

  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'shared-folder-grants.json'))
  await grants.initialize()
  await grants.grant(userFolder)

  let server: StartedApiServer | undefined
  t.after(async () => {
    await server?.close()
    await provider.close()
    fixture.cleanup()
    fs.rmSync(userFolder, { recursive: true, force: true })
    fs.rmSync(appDataPath, { recursive: true, force: true })
  })
  server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspacePath),
    launcher: { async startRun() { return { launched: true as const, pid: 0, cwd: '' } } },
    sessionStore: new FileSystemSessionStore(fixture.workspacePath),
    workspacePath: fixture.workspacePath,
    repoRootPath: fixture.repoRootPath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    sharedFolderGrantStore: grants,
    appDataPath,
  })
  const grantsUrl = `${server.url}/settings/shared-folder-grants`

  const created = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Revoked folder' }),
  })
  assert.equal(created.status, 201)
  const { id: sessionId } = (await created.json()) as { id: string }
  const attached = await fetch(`${server.url}/sessions/${sessionId}/folders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: userFolder }),
  })
  assert.equal(attached.status, 201, await attached.clone().text())
  const folder = (await attached.json()) as { id: string }
  readArguments.folder = folder.id

  // Settings lists the grant the native picker left behind.
  const listed = await fetch(grantsUrl)
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), { grants: [{ path: userFolder }] })

  const revoked = await fetch(grantsUrl, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: userFolder }),
  })
  assert.equal(revoked.status, 204)
  assert.deepEqual(await (await fetch(grantsUrl)).json(), { grants: [] })

  const answered = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'What is the vault code?',
      target: { kind: 'agents', agentNames: [agentName] },
      turnId: randomUUID(),
    }),
  })
  assert.ok(answered.status < 400, `turn failed: ${answered.status} ${await answered.clone().text()}`)

  const toolResults = provider.requests
    .filter((request) => !isProviderHealthProbe(request))
    .flatMap(toolResultContents)
  assert.ok(toolResults.length > 0, 'the agent made its tool call')
  assert.ok(
    toolResults.every((content) => content.includes('Access to this folder was removed')),
    `the tool call reports access removed: ${toolResults.join(' | ')}`,
  )
  assert.equal(
    toolResults.some((content) => content.includes('PERSIMMON-7')),
    false,
    'nothing from the folder reached the model',
  )
})
