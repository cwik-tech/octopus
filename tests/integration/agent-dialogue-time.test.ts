import assert from 'node:assert/strict'
import test from 'node:test'
import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import type { AgentDialogueClock } from '../../services/agent-dialogue-service.js'
import { createDialogueFixture, waitForDialogueEvent } from '../helpers/agent-dialogue-fixture.js'

function makeClock(): AgentDialogueClock & { advance(milliseconds: number): void } {
  let time = 0
  const scheduled = new Map<() => void, number>()
  return {
    now: () => time,
    schedule: (callback, milliseconds) => { scheduled.set(callback, time + milliseconds); return () => { scheduled.delete(callback) } },
    advance: (milliseconds) => {
      time += milliseconds
      for (const [callback, deadline] of scheduled) {
        if (deadline > time) continue
        scheduled.delete(callback)
        callback()
      }
    },
  }
}

test('only running time consumes the budget and expiry discards unfinished generation', { timeout: 20_000 }, async (t) => {
  const clock = makeClock()
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let requested = () => {}
  const pending = new Promise<void>((resolve) => { requested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'Unfinished budgeted reply.' },
    { match: (request) => { if (!request.stream) return false; requested(); return true }, content: 'Unfinished budgeted reply.', gate },
  ], clock)
  t.after(release)
  const record = await fixture.start({ maxMinutes: 1 })
  await pending
  clock.advance(10_000)
  assert.equal((await fixture.post(`/${record.dialogueId}/pause`)).status, 200)
  clock.advance(90_000)
  const paused = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(agentDialogueRecordSchema.parse(await paused.json()).status, 'paused')
  assert.equal((await fixture.post(`/${record.dialogueId}/resume`)).status, 200)
  clock.advance(50_000)

  const response = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  const ended = agentDialogueRecordSchema.parse(await response.json())
  assert.equal(ended.status, 'ended')
  assert.equal(ended.endReason, 'time_limit')
  assert.equal(ended.limits.runningMs, 60_000)
  release()
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.role), ['user'])
  assert.equal(fixture.provider.requests.filter((request) => request.stream).length, 1)
})

test('Pause lets the current Agent finish after more paused time than its remaining dialogue budget', { timeout: 20_000 }, async (t) => {
  const clock = makeClock()
  let releaseReply = () => {}
  const replyHeld = new Promise<void>((resolve) => { releaseReply = resolve })
  let providerRequested = () => {}
  const replyRequested = new Promise<void>((resolve) => { providerRequested = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'The paused Agent finishes its original reply.' },
    { match: (request) => { if (!request.stream) return false; providerRequested(); return true }, content: 'The paused Agent finishes its original reply.', gate: replyHeld },
  ], clock)
  // The installed platform timer facility advances lifecycle deadlines; the
  // injected dialogue clock separately records only running time. Local HTTP,
  // session ownership and transcript persistence remain real.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const record = await fixture.start({ maxMinutes: 1 / 60 })
    await replyRequested
    clock.advance(100)
    assert.equal((await fixture.post(`/${record.dialogueId}/pause`)).status, 200)

    clock.advance(1_500)
    t.mock.timers.tick(1_500)
    // Restore real transport scheduling after the controlled wall-clock jump.
    t.mock.timers.reset()
    releaseReply()
    const settled = await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_saved' || event.type === 'ended')
    assert.equal(settled.type, 'turn_saved', 'Paused time must not discard the current Agent reply through the running-budget deadline')
    const paused = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
    assert.equal(paused.status, 'paused')
    assert.equal(paused.limits.runningMs, 100)
    assert.deepEqual((await fixture.store.listChatMessages(fixture.session.id)).map((message) => message.text), ['Consider pricing.', 'The paused Agent finishes its original reply.'])
    assert.equal(fixture.provider.requests.filter((request) => request.stream).length, 1)
  } finally {
    t.mock.timers.reset()
    releaseReply()
  }
})

test('a large valid time budget keeps the dialogue running instead of overflowing the platform timer', { timeout: 20_000 }, async (t) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'The large budget remains active.', gate },
    { match: (request) => request.stream === true, content: 'The large budget remains active.', gate },
  ])
  t.after(release)
  const record = await fixture.start({ maxMinutes: 600_000 })

  const first = await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_started' || event.type === 'ended')
  assert.equal(first.type, 'turn_started', 'A valid long budget must not end before the first turn')
  const response = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(agentDialogueRecordSchema.parse(await response.json()).status, 'running')
})

test('a long running budget re-arms until its actual deadline rather than ending at the first timer boundary', { timeout: 20_000 }, async (t) => {
  const clock = makeClock()
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fixture = await createDialogueFixture(t, [
    { match: (request) => !request.stream, content: 'The long dialogue is still writing.', gate },
    { match: (request) => request.stream === true, content: 'The long dialogue is still writing.', gate },
  ], clock)
  t.after(release)
  const record = await fixture.start({ maxMinutes: 600_000 })
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'turn_started')

  clock.advance(2_147_483_647)
  const stillRunning = await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(agentDialogueRecordSchema.parse(await stillRunning.json()).status, 'running')
  clock.advance(36_000_000_000 - 2_147_483_647)
  await waitForDialogueEvent(fixture.base, record.dialogueId, (event) => event.type === 'ended')
  const ended = agentDialogueRecordSchema.parse(await (await fetch(`${fixture.base}/${record.dialogueId}`, { signal: AbortSignal.timeout(5_000) })).json())
  assert.equal(ended.endReason, 'time_limit')
  assert.equal(ended.limits.runningMs, 36_000_000_000)
})
