import assert from 'node:assert/strict'
import test from 'node:test'
import { createDialogueFixture, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import { z } from 'zod/v4'

const conflictSchema = z.object({ code: z.string() })

function makeGate() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('a running dialogue refuses a competing dialogue before saving its topic', { timeout: 20_000 }, async (t) => {
  const generation = makeGate()
  const requested = makeGate()
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Keep this turn pending.' },
    { match: (request) => { if (!request.stream) return false; requested.resolve(); return true }, content: 'Keep this turn pending.', gate: generation.promise },
  ])
  t.after(generation.resolve)
  await fixture.start()
  await requested.promise

  const refused = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Competing topic.', maxTurns: 1 })
  assert.equal(refused.status, 409, await refused.clone().text())
  assert.equal(conflictSchema.parse(await refused.json()).code, 'dialogue_active')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.'])
})

test('a queued session task refuses a dialogue start without saving a dialogue topic', { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [{ content: '[pass]' }])
  const task = await fixture.store.createTaskRecord(fixture.session.id, { workflowId: fixture.workflowId, brief: 'Queued work owns this chat.' })
  assert.equal(task?.status, 'queued')

  const refused = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Competing with queued work.', maxTurns: 1 })
  assert.equal(refused.status, 409, await refused.clone().text())
  assert.equal(conflictSchema.parse(await refused.json()).code, 'tasks_active')
  assert.deepEqual(await fixture.store.listChatMessages(fixture.session.id), [])
})

test('an in-flight ordinary chat refuses a dialogue until its reply finishes', { timeout: 20_000 }, async (t) => {
  const generation = makeGate()
  const requested = makeGate()
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'An ordinary answer.' },
    { match: (request) => { if (!request.stream) return false; requested.resolve(); return true }, content: 'An ordinary answer.', gate: generation.promise },
  ])
  t.after(generation.resolve)
  const chat = fetch(`${fixture.server.url}/sessions/${fixture.session.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Ordinary question.', target: { kind: 'agents', agentNames: ['alpha-analyst'] } }),
    signal: AbortSignal.timeout(10_000),
  })
  await requested.promise

  const refused = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Competing with chat.', maxTurns: 1 })
  generation.resolve()
  assert.equal((await chat).status, 201)
  assert.equal(refused.status, 409, await refused.clone().text())
  assert.equal(conflictSchema.parse(await refused.json()).code, 'chat_active')
})

test('a running dialogue refuses ordinary chat, Team and workflow task starts without saving them', { timeout: 20_000 }, async (t) => {
  const generation = makeGate()
  const requested = makeGate()
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Keep the dialogue pending.' },
    { match: (request) => { if (!request.stream) return false; requested.resolve(); return true }, content: 'Keep the dialogue pending.', gate: generation.promise },
  ])
  t.after(generation.resolve)
  await fixture.start()
  await requested.promise
  const post = (route: string, body: unknown) => fetch(`${fixture.server.url}/sessions/${fixture.session.id}/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_000),
  })

  const ordinary = await post('messages', { text: 'Competing chat.', target: { kind: 'agents', agentNames: ['beta-builder'] } })
  assert.equal(ordinary.status, 409, await ordinary.clone().text())
  assert.equal(conflictSchema.parse(await ordinary.json()).code, 'dialogue_active')
  const team = await post('messages', { text: 'Competing Team.', target: { kind: 'team', teamId: 'test-team' } })
  assert.equal(team.status, 409, await team.clone().text())
  assert.equal(conflictSchema.parse(await team.json()).code, 'dialogue_active')
  const workflow = await post('tasks', { brief: 'Competing workflow.', workflowId: fixture.workflowId })
  assert.equal(workflow.status, 409, await workflow.clone().text())
  assert.equal(conflictSchema.parse(await workflow.json()).code, 'dialogue_active')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.'])
  assert.deepEqual(await fixture.store.listTaskRecords(fixture.session.id), [])
})

test('deleting a session stops its unfinished dialogue and waits before removing its files', { timeout: 20_000 }, async (t) => {
  const generation = makeGate()
  const requested = makeGate()
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Never save this unfinished answer.' },
    { match: (request) => { if (!request.stream) return false; requested.resolve(); return true }, content: 'Never save this unfinished answer.', gate: generation.promise },
  ])
  t.after(generation.resolve)
  await fixture.start()
  await requested.promise

  const deletion = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) })
  assert.equal(deletion.status, 204, await deletion.clone().text())
  generation.resolve()
  assert.equal(await fixture.store.getSession(fixture.session.id), null)
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
  assert.equal(fixture.provider.requests.filter((request) => request.stream).length, 1)
})

test('a paused dialogue keeps its session claim and refuses new work', { timeout: 20_000 }, async (t) => {
  const generation = makeGate()
  const requested = makeGate()
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Finish before pausing.' },
    { match: (request) => { if (!request.stream) return false; requested.resolve(); return true }, content: 'Finish before pausing.', gate: generation.promise },
  ])
  t.after(generation.resolve)
  const record = await fixture.start()
  await requested.promise
  const paused = await fixture.post(`/${record.dialogueId}/pause`)
  assert.equal(paused.status, 200)
  generation.resolve()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_saved')

  const refused = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'Do not displace the paused dialogue.', maxTurns: 1 })
  assert.equal(refused.status, 409, await refused.clone().text())
  assert.equal(conflictSchema.parse(await refused.json()).code, 'dialogue_active')
  const ordinary = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Do not start another chat.', target: { kind: 'agents', agentNames: ['beta-builder'] } }),
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(ordinary.status, 409, await ordinary.clone().text())
  assert.equal(conflictSchema.parse(await ordinary.json()).code, 'dialogue_active')
  assert.equal(fixture.provider.requests.filter((request) => request.stream).length, 1)
})
