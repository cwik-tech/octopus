import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod/v4'

import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).optional(),
    }),
  })).min(1),
})

test('the marker provider fixture answers without calling baseline file or dialogue tools', async (t) => {
  // The paid model boundary is replaced by the real local provider fixture;
  // this tests its HTTP behavior, without substituting an application module.
  const fixture = await startOpenAiToolLoopFixture()
  t.after(() => fixture.close())

  const response = await postMarkerRequest(fixture.url, [makeTool('create_file'), makeTool('start_dialogue')])

  assert.equal(response.status, 200, await response.clone().text())
  const completion = completionSchema.parse(await response.json())
  assert.equal(completion.choices[0]?.message.content, 'provider-no-tools')
  assert.equal(completion.choices[0]?.message.tool_calls, undefined)
})

test('the marker provider fixture still calls an external tool beside baseline tools', async (t) => {
  const fixture = await startOpenAiToolLoopFixture()
  t.after(() => fixture.close())

  const response = await postMarkerRequest(fixture.url, [makeTool('external_marker', {
    type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'],
  }), makeTool('create_file'), makeTool('start_dialogue')])

  assert.equal(response.status, 200, await response.clone().text())
  const completion = completionSchema.parse(await response.json())
  assert.deepEqual(completion.choices[0]?.message.tool_calls?.map((call) => call.function), [{
    name: 'external_marker', arguments: '{"marker":"provider-loop-marker"}',
  }])
})

function makeTool(name: string, parameters: Readonly<Record<string, unknown>> = { type: 'object', properties: {} }) {
  return { type: 'function', function: { name, parameters } }
}

function postMarkerRequest(url: string, tools: readonly ReturnType<typeof makeTool>[]) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture/tool-loop',
      messages: [{ role: 'user', content: 'Use the available marker tool and return its result.' }],
      tools,
    }),
    signal: AbortSignal.timeout(2_000),
  })
}
