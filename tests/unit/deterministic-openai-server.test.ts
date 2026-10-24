import assert from 'node:assert/strict'
import test from 'node:test'

import { startDeterministicOpenAiServer } from '../electron/support/deterministic-openai-server.js'

interface ChatCompletionResponse {
  choices: Array<{
    finish_reason: string
    message: {
      content: string | null
      tool_calls?: Array<{
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
    }
  }>
}

async function postChatCompletion(
  baseUrl: string,
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4-mini', messages: [] }),
  })
  assert.equal(response.status, 200)
  return (await response.json()) as ChatCompletionResponse
}

test('a scripted server serves queued tool calls in order, then falls back to text', async () => {
  const provider = await startDeterministicOpenAiServer({
    script: [
      { toolName: 'set_roster', arguments: { agents: ['agent-a', 'agent-b'] } },
      { toolName: 'converse', arguments: { to: 'all', message: 'Begin.' } },
      { text: 'Roster locked and the board has spoken.' },
    ],
  })
  try {
    const first = await postChatCompletion(provider.baseUrl)
    assert.equal(first.choices[0]?.finish_reason, 'tool_calls')
    const firstCall = first.choices[0]?.message.tool_calls?.[0]
    assert.equal(firstCall?.function.name, 'set_roster')
    assert.deepEqual(JSON.parse(firstCall?.function.arguments ?? '{}'), {
      agents: ['agent-a', 'agent-b'],
    })

    const second = await postChatCompletion(provider.baseUrl)
    assert.equal(
      second.choices[0]?.message.tool_calls?.[0]?.function.name,
      'converse',
    )

    const third = await postChatCompletion(provider.baseUrl)
    assert.equal(third.choices[0]?.finish_reason, 'stop')
    assert.equal(
      third.choices[0]?.message.content,
      'Roster locked and the board has spoken.',
    )

    // Past the end of the script the server keeps answering, so a run that
    // takes more turns than scripted degrades to plain text instead of hanging.
    const fourth = await postChatCompletion(provider.baseUrl)
    assert.equal(fourth.choices[0]?.finish_reason, 'stop')
    assert.ok((fourth.choices[0]?.message.content ?? '').length > 0)
  } finally {
    await provider.close()
  }
})

test('an unscripted server keeps its existing plain-text behaviour', async () => {
  const provider = await startDeterministicOpenAiServer()
  try {
    const result = await postChatCompletion(provider.baseUrl)
    assert.equal(result.choices[0]?.finish_reason, 'stop')
    assert.match(result.choices[0]?.message.content ?? '', /Batch result 1/)
    assert.equal(result.choices[0]?.message.tool_calls, undefined)
  } finally {
    await provider.close()
  }
})
