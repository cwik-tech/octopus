import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateConciseTitle,
  generateSessionTitle,
  shouldGenerateSessionTitle,
} from '../../domains/sessions/session-title.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import type { ChatMessage, SessionSummary } from '../../contracts/sessions.js'

const SESSION: SessionSummary = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Untitled session',
  status: 'idle',
  activityType: 'chat',
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
}

test('shouldGenerateSessionTitle returns true after the first user message', () => {
  assert.equal(
    shouldGenerateSessionTitle({
      session: SESSION,
      history: [
        message('user', 'Create an executive summary for the sales team.'),
      ],
    }),
    true,
  )
})

test('shouldGenerateSessionTitle does not overwrite renamed sessions', () => {
  assert.equal(
    shouldGenerateSessionTitle({
      session: { ...SESSION, title: 'Sales Summary' },
      history: [
        message('assistant', 'Could you clarify the goal?'),
        message('user', 'Create an executive summary for the sales team.'),
      ],
    }),
    false,
  )
})

test('shouldGenerateSessionTitle remains eligible after assistant replies', () => {
  assert.equal(
    shouldGenerateSessionTitle({
      session: SESSION,
      history: [
        message('assistant', 'Looks good.'),
        message('user', 'Create an executive summary for the sales team.'),
        message('assistant', 'I can help with that.'),
      ],
    }),
    true,
  )
})

test('generateSessionTitle leaves the session untitled when no AI title model is available', async () => {
  // The condition is the *selection*, not a credential. A key for some vendor
  // being present or absent has nothing to do with whether this helper has a
  // model it was told to use.
  setRuntimeDefaultModelState({ status: 'unset' })
  try {
    const result = await generateSessionTitle({
      session: SESSION,
      history: [
        message('user', 'Write a one-page report on Ohio for a general professional audience.'),
      ],
    })

    assert.equal(result.title, null)
    assert.equal(result.fallback, true)
    assert.equal(result.reason, 'no application default model is selected')
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
})

test('generateSessionTitle never replaces an untitleable first request with a follow-up', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const result = await generateSessionTitle({
      session: SESSION,
      history: [
        message('user', 'I will check that.'),
        message('assistant', 'What would you like to do next?'),
        message('user', 'Start it.'),
      ],
    })

    assert.equal(result.title, null)
    assert.equal(result.fallback, true)
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousApiKey
  }
})

function message(role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id: `${role}-${text}`,
    role,
    text,
    createdAt: '2026-05-01T12:00:00.000Z',
  }
}

// ─── The title helper owns no agent ─────────────────────────────────────────
//
// It runs on the one application default or it does not run. There is no third
// source: a hardcoded vendor model reached with a raw environment key is
// exactly the hidden hierarchy the two-choice rule removes, and a missing
// title is harmless where an unrequested model call is not.
//
// Tested with a credential *present* and the network watched. Deleting the key
// would prove only that a call without a key does not happen.

async function withWatchedNetwork(
  fn: () => Promise<void>,
): Promise<URL[]> {
  const calls: URL[] = []
  const originalFetch = globalThis.fetch
  const originalKey = process.env.OPENAI_API_KEY
  const originalModel = process.env.SESSION_TITLE_MODEL
  process.env.OPENAI_API_KEY = 'title-helper-key-should-not-be-used'
  delete process.env.SESSION_TITLE_MODEL
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input)))
    throw new Error('the title helper must not reach the network')
  }) as typeof globalThis.fetch
  setRuntimeDefaultModelState({ status: 'unset' })
  try {
    await fn()
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
    if (originalModel === undefined) delete process.env.SESSION_TITLE_MODEL
    else process.env.SESSION_TITLE_MODEL = originalModel
    setRuntimeDefaultModelState(undefined)
  }
  return calls
}

test('a concise title with no application default reaches no provider at all', async () => {
  let result: Awaited<ReturnType<typeof generateConciseTitle>> | undefined
  const calls = await withWatchedNetwork(async () => {
    result = await generateConciseTitle({
      history: [message('user', 'Draft the quarterly board update for Acme.')],
    })
  })

  assert.deepEqual(calls, [])
  assert.ok(result)
  assert.equal(result.fallback, true)
  assert.match(String(result.reason), /application default/i)
})

test('a session title with no application default reaches no provider either', async () => {
  let result: Awaited<ReturnType<typeof generateSessionTitle>> | undefined
  const calls = await withWatchedNetwork(async () => {
    result = await generateSessionTitle({
      session: SESSION,
      history: [message('user', 'Draft the quarterly board update for Acme.')],
    })
  })

  assert.deepEqual(calls, [])
  assert.ok(result)
  assert.equal(result.fallback, true)
})

test('a caller that names its own pair is still honoured', async () => {
  // Explicit ad hoc selections are not affected by any of this.
  const calls = await withWatchedNetwork(async () => {
    const result = await generateConciseTitle({
      history: [message('user', 'Draft the quarterly board update for Acme.')],
      provider: 'not-a-registered-provider',
      model: 'some-model',
    })
    // The provider lookup fails, which is the caller's own selection failing —
    // not a silent fall back to somebody else's model.
    assert.equal(result.fallback, true)
    assert.doesNotMatch(String(result.reason), /application default/i)
  })

  assert.deepEqual(calls, [])
})
