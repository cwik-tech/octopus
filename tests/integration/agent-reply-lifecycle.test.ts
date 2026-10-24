import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedAgentTurnRecorder } from '../../services/agent-turn-journal-recorder.js'
import { runAgentReplyLifecycle, AgentChatProviderInterruptedError, AgentChatTurnCancelledError } from '../../services/agent-reply-lifecycle.js'
import type { AgentReplyResult } from '../../services/agent-reply-service.js'

function makeResult(text = 'A new point.'): AgentReplyResult {
  return { text, model: 'fixture/model', fallback: false,
    journal: { route: 'mcp-native', outcome: 'success', resolvedModel: 'fixture/model' } }
}

function makeGate() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function makeFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-lifecycle-'))
  const identity = { scopeKind: 'assignment' as const, scopeId: 'assignment', tenantId: 'local',
    sessionId: 'session', runId: 'run', assignmentId: 'assignment' }
  const journal = await initializeExecutionJournal({ scopeRoot: directory, identity })
  const recorder = createJournalBackedAgentTurnRecorder(journal, 'assignment', () => journal.close())
  return {
    directory, recorder,
    replyPath: path.join(directory, 'reply.txt'),
    input: { turnId: 'turn', replyId: 'reply', speakerOrdinal: 0, agentPath: 'agents/analyst', recorder },
    read: async () => {
      const reopened = await initializeExecutionJournal({ scopeRoot: directory, identity })
      try {
        const reader = createJournalBackedAgentTurnRecorder(reopened, 'assignment')
        return { summary: await reader.readSummary(), events: (await reopened.scan()).events }
      } finally { await reopened.close() }
    },
    cleanup: async () => { await journal.close(); await fs.rm(directory, { recursive: true, force: true }) },
  }
}

test('a shared reply records its intended publication before saving and completes only after saving', async () => {
  const fixture = await makeFixture()
  try {
    const value = await runAgentReplyLifecycle({
      ...fixture.input,
      generate: async () => {
        assert.equal((await fixture.recorder.readSummary())?.state, 'provider_in_progress')
        return makeResult()
      },
      prepare: async (result) => ({ kind: 'publish', assistantMessageId: 'message', text: result.text,
        value: 'saved', persist: async () => {
          assert.equal((await fixture.recorder.readSummary())?.state, 'reply_pending')
          await fs.writeFile(fixture.replyPath, result.text)
        } }),
    })
    const durable = await fixture.read()

    assert.equal(value, 'saved')
    assert.equal(await fs.readFile(fixture.replyPath, 'utf8'), 'A new point.')
    assert.equal(durable.summary?.state, 'completed')
    assert.equal(durable.summary?.assistantMessageId, 'message')
  } finally { await fixture.cleanup() }
})

test('Stop while publication waits for speech prevents the generated reply from being saved later', async () => {
  const fixture = await makeFixture()
  const controller = new AbortController()
  const preparing = makeGate()
  const heard = makeGate()
  try {
    const work = runAgentReplyLifecycle({
      ...fixture.input, signal: controller.signal,
      generate: async () => makeResult(),
      prepare: async (result) => {
        preparing.resolve()
        await heard.promise
        return { kind: 'publish', assistantMessageId: 'message', text: result.text,
          value: 'saved', persist: () => fs.writeFile(fixture.replyPath, result.text) }
      },
    })
    await preparing.promise
    controller.abort()
    heard.resolve()

    await assert.rejects(work, AgentChatTurnCancelledError)
    await assert.rejects(fs.readFile(fixture.replyPath), { code: 'ENOENT' })
    const durable = await fixture.read()
    assert.equal(durable.summary?.state, 'cancelled')
    assert.equal(durable.summary?.assistantMessageId, undefined)
  } finally { heard.resolve(); await fixture.cleanup() }
})

test('a shared pass releases its journal with successful no-publication evidence', async () => {
  const fixture = await makeFixture()
  try {
    await runAgentReplyLifecycle({
      ...fixture.input, generate: async () => makeResult('[pass]'),
      prepare: async () => ({ kind: 'passed', value: 'passed' }),
    })
    const durable = await fixture.read()

    assert.equal(durable.summary?.state, 'passed')
    assert.equal(durable.summary?.assistantMessageId, undefined)
    assert.deepEqual(durable.events.map((event) => event.type), ['agent.turn.started', 'agent.turn.passed'])
  } finally { await fixture.cleanup() }
})

test('provider cancellation retains the caller reason through the reply deadline controller', async () => {
  const caller = new AbortController()
  const reason = { kind: 'provider-abort', source: 'user-stop' }
  let observed: unknown
  let started = () => {}
  const ready = new Promise<void>((resolve) => { started = resolve })
  const operation = runAgentReplyLifecycle({ turnId: 'turn', replyId: 'reply', speakerOrdinal: 0, agentPath: 'agents/analyst', signal: caller.signal,
    generate: (signal) => new Promise<AgentReplyResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => { observed = signal.reason; reject(new Error('Cancelled provider fixture')) }, { once: true })
      started()
    }),
    prepare: async () => { throw new Error('A cancelled reply must not publish') },
  })
  await ready
  caller.abort(reason)
  await assert.rejects(operation)
  assert.deepEqual(observed, reason)
})

test('an operation deadline is distinguishable from caller cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let observed: unknown
  const operation = runAgentReplyLifecycle({ turnId: 'turn', replyId: 'reply', speakerOrdinal: 0, agentPath: 'agents/analyst', providerDeadlineMs: 5000,
    generate: (signal) => new Promise<AgentReplyResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => { observed = signal.reason; reject(new Error('Provider fixture stopped')) }, { once: true })
    }),
    prepare: async () => { throw new Error('A timed-out reply must not publish') },
  })
  // The journal start is optional but still awaited before entering generation.
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await assert.rejects(operation)
  assert.deepEqual(observed, { kind: 'provider-abort', source: 'provider-deadline' })
  t.mock.timers.reset()
})

test('an ordinary reply stays active until the thirty-minute default deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = makeGate()
  let providerSignal: AbortSignal | undefined
  const operation = runAgentReplyLifecycle({
    turnId: 'turn', replyId: 'reply', speakerOrdinal: 0, agentPath: 'agents/analyst',
    generate: (signal) => new Promise<AgentReplyResult>((_resolve, reject) => {
      providerSignal = signal
      signal.addEventListener('abort', () => reject(new Error('Provider fixture stopped')), { once: true })
      started.resolve()
    }),
    prepare: async () => { throw new Error('A timed-out reply must not publish') },
  })
  const interrupted = assert.rejects(operation, AgentChatProviderInterruptedError)
  try {
    await started.promise

    t.mock.timers.tick(1_799_999)
    // Let the deadline race settle before inspecting its AbortSignal.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(providerSignal?.aborted, false, 'a reply may still work after fifteen minutes')
    t.mock.timers.tick(1)

    await interrupted
    assert.deepEqual(providerSignal?.reason, { kind: 'provider-abort', source: 'provider-deadline' })
  } finally {
    // Settle the fixture even when the boundary assertion fails.
    t.mock.timers.tick(1_800_000)
    await interrupted
  }
})
