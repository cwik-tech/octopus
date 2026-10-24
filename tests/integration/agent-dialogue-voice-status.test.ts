import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createDialogueFixture, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import { startVoiceLayerFixture } from '../helpers/voice-layer-fixture.js'

function makeGate() {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

test('Stop during voice generation clears its working label without speaking a closing line', { timeout: 20_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-stop-status-'))
  const response = makeGate()
  const requested = makeGate()
  let closeDialogueServer = async () => {}
  // Physical voice is unavailable here. Its authenticated MCP transport and
  // status calls remain real; no speech should be requested in this journey.
  const voice = await startVoiceLayerFixture(discoveryDir)
  t.after(response.resolve)
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: () => { requested.resolve(); return true }, content: 'The withdrawn reply.', gate: response.promise },
  ], undefined, { voiceControl: { mcpToken: 'stop-status-fixture-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice' })
  await requested.promise
  await voice.waitFor((call) => call.name === 'set_status' && call.arguments.state === 'working', AbortSignal.timeout(5_000))

  assert.equal((await fixture.post(`/${record.dialogueId}/stop`)).status, 200)
  const idle = await voice.waitFor((call) => call.name === 'set_status' && call.arguments.state === 'idle', AbortSignal.timeout(5_000))
  assert.deepEqual(idle.arguments.subject, { type: 'dialogue', id: record.dialogueId, label: 'Consider pricing.' })
  assert.equal(voice.calls.some((call) => call.name === 'say'), false)
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
})

test('a paused voice dialogue clears its working label when the current Agent passes', { timeout: 20_000 }, async (t) => {
  const discoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialogue-pause-status-'))
  const response = makeGate()
  const requested = makeGate()
  let closeDialogueServer = async () => {}
  // Physical speech is unavailable; the real MCP boundary proves that the
  // label lifecycle is independent of any generated or spoken reply.
  const voice = await startVoiceLayerFixture(discoveryDir)
  t.after(response.resolve)
  t.after(async () => { await closeDialogueServer(); await voice.close(); await fs.rm(discoveryDir, { recursive: true, force: true }) })
  const fixture = await createDialogueFixture(t, [
    { match: () => { requested.resolve(); return true }, content: '[pass]', gate: response.promise },
  ], undefined, { voiceControl: { mcpToken: 'pause-status-fixture-token', discoveryDir, attentionIntervalMs: 60_000 } })
  closeDialogueServer = () => fixture.server.close()
  const record = await fixture.start({ delivery: 'voice' })
  await requested.promise

  assert.equal((await fixture.post(`/${record.dialogueId}/pause`)).status, 200)
  response.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_passed')
  await voice.waitFor((call) => call.name === 'set_status' && call.arguments.state === 'idle', AbortSignal.timeout(5_000))
  assert.equal(voice.calls.some((call) => call.name === 'say'), false)
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
})
