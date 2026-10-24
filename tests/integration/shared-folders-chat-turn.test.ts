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
 * Local folder access, phase 1 acceptance (docs/flows/local-folder-access.md,
 * LF-P1).
 *
 * One coherent journey through the real API, folder store, turn assembly, tool
 * service and native tool loop. Only the model is replaced, at its HTTP
 * boundary: the fake provider asks for one file, and everything between that
 * request and the file on disk is production code.
 *
 * The sentence in the file is the evidence. It may reach the provider only as
 * a tool result, never in the prompt, because the prompt carries the folder's
 * map and not its contents.
 */

const SECRET_SENTENCE = 'The launch code is TANGERINE-42.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultContents(request: FakeChatCompletionsRequest): string[] {
  const messages = request.body.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message: unknown) =>
    isRecord(message) && message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [])
}

function offeredToolNames(request: FakeChatCompletionsRequest): string[] {
  const tools = request.body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool: unknown) => {
    const fn = isRecord(tool) ? tool.function : undefined
    return isRecord(fn) && typeof fn.name === 'string' ? [fn.name] : []
  })
}

test('a folder attached to a chat lets its next agent turn read a file, while the prompt carries only the map', async (t) => {
  const fixture = createSchedulerFixture('shared-folder-turn-')
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-user-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-appdata-')))
  fs.mkdirSync(path.join(userFolder, 'notes'))
  fs.writeFileSync(path.join(userFolder, 'notes', 'plan.md'), `# Plan\n\n${SECRET_SENTENCE}\n`, 'utf8')

  // The provider's first tool round asks for the file. The folder ID is only
  // known once the folder is attached, so the arguments are filled in then.
  const readArguments: Record<string, unknown> = { path: 'notes/plan.md' }
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        match: (request) =>
          !isProviderHealthProbe(request) &&
          request.toolCount > 0 &&
          toolResultContents(request).length === 0,
        toolCalls: [{ id: 'call-read-plan', name: 'folder_read', arguments: readArguments }],
      },
      { content: 'Answered from the folder.', deltas: ['Answered from the folder.'] },
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

  const created = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Folder turn' }),
  })
  assert.equal(created.status, 201)
  const { id: sessionId } = (await created.json()) as { id: string }

  const attached = await fetch(`${server.url}/sessions/${sessionId}/folders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: userFolder }),
  })
  assert.equal(attached.status, 201, await attached.clone().text())
  const folder = (await attached.json()) as { id: string; label: string }
  readArguments.folder = folder.id

  const answered = await fetch(`${server.url}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'What is the launch code in my plan?',
      target: { kind: 'agents', agentNames: [agentName] },
      turnId: randomUUID(),
    }),
  })
  assert.ok(answered.status < 400, `turn failed: ${answered.status} ${await answered.clone().text()}`)

  const turnRequests = provider.requests.filter((request) => !isProviderHealthProbe(request))
  const first = turnRequests[0]
  assert.ok(first, 'the provider was never asked')
  assert.deepEqual(
    ['folder_list', 'folder_read', 'folder_search'].filter((name) => offeredToolNames(first).includes(name)),
    ['folder_list', 'folder_read', 'folder_search'],
    'the turn offers the three folder tools',
  )
  const prompt = first.userMessage ?? ''
  assert.ok(prompt.includes(folder.id), 'the prompt names the attached folder by its ID')
  assert.ok(prompt.includes('plan.md'), 'the prompt maps the folder structure')
  for (const request of turnRequests) {
    assert.equal(
      (request.userMessage ?? '').includes('TANGERINE-42'),
      false,
      'file contents never enter the prompt',
    )
  }
  assert.ok(
    turnRequests.some((request) => toolResultContents(request).some((content) => content.includes(SECRET_SENTENCE))),
    'the file reached the model as the folder_read tool result',
  )
})
