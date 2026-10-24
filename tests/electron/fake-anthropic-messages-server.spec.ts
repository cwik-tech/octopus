/**
 * The fake Anthropic Messages endpoint, read by the product's own provider.
 *
 * A Team member on bare `anthropic` has no native tool lane, so the Team
 * child calls the provider directly and every `text_delta` suffix reaches the
 * run's preview as it arrives. The Team streaming journeys stage that growth,
 * so this fake holds every suffix after the first until
 * `releaseHeldChunks()`, and the frames that end the answer until
 * `releaseTerminal()`. Proven here through real HTTP and the real reader
 * (`providers/anthropic.ts`, `providers/messages-stream.ts`); "still held" is
 * observed against full round trips on the same server, not against a delay.
 */
import { expect, test } from '@playwright/test'

import { createAnthropicProvider } from '../../providers/anthropic.js'
import type { ProviderResult } from '../../providers/types.js'
import { startFakeAnthropicMessagesServer } from './support/fake-anthropic-messages-server.js'

const OPENING = 'The first tradeoff'
const REST = ' is portability.'
const FAKE_KEY = 'fake-anthropic-regression-key'

/** A whole request and response on the same server, used as the observation point. */
async function roundTrip(messagesUrl: string): Promise<number> {
  const response = await fetch(messagesUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
    body: JSON.stringify({
      model: 'fake-claude-stream',
      max_tokens: 64,
      system: 'Name this session from its brief.',
      messages: [{ role: 'user', content: 'brief' }],
    }),
  })
  await response.text()
  return response.status
}

test('the product reader sees a held suffix and a held terminal until each is released', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = FAKE_KEY
  const fake = await startFakeAnthropicMessagesServer({
    turns: [{ persona: 'You are line-one', chunks: [OPENING, REST] }],
  })
  try {
    const texts: string[] = []
    const waiters = new Set<{ readonly predicate: () => boolean; readonly resolve: () => void }>()
    let settled: { readonly result?: ProviderResult; readonly error?: unknown } | undefined
    const execution = createAnthropicProvider()
      .execute({
        systemPrompt: 'You are line-one. Complete your assigned step.',
        userMessage: 'summarize these tradeoffs',
        model: 'fake-claude-stream',
        thinking: 'low',
        providerConfig: { base_url: fake.messagesUrl },
        onProtocolEvent: (event) => {
          if (event.kind !== 'text' || typeof event.text !== 'string') return
          texts.push(event.text)
          for (const waiter of [...waiters]) {
            if (waiter.predicate()) {
              waiters.delete(waiter)
              waiter.resolve()
            }
          }
        },
      })
      .then(
        (result) => { settled = { result } },
        (error: unknown) => { settled = { error } },
      )
    // Resolves when the reader has seen `expected`; fails at once if the turn
    // settles first, so a refused or broken stream is reported, not waited out.
    const untilText = async (expected: string): Promise<void> => {
      const seen = () => texts.join('') === expected
      if (seen()) return
      await Promise.race([
        new Promise<void>((resolve) => waiters.add({ predicate: seen, resolve })),
        execution.then(() => {
          if (!seen()) {
            throw new Error(`The turn settled before the reader saw ${JSON.stringify(expected)}: ${JSON.stringify(settled)}`)
          }
        }),
      ])
    }

    // The opening suffix arrives, and nothing after it while held.
    await untilText(OPENING)
    expect(await roundTrip(fake.messagesUrl)).toBe(200)
    expect(texts).toEqual([OPENING])
    expect(settled).toBeUndefined()

    // Released, the rest arrives, and the turn is still open.
    fake.releaseHeldChunks()
    await untilText(`${OPENING}${REST}`)
    expect(await roundTrip(fake.messagesUrl)).toBe(200)
    expect(settled).toBeUndefined()

    // Released, the terminal frames end it, and the reader accepts the answer.
    fake.releaseTerminal()
    await execution
    expect(settled?.error).toBeUndefined()
    expect(settled?.result?.text).toBe(`${OPENING}${REST}`)

    // The answering request was the streamed Messages call the provider makes,
    // with the fake key and the persona that claimed it.
    const claimed = fake.requests.filter((request) => request.system?.includes('You are line-one'))
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ stream: true, model: 'fake-claude-stream', apiKey: FAKE_KEY })
  } finally {
    // Nothing here can throw before the close, so every step runs.
    fake.releaseHeldChunks()
    fake.releaseTerminal()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await fake.close()
  }
})

test('a blocked turn sends nothing, headers included, until its responses are released', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = FAKE_KEY
  const fake = await startFakeAnthropicMessagesServer({
    turns: [{ persona: 'You are spec-beta', chunks: [`${OPENING}${REST}`], blocked: true }],
  })
  try {
    let answered = false
    let failure: unknown
    const execution = createAnthropicProvider()
      .execute({
        systemPrompt: 'You are spec-beta. Answer.',
        userMessage: 'which runtime?',
        model: 'fake-claude-stream',
        thinking: 'low',
        providerConfig: { base_url: fake.messagesUrl },
      })
      .then(
        (result) => {
          answered = true
          return result
        },
        (error: unknown) => {
          failure = error
          throw error
        },
      )

    // The request arrives and is held: full round trips on the same server
    // complete while the blocked turn has produced nothing.
    await fake.waitForRequest(1)
    expect(fake.requests.filter((request) => request.system?.includes('You are spec-beta'))).toHaveLength(1)
    expect(await roundTrip(fake.messagesUrl)).toBe(200)
    expect(await roundTrip(fake.messagesUrl)).toBe(200)
    expect(answered).toBe(false)
    expect(failure).toBeUndefined()

    fake.releaseBlockedResponses()
    const result = await execution
    expect(result.text).toBe(`${OPENING}${REST}`)
  } finally {
    // Nothing here can throw before the close, so every step runs.
    fake.releaseBlockedResponses()
    fake.releaseHeldChunks()
    fake.releaseTerminal()
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    await fake.close()
  }
})
