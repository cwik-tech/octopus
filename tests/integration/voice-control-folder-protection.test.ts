import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'
import { z } from 'zod/v4'
import { sharedFolderViewSchema } from '../../contracts/shared-folders.js'
import { BatchFolderGrantStore } from '../../domains/batches/batch-folder-grant-store.js'
import { createDialogueFixture, DIALOGUE_ALPHA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import type { FakeChatCompletionsRequest, FakeChatCompletionsTurn } from '../support/fake-chat-completions-server.js'

const CREDENTIAL_MARKER = 'TEST_CREDENTIAL_MARKER_57'
const EVIDENCE_MARKER = 'PUBLIC_EVIDENCE_93'

function toolResults(request: FakeChatCompletionsRequest) {
  return z.array(z.unknown()).parse(request.body.messages).flatMap((message) => {
    const parsed = z.object({ role: z.literal('tool'), tool_call_id: z.string(), content: z.string() }).safeParse(message)
    return parsed.success ? [parsed.data] : []
  })
}

async function makeProtectedFolderFixture(t: TestContext, script: readonly FakeChatCompletionsTurn[]) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-folder-protection-')))
  const appDataPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-folder-appdata-')))
  const discoveryDir = path.join(parent, 'voice-control')
  fs.mkdirSync(path.join(discoveryDir, 'voice'), { recursive: true })
  fs.writeFileSync(path.join(parent, 'evidence.md'), `${EVIDENCE_MARKER}: safe local evidence.`)
  fs.writeFileSync(path.join(discoveryDir, 'voice', 'octopus.json'), JSON.stringify({
    contract: 'voice-control/1', appId: 'octopus', headers: { Authorization: `Bearer ${CREDENTIAL_MARKER}` },
  }))
  t.after(() => { fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(appDataPath, { recursive: true, force: true }) })
  const grants = new BatchFolderGrantStore(path.join(appDataPath, 'grants.json'))
  await grants.initialize()
  await grants.grant(parent)
  await grants.grant(discoveryDir)
  await grants.grant(path.join(discoveryDir, 'voice'))
  const fixture = await createDialogueFixture(t, script, undefined, {
    sharedFolderGrantStore: grants, appDataPath,
    // Synthetic loopback credential only; no personal discovery folder is used.
    voiceControl: { discoveryDir, mcpToken: CREDENTIAL_MARKER, attentionIntervalMs: 60_000 },
  })
  const attach = (folderPath: string) => fetch(`${fixture.server.url}/sessions/${fixture.session.id}/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }), signal: AbortSignal.timeout(5_000),
  })
  return { ...fixture, parent, discoveryDir, attach }
}

test('the configured voice discovery folder and its grants cannot be attached even when picked', async (t) => {
  const fixture = await makeProtectedFolderFixture(t, [])

  const discovery = await fixture.attach(fixture.discoveryDir)
  const grantFolder = await fixture.attach(path.join(fixture.discoveryDir, 'voice'))
  const parent = await fixture.attach(fixture.parent)

  assert.equal(discovery.status, 403)
  assert.equal(z.object({ code: z.literal('protected_overlap') }).parse(await discovery.json()).code, 'protected_overlap')
  assert.equal(grantFolder.status, 403)
  assert.equal(z.object({ code: z.literal('protected_overlap') }).parse(await grantFolder.json()).code, 'protected_overlap')
  assert.equal(parent.status, 201)
})

test('dialogue folder tools beneath an attached parent expose evidence without exposing voice-control credentials', { timeout: 20_000 }, async (t) => {
  const folderArgument: Record<string, unknown> = {}
  const appCredentialArgument: Record<string, unknown> = { path: 'voice-control/apps/octopus.json' }
  const voiceCredentialArgument: Record<string, unknown> = { path: 'voice-control/voice/octopus.json' }
  const fixture = await makeProtectedFolderFixture(t, [
    { match: (request) => request.toolCount > 0 && toolResults(request).length === 0,
      toolCalls: [
        { id: 'read-safe-evidence', name: 'folder_read', arguments: folderArgument },
        { id: 'read-app-credential', name: 'folder_read', arguments: appCredentialArgument },
        { id: 'read-voice-credential', name: 'folder_read', arguments: voiceCredentialArgument },
        { id: 'search-credentials', name: 'folder_search', arguments: { query: 'TEST_CREDENTIAL' } },
      ] },
    { match: (request) => !request.stream && toolResults(request).length > 0, content: 'Use the safe evidence.' },
    { match: (request) => request.stream && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Use the safe evidence.' },
  ])
  const attached = await fixture.attach(fixture.parent)
  assert.equal(attached.status, 201)
  const folder = sharedFolderViewSchema.parse(await attached.json())
  folderArgument.folder = folder.id
  folderArgument.path = 'evidence.md'
  appCredentialArgument.folder = folder.id
  voiceCredentialArgument.folder = folder.id

  const record = await fixture.start({ maxTurns: 1 })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const results = fixture.provider.requests.flatMap(toolResults)
  assert.ok(results.some((result) => result.tool_call_id === 'read-safe-evidence' && result.content.includes(EVIDENCE_MARKER)))
  assert.ok(results.some((result) => result.tool_call_id === 'read-app-credential'))
  assert.ok(results.some((result) => result.tool_call_id === 'read-voice-credential'))
  assert.ok(results.some((result) => result.tool_call_id === 'search-credentials'))
  assert.ok(results.every((result) => !result.content.includes(CREDENTIAL_MARKER)), 'folder reads and search must never return a discovery credential')
  assert.ok(fixture.provider.requests.every((request) => !request.userMessage?.includes(CREDENTIAL_MARKER)), 'the initial folder map must never contain a discovery credential')
})
