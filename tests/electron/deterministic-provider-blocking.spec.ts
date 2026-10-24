/**
 * The deterministic provider's release gate.
 *
 * A Team-chat journey has to observe the moment between "the coordinator has
 * chosen" and "the specialists have answered", which means holding exactly the
 * specialists' answers. Holding by request ordinal cannot do that: a run also
 * issues model probes and a session-title request, and their order relative to
 * the coordinator's tool turns is not fixed, so an ordinal blocks whichever
 * request happens to land in that position. This gate blocks by what the
 * request asks for instead.
 */
import { expect, test } from '@playwright/test'

import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'

async function ask(baseUrl: string, prompt: string): Promise<string> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4-mini', input: prompt }),
  })
  const payload = (await response.json()) as { output_text?: string }
  return payload.output_text ?? ''
}

test('the provider holds only the requests a test names, and releases them on demand', async () => {
  const provider = await startDeterministicOpenAiServer({
    blockRequestsMatching: ['You are spec-beta'],
    matchers: [
      { match: 'You are spec-beta', text: 'Spec beta answers.' },
      { match: 'You are spec-alpha', text: 'Spec alpha answers.' },
      { match: 'Name this session', text: 'Manufacturing investment' },
    ],
  })

  try {
    let heldSettled = false
    const held = ask(provider.baseUrl, 'You are spec-beta. Answer.').then(
      (text) => {
        heldSettled = true
        return text
      },
    )
    await provider.waitForRequest(1)

    // Two later requests complete a full round trip while the named one waits,
    // so "still held" is observed against real server activity, not a delay.
    expect(await ask(provider.baseUrl, 'Name this session from its brief.')).toBe(
      'Manufacturing investment',
    )
    expect(await ask(provider.baseUrl, 'You are spec-alpha. Answer.')).toBe(
      'Spec alpha answers.',
    )
    expect(heldSettled).toBe(false)

    provider.releaseBlockedResponses()
    expect(await held).toBe('Spec beta answers.')
  } finally {
    await provider.close()
  }
})

test('the provider says when it starts holding a named request, and whether it still is', async () => {
  const provider = await startDeterministicOpenAiServer({
    blockRequestsMatching: ['You are spec-beta'],
    matchers: [
      { match: 'You are spec-beta', text: 'Spec beta answers.' },
      { match: 'Name this session', text: 'Manufacturing investment' },
    ],
  })

  try {
    let heard = false
    const holding = provider.waitForBlockedRequest('You are spec-beta').then(() => {
      heard = true
    })

    // An unnamed request completes a whole round trip; nothing is held yet.
    expect(await ask(provider.baseUrl, 'Name this session from its brief.')).toBe(
      'Manufacturing investment',
    )
    expect(heard).toBe(false)
    expect(provider.isHoldingRequest('You are spec-beta')).toBe(false)

    // The named request arrives and is held: the event fires, and the server
    // reports it as held while it waits.
    const held = ask(provider.baseUrl, 'You are spec-beta. Answer.')
    await holding
    expect(provider.isHoldingRequest('You are spec-beta')).toBe(true)
    expect(provider.isHoldingRequest('You are spec-alpha')).toBe(false)

    // Released, it is answered and no longer held.
    provider.releaseBlockedResponses()
    expect(await held).toBe('Spec beta answers.')
    expect(provider.isHoldingRequest('You are spec-beta')).toBe(false)
  } finally {
    provider.releaseBlockedResponses()
    await provider.close()
  }
})
