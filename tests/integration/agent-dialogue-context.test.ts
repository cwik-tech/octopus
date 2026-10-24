import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { z } from 'zod/v4'
import { sharedFolderViewSchema } from '../../contracts/shared-folders.js'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import type { FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

function toolResults(request: FakeChatCompletionsRequest): string[] {
  return z.array(z.unknown()).parse(request.body.messages).flatMap((message) => {
    const parsed = z.object({ role: z.literal('tool'), content: z.string() }).safeParse(message)
    return parsed.success ? [parsed.data.content] : []
  })
}

test('every dialogue Agent receives the selected project brief and the chat uploads', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [DIALOGUE_ALPHA, DIALOGUE_BETA].flatMap((persona) => [
    { match: (request: FakeChatCompletionsRequest) => !request.stream && request.systemPrompt?.includes(persona) === true, content: 'Compare this evidence.' },
    { match: (request: FakeChatCompletionsRequest) => request.stream && request.systemPrompt?.includes(persona) === true, content: 'Compare this evidence.' },
  ]))
  const request = (url: string, method: string, body?: unknown) => fetch(`${fixture.server.url}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
  })
  const created = await request('/projects', 'POST', { name: 'Pricing evidence' })
  assert.equal(created.status, 201)
  const project = z.object({ id: z.uuid() }).parse(await created.json())
  assert.equal((await request(`/projects/${project.id}/sessions/${fixture.session.id}`, 'PUT')).status, 200)
  assert.equal((await request(`/projects/${project.id}/brief`, 'PUT', { content: 'PROJECT_EVIDENCE_83: budget comes from customer interviews.' })).status, 200)
  assert.ok(await fixture.store.saveUploadedFile(fixture.session.id, { filename: 'customer-notes.txt', contents: Buffer.from('User upload.') }))

  const record = await fixture.start({ maxTurns: 2, projectContext: { projectId: project.id, includeBrief: true, fileNames: [] } })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const prompts = fixture.provider.requests.filter((request) => request.stream && (request.systemPrompt?.includes(DIALOGUE_ALPHA) || request.systemPrompt?.includes(DIALOGUE_BETA))).map((request) => request.userMessage ?? '')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).filter((message) => message.role === 'assistant').map((message) => message.speaker?.id), ['alpha-analyst', 'beta-builder'])
  assert.ok(prompts.every((prompt) => prompt.includes('PROJECT_EVIDENCE_83') && prompt.includes('customer-notes.txt')), 'both Agents must receive the selected brief and upload metadata')
})

test('a dialogue Agent reads an attached folder through its scoped real tools', { timeout: 20_000 }, async (t) => {
  const userFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-folder-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-appdata-')))
  t.after(() => { fs.rmSync(userFolder, { recursive: true, force: true }); fs.rmSync(appDataPath, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(userFolder, 'evidence.md'), 'FOLDER_EVIDENCE_67: buyer budgets are seasonal.')
  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'grants.json'))
  await grants.initialize()
  await grants.grant(userFolder)
  const args: Record<string, unknown> = { path: 'evidence.md' }
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.toolCount > 0 && toolResults(request).length === 0,
      toolCalls: [{ id: 'read-dialogue-evidence', name: 'folder_read', arguments: args }] },
    { match: (request) => !request.stream && toolResults(request).length > 0, content: 'Use the seasonal budgets.' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Use the seasonal budgets.' },
  ], undefined, { sharedFolderGrantStore: grants, appDataPath })
  const attached = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: userFolder }), signal: AbortSignal.timeout(5_000),
  })
  assert.equal(attached.status, 201)
  const folder = sharedFolderViewSchema.parse(await attached.json())
  args.folder = folder.id

  const record = await fixture.start({ maxTurns: 1 })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  assert.ok(fixture.provider.requests.some((request) => toolResults(request).some((result) => result.includes('FOLDER_EVIDENCE_67'))), 'the scoped folder_read tool must return the real evidence file')
  assert.ok(fixture.provider.requests.every((request) => !request.userMessage?.includes('FOLDER_EVIDENCE_67')), 'the folder contents belong in tool results, not the initial reference map')
  assert.equal((await fixture.store.listChatMessages(fixture.session.id)).filter((message) => message.role === 'assistant').length, 1)
})

test('dialogue Agents receive an explicitly selected prior result through the ordinary continuation context', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true && !request.stream, content: 'Use the earlier result.' },
    { match: (request) => request.systemPrompt?.includes(DIALOGUE_ALPHA) === true && request.stream, content: 'Use the earlier result.' },
  ])
  await fixture.store.appendChatMessageIfAbsent(fixture.session.id, {
    id: 'prior-agent-evidence', role: 'assistant', text: 'PRIOR_RESULT_92: interview people who declined.', createdAt: '2026-10-09T00:00:00Z',
    speaker: { id: 'earlier-analyst', name: 'Earlier analyst', type: 'agent' },
  })
  await fixture.store.publishResultReference(fixture.session.id, {
    schemaVersion: 1, id: 'selected-prior-result', sessionId: fixture.session.id,
    producer: { kind: 'agent', id: 'earlier-analyst', label: 'Earlier analyst' }, status: 'done',
    completedAt: '2026-10-09T00:00:00Z', source: { kind: 'chat-message', messageId: 'prior-agent-evidence' },
  })

  const record = await fixture.start({ maxTurns: 1, contextResultIds: ['selected-prior-result'] })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const prompt = fixture.provider.requests.find((request) => request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true)?.userMessage
  assert.ok(prompt?.includes('selected-prior-result'), 'the selected result must be named in the continuation block, beyond ordinary chat history')
  assert.ok(prompt?.includes('PRIOR_RESULT_92'))
})

test('a dialogue refuses an unavailable selected result before saving its topic', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [])
  const response = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Cannot use missing evidence.', contextResultIds: ['unavailable-result'] })
  assert.equal(response.status, 400)
  assert.deepEqual(await fixture.store.listChatMessages(fixture.session.id), [])
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
})
