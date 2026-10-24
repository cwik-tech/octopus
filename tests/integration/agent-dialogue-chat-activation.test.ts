import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod/v4'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { createDialogueFixture, DIALOGUE_ALPHA, DIALOGUE_BETA, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'
import type { FakeChatCompletionsRequest } from '../support/fake-chat-completions-server.js'

test('asking an Agent to discuss with a named peer starts text dialogue after its ordinary reply is saved', { timeout: 25_000 }, async (t) => {
  let release = () => {}
  const confirmationGate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const confirmationRequested = new Promise<void>((resolve) => { requested = resolve })
  let received = (_request: FakeChatCompletionsRequest) => {}
  const toolRequest = new Promise<FakeChatCompletionsRequest>((resolve) => { received = resolve })
  let ownedRequest: Promise<Response> | undefined
  // Finish the owned request before the fixture closes journals and removes files.
  t.after(async () => { release(); await ownedRequest?.catch(() => undefined) })
  const ordinary = (prompt: string | undefined) => prompt?.includes('Session chat rules:') === true
  const dialogue = (prompt: string | undefined) => prompt?.includes('Agent dialogue rules:') === true
  const fixture = await createDialogueFixture(t, [
    { match: (request) => { if (request.stream || !ordinary(request.systemPrompt)) return false; received(request); return true }, toolCalls: [{ id: 'start-peer-discussion', name: 'start_dialogue', arguments: { agents: ['beta-builder'], topic: 'Compare monthly and annual pricing.', maxTurns: 2 } }] },
    { match: (request) => !request.stream && ordinary(request.systemPrompt), content: 'I have started the discussion with beta-builder.' },
    { match: (request) => { if (!request.stream || !ordinary(request.systemPrompt)) return false; requested(); return true }, content: 'I have started the discussion with beta-builder.', gate: confirmationGate,
      deltas: ['I have started the discussion with beta-builder.'], deltaGates: [confirmationGate],
    },
    { match: (request) => dialogue(request.systemPrompt) && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Monthly pricing lowers the first purchase barrier.' },
    { match: (request) => dialogue(request.systemPrompt) && request.systemPrompt?.includes(DIALOGUE_ALPHA) === true, content: 'Monthly pricing lowers the first purchase barrier.' },
    { match: (request) => dialogue(request.systemPrompt) && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Annual pricing can fund onboarding.' },
    { match: (request) => dialogue(request.systemPrompt) && request.systemPrompt?.includes(DIALOGUE_BETA) === true, content: 'Annual pricing can fund onboarding.' },
  ])
  // A provider HTTP request is the event that tells us the original answer is
  // waiting. No internal service or tool module is replaced.
  const turnId = 'c0b5dbe2-4113-4f85-8cbb-0dd87b48b4e1'
  const request = fetch(`${fixture.server.url}/sessions/${fixture.session.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ text: 'Discuss pricing with beta-builder.', target: { kind: 'agents', agentNames: ['alpha-analyst'] }, turnId }),
  })
  ownedRequest = request
  const submitted = await toolRequest
  const advertised = z.array(z.object({ function: z.object({ name: z.string(), description: z.string() }) })).parse(submitted.body.tools)
  assert.ok(advertised.some((tool) => tool.function.name === 'start_dialogue'), 'The ordinary Agent provider must receive the native start_dialogue tool')
  const startTool = advertised.find((tool) => tool.function.name === 'start_dialogue')
  assert.ok(startTool)
  // These assertions observe instructions delivered to the provider, rather
  // than claiming that a deterministic HTTP fixture proves live model choices.
  assert.ok(submitted.systemPrompt?.includes('ask for clarification before calling start_dialogue'), 'The ordinary Agent prompt must instruct clarification before an ambiguous dialogue start')
  assert.ok(submitted.systemPrompt?.includes('ambiguous about starting a dialogue, its topic, or the named Agents'), 'Clarification must cover intent, topic and participant ambiguity')
  assert.ok(startTool.function.description.includes('ask for clarification before calling start_dialogue'), 'The native tool description must carry clarification guidance to the provider')
  assert.ok(startTool.function.description.includes('Do not choose unnamed Agents'), 'The native tool must not invite the model to invent peer Agents')
  assert.ok(submitted.systemPrompt?.includes('After start_dialogue confirms a reservation, you may report that Agent dialogue is queued.'), 'The ordinary chat prompt must permit only confirmed dialogue reservation while preserving workflow safeguards')
  await Promise.race([confirmationRequested, request.then(async (response) => { throw new Error(`Chat ended before it reserved a dialogue: ${response.status} ${await response.clone().text()}`) })])
  const records = z.object({ dialogues: z.array(agentDialogueRecordSchema) }).parse(await (await fetch(fixture.base, { signal: t.signal })).json()).dialogues
  assert.equal(records.length, 1, 'The native tool must reserve exactly one dialogue')
  const record = records[0]
  assert.ok(record)
  assert.equal(record.delivery, 'text')
  assert.deepEqual(record.participants.map((participant) => participant.id), ['alpha-analyst', 'beta-builder'])
  assert.equal(fixture.provider.requests.some((entry) => dialogue(entry.systemPrompt)), false, 'Dialogue generation waits for original chat publication')
  assert.deepEqual((await fixture.store.listSessionActivityClaims(fixture.session.id)).map((claim) => claim.kind), ['dialogue'], 'Handoff retains one durable reservation without a claim gap')
  const competitor = await fixture.post('', { agents: ['alpha-analyst', 'beta-builder'], topic: 'A competing dialogue.' })
  assert.equal(competitor.status, 409)
  assert.equal(z.object({ code: z.string() }).parse(await competitor.json()).code, 'dialogue_active')
  release()
  const response = await request
  assert.equal(response.status, 201, await response.clone().text())
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const topic = (await fixture.store.listChatMessages(fixture.session.id)).find((message) => message.id === `${record.dialogueId}:user:topic`)
  assert.equal(topic?.role, 'assistant', 'The Agent-generated topic must not claim to be a message the user typed')
  assert.equal(topic?.speaker?.id, 'alpha-analyst')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), [
    'Discuss pricing with beta-builder.', 'Compare monthly and annual pricing.',
    'I have started the discussion with beta-builder.',
    'Monthly pricing lowers the first purchase barrier.', 'Annual pricing can fund onboarding.',
  ])
})

test('cancelling the original chat after its tool reservation interrupts dialogue without generating a reply', { timeout: 15_000 }, async (t) => {
  let release = () => {}
  const confirmationGate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const confirmationRequested = new Promise<void>((resolve) => { requested = resolve })
  const controller = new AbortController()
  let ownedRequest: Promise<Response> | undefined
  t.after(async () => { release(); controller.abort(); await ownedRequest?.catch(() => undefined) })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, toolCalls: [{ id: 'reserve-before-cancel', name: 'start_dialogue', arguments: { agents: ['beta-builder'], topic: 'Discuss after this confirmation.' } }] },
    { match: (request) => !request.stream, content: 'I will start the discussion.' },
    { match: (request) => { requested(); return request.stream }, content: 'I will start the discussion.', gate: confirmationGate, deltas: ['I will start the discussion.'], deltaGates: [confirmationGate] },
  ])
  const chat = fetch(`${fixture.server.url}/sessions/${fixture.session.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
    body: JSON.stringify({ text: 'Talk with beta-builder.', target: { kind: 'agents', agentNames: ['alpha-analyst'] } }),
  })
  ownedRequest = chat
  await confirmationRequested
  const records = z.object({ dialogues: z.array(agentDialogueRecordSchema) }).parse(await (await fetch(fixture.base, { signal: t.signal })).json()).dialogues
  const record = records[0]
  assert.ok(record, 'The actual Agent tool must reserve the dialogue before cancellation')
  controller.abort()
  await assert.rejects(chat, { name: 'AbortError' })
  const ended = await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  assert.equal(ended.status, 'interrupted')
  assert.equal(fixture.provider.requests.some((entry) => entry.systemPrompt?.includes('Agent dialogue rules:')), false)
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Talk with beta-builder.', 'Discuss after this confirmation.'])
  release()
})

test('an ordinary Agent reply leaves the chat without a dialogue until the tool is explicitly called', { timeout: 15_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [{ content: 'Monthly pricing may suit this product.' }, { content: 'Monthly pricing may suit this product.' }])
  const response = await fetch(`${fixture.server.url}/sessions/${fixture.session.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: t.signal,
    body: JSON.stringify({ text: 'What pricing do you suggest?', target: { kind: 'agents', agentNames: ['alpha-analyst'] } }),
  })
  assert.equal(response.status, 201, await response.clone().text())
  assert.deepEqual(z.object({ dialogues: z.array(agentDialogueRecordSchema) }).parse(await (await fetch(fixture.base, { signal: t.signal })).json()).dialogues, [])
  assert.deepEqual(await fixture.store.listSessionActivityClaims(fixture.session.id), [])
})
