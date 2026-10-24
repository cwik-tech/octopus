/**
 * What a conversation can say about the model each speaker ran on.
 *
 * The record is written with the user's message, before the barrier and before
 * any provider call, so a turn that is still running or that failed outright
 * can still name the pair it was admitted on. Everything here reads it back
 * from the same transcript the UI reads, after the change that could most
 * plausibly rewrite history: the application default moving.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import type { ChatMessage, SessionSummary } from '../../contracts/sessions.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { GENERAL_AGENT_NAME } from '../../contracts/front-door.js'

initProviders()

const SESSION: SessionSummary = {
  id: 'unused',
  title: 'disclosure',
  status: 'active',
  activityType: 'chat',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
}

interface Harness {
  readonly sessionId: string
  readonly repoRootPath: string
  readonly workspacePath: string
  readonly store: FileSystemSessionStore
  cleanup(): void
}

async function makeHarness(): Promise<Harness> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'model-selection-disclosure-')),
  )
  const repoRootPath = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(path.join(repoRootPath, 'agents'), { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'disclosure' })
  return {
    sessionId: session.id,
    repoRootPath,
    workspacePath,
    store,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

/** An agent that names nothing, so it inherits the application default. */
function writeInheritingAgent(repoRootPath: string, name: string): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    ['---', `name: ${name}`, 'thinking: low', '---', '', 'Answer.', ''].join('\n'),
    'utf8',
  )
}

/** An agent that declares its own pair. */
function writeExplicitAgent(
  repoRootPath: string,
  name: string,
  provider: string,
  model: string,
): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      '---',
      '',
      'Answer.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function withConfiguredProvider<T>(
  run: (providerName: string) => Promise<T>,
): Promise<T> {
  const server = await startFakeChatCompletionsServer({
    script: [
      { content: 'A complete answer.' },
      { content: 'Another complete answer.' },
    ],
  })
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Disclosure provider',
      baseUrl: `${server.url}/v1`,
      apiKey: 'disclosure-key',
    },
  ])
  try {
    return await run(`connection:${connectionId}`)
  } finally {
    setConfiguredProviderConnections([])
    await server.close()
  }
}

function userTurn(messages: readonly ChatMessage[], turnId: string): ChatMessage {
  const message = messages.find(
    (candidate) => candidate.role === 'user' && candidate.turnId === turnId,
  )
  assert.ok(message, `the user message for ${turnId} must be persisted`)
  return message
}

test('a default-mode reply records the pair it was admitted on, and a later default change does not relabel it', async () => {
  const harness = await makeHarness()
  const firstTurn = randomUUID()
  const secondTurn = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeInheritingAgent(harness.repoRootPath, 'reviewer')
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'default-a',
      })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'First question.',
        agentNames: ['reviewer'],
        turnId: firstTurn,
      })

      // The application default moves after the first turn was admitted.
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'default-b',
      })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'Second question.',
        agentNames: ['reviewer'],
        turnId: secondTurn,
      })

      // Reopened from disk, the way the transcript is actually read.
      const reopened = new FileSystemSessionStore(harness.workspacePath)
      const messages = await reopened.listChatMessages(harness.sessionId)

      const first = userTurn(messages, firstTurn).turnRequest?.admittedSelections
      const second = userTurn(messages, secondTurn).turnRequest?.admittedSelections

      assert.deepEqual(first?.reviewer, {
        provider: providerName,
        model: 'default-a',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      })
      assert.deepEqual(second?.reviewer, {
        provider: providerName,
        model: 'default-b',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      })
    })
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
    harness.cleanup()
  }
})

test('an explicit agent is recorded as explicit even when its pair equals the default', async () => {
  const harness = await makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeExplicitAgent(harness.repoRootPath, 'pinned', providerName, 'same-model')
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'same-model',
      })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'Question.',
        agentNames: ['pinned'],
        turnId,
      })

      const messages = await harness.store.listChatMessages(harness.sessionId)
      const admitted = userTurn(messages, turnId).turnRequest?.admittedSelections

      // Same pair, different decision: this agent chose it.
      assert.equal(admitted?.pinned?.source, 'agent')
      assert.equal(admitted?.pinned?.reason, 'explicit-agent-choice')
    })
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
    harness.cleanup()
  }
})

test('the admitted selection survives a turn whose provider never answers', async () => {
  // No assistant reply and no journal enrolment: the record has to come from
  // the user turn alone, or a failed turn could say nothing about what it ran.
  const harness = await makeHarness()
  const turnId = randomUUID()
  try {
    writeInheritingAgent(harness.repoRootPath, 'reviewer')
    setConfiguredProviderConnections([
      {
        id: 'unreachable',
        kind: 'openai-compatible',
        name: 'Unreachable provider',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'unreachable-key',
      },
    ])
    setRuntimeDefaultModelState({
      status: 'available',
      provider: 'connection:unreachable',
      model: 'never-answers',
    })

    await runSessionAgentChatTurn({
      sessionId: harness.sessionId,
      session: SESSION,
      sessionStore: harness.store,
      repoRootPath: harness.repoRootPath,
      text: 'Question.',
      agentNames: ['reviewer'],
      turnId,
    }).catch(() => undefined)

    const messages = await harness.store.listChatMessages(harness.sessionId)
    const admitted = userTurn(messages, turnId).turnRequest?.admittedSelections

    assert.deepEqual(admitted?.reviewer, {
      provider: 'connection:unreachable',
      model: 'never-answers',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    })
  } finally {
    setConfiguredProviderConnections([])
    setRuntimeDefaultModelState({ status: 'unset' })
    harness.cleanup()
  }
})

test('the disclosure is never written into the transcript the model reads', async () => {
  // The notice is a status note shown to a person. Persisting its prose would
  // put it into every later prompt, where it would read as something a
  // participant said about which model to use.
  const harness = await makeHarness()
  const turnId = randomUUID()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeInheritingAgent(harness.repoRootPath, 'reviewer')
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'default-a',
      })

      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'A question.',
        agentNames: ['reviewer'],
        turnId,
      })

      const messages = await harness.store.listChatMessages(harness.sessionId)
      const admitted = userTurn(messages, turnId).turnRequest?.admittedSelections
      assert.ok(admitted?.reviewer, 'the selection must still be recorded')

      for (const message of messages) {
        assert.doesNotMatch(
          message.text,
          /is using the app default|app default:|Reason: no Agent model selected/,
          `${message.role} message must not carry disclosure prose`,
        )
      }
    })
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
    harness.cleanup()
  }
})

test('the default-use notice is published before the provider is asked, not after the reply', async () => {
  // The durable record alone is not the requirement. A user watching a reply
  // being produced has to be told the agent is running on the application
  // default before the first token, and the only live channel a chat turn
  // opens is this one.
  const harness = await makeHarness()
  const turnId = randomUUID()
  const hub = new AgentTextStreamHub()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeInheritingAgent(harness.repoRootPath, 'reviewer')
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'default-a',
      })
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'First question.',
        agentNames: ['reviewer'],
        turnId,
        textStreamHub: hub,
      })

      const page = hub.read(turnId, 0)
      assert.ok(page, 'the turn channel must hold frames')
      const frames = page.frames
      const selectionIndex = frames.findIndex((frame) => frame.type === 'selection')
      assert.notEqual(selectionIndex, -1, 'a selection frame must be published')

      const firstTextIndex = frames.findIndex(
        (frame) => frame.type === 'delta' || frame.type === 'final',
      )
      // Asserted so the ordering check below cannot pass because the turn
      // produced no text at all.
      assert.notEqual(firstTextIndex, -1, 'the turn must have produced text')
      assert.ok(
        selectionIndex < firstTextIndex,
        'the selection must be published before any text frame',
      )

      const selectionFrame = frames[selectionIndex]
      assert.ok(selectionFrame && selectionFrame.type === 'selection')
      assert.equal(selectionFrame.speaker, 'reviewer')
      assert.deepEqual(selectionFrame.selection, {
        provider: providerName,
        model: 'default-a',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      })
    })
  } finally {
    harness.cleanup()
    setRuntimeDefaultModelState(undefined)
  }
})

test('an explicit agent choice publishes its admitted pair as the agent\'s own choice, never as default use', async () => {
  const harness = await makeHarness()
  const turnId = randomUUID()
  const hub = new AgentTextStreamHub()
  try {
    await withConfiguredProvider(async (providerName) => {
      writeExplicitAgent(harness.repoRootPath, 'reviewer', providerName, 'pinned-model')
      // Today's default is the same pair the agent chose.
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'pinned-model',
      })
      await runSessionAgentChatTurn({
        sessionId: harness.sessionId,
        session: SESSION,
        sessionStore: harness.store,
        repoRootPath: harness.repoRootPath,
        text: 'First question.',
        agentNames: ['reviewer'],
        turnId,
        textStreamHub: hub,
      })

      const page = hub.read(turnId, 0)
      assert.ok(page, 'the turn channel must hold frames')
      const frames = page.frames
      const selectionFrames = frames.filter((frame) => frame.type === 'selection')
      assert.equal(
        selectionFrames.length,
        1,
        'the reply must publish exactly one selection frame',
      )

      const firstTextIndex = frames.findIndex(
        (frame) => frame.type === 'delta' || frame.type === 'final',
      )
      const firstText = frames[firstTextIndex]
      assert.ok(
        firstText && (firstText.type === 'delta' || firstText.type === 'final'),
        'the turn must have produced text',
      )
      const selectionIndex = frames.findIndex((frame) => frame.type === 'selection')
      assert.ok(
        selectionIndex < firstTextIndex,
        'the selection must be published before any text frame',
      )

      const selectionFrame = selectionFrames[0]
      assert.ok(selectionFrame)
      assert.equal(selectionFrame.replyId, firstText.replyId)
      assert.equal(selectionFrame.speaker, 'reviewer')
      assert.deepEqual(selectionFrame.selection, {
        provider: providerName,
        model: 'pinned-model',
        source: 'agent',
        reason: 'explicit-agent-choice',
        caller: 'agent',
      })

      const messages = await harness.store.listChatMessages(harness.sessionId)
      const admitted = userTurn(messages, turnId).turnRequest?.admittedSelections
      assert.deepEqual(selectionFrame.selection, admitted?.reviewer)

      assert.equal(
        frames.some(
          (frame) =>
            frame.type === 'selection' && frame.selection.source === 'app-default',
        ),
        false,
        'no frame on the turn may announce default use',
      )
    })
  } finally {
    harness.cleanup()
    setRuntimeDefaultModelState(undefined)
  }
})

// General Agent resolves its pair in the front-door branch of the speaker
// loader, from the composer or the app-wide default, and the live frame is
// published from whatever selection the loader admitted. These two tests pin
// the join: the front door's reply streams the same record its user message
// keeps, whichever of the two decided it.
async function runGeneralAgentTurn(
  harness: Harness,
  turnId: string,
  hub: AgentTextStreamHub,
  composer?: { readonly provider: string; readonly model: string },
): Promise<void> {
  writeInheritingAgent(harness.repoRootPath, GENERAL_AGENT_NAME)
  await runSessionAgentChatTurn({
    sessionId: harness.sessionId,
    session: SESSION,
    sessionStore: harness.store,
    repoRootPath: harness.repoRootPath,
    text: 'What does this app do?',
    agentNames: [GENERAL_AGENT_NAME],
    turnId,
    textStreamHub: hub,
    ...(composer ? { provider: composer.provider, model: composer.model } : {}),
  })
}

async function assertOneGeneralAgentFrame(
  harness: Harness,
  turnId: string,
  hub: AgentTextStreamHub,
  expected: Record<string, string>,
): Promise<void> {
  const page = hub.read(turnId, 0)
  assert.ok(page, 'the turn channel must hold frames')
  const frames = page.frames
  const selectionFrames = frames.filter((frame) => frame.type === 'selection')
  assert.equal(selectionFrames.length, 1, 'the reply must publish exactly one selection frame')

  const firstTextIndex = frames.findIndex(
    (frame) => frame.type === 'delta' || frame.type === 'final',
  )
  const firstText = frames[firstTextIndex]
  assert.ok(
    firstText && (firstText.type === 'delta' || firstText.type === 'final'),
    'the turn must have produced text',
  )
  assert.ok(
    frames.findIndex((frame) => frame.type === 'selection') < firstTextIndex,
    'the selection must be published before any text frame',
  )

  const selectionFrame = selectionFrames[0]
  assert.ok(selectionFrame)
  assert.equal(selectionFrame.replyId, firstText.replyId)
  // The frame carries the speaker's durable id, not the "General Agent"
  // label; the UI finds the frame by replyId.
  assert.equal(selectionFrame.speaker, GENERAL_AGENT_NAME)
  assert.deepEqual(selectionFrame.selection, expected)

  const messages = await harness.store.listChatMessages(harness.sessionId)
  const admitted = userTurn(messages, turnId).turnRequest?.admittedSelections
  assert.deepEqual(selectionFrame.selection, admitted?.[GENERAL_AGENT_NAME])
}

test('a General Agent reply streams the app default it was admitted on, as its message records it', async () => {
  const harness = await makeHarness()
  const turnId = randomUUID()
  const hub = new AgentTextStreamHub()
  try {
    await withConfiguredProvider(async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'default-a',
      })
      await runGeneralAgentTurn(harness, turnId, hub)
      await assertOneGeneralAgentFrame(harness, turnId, hub, {
        provider: providerName,
        model: 'default-a',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'agent',
      })
    })
  } finally {
    harness.cleanup()
    setRuntimeDefaultModelState(undefined)
  }
})

test('a General Agent reply streams the composer\'s pair as the person\'s choice, as its message records it', async () => {
  const harness = await makeHarness()
  const turnId = randomUUID()
  const hub = new AgentTextStreamHub()
  try {
    await withConfiguredProvider(async (providerName) => {
      setRuntimeDefaultModelState({
        status: 'available',
        provider: providerName,
        model: 'default-a',
      })
      await runGeneralAgentTurn(harness, turnId, hub, {
        provider: providerName,
        model: 'composer-model',
      })
      await assertOneGeneralAgentFrame(harness, turnId, hub, {
        provider: providerName,
        model: 'composer-model',
        source: 'user',
        reason: 'explicit-user-choice',
        caller: 'agent',
      })
    })
  } finally {
    harness.cleanup()
    setRuntimeDefaultModelState(undefined)
  }
})
