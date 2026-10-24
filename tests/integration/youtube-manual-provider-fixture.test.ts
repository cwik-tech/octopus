import assert from 'node:assert/strict'
import test from 'node:test'
import { startYoutubeManualProviderFixture } from '../support/youtube-manual-provider-fixture.js'

test('the live YouTube controller accepts the native coordinator Responses transport', async (t) => {
  const fixture = await startYoutubeManualProviderFixture({ videoId: 'b2tjnxX8IHU', videoUrl: 'https://www.youtube.com/watch?v=b2tjnxX8IHU',
    documentRequest: { formats: ['markdown'], purpose: 'takeaways', instructions: 'MD takeaways with screenshots.' } })
  t.after(() => fixture.close())
  const response = await fetch(`${fixture.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture/youtube-manual', input: [{ role: 'user', content: [{ type: 'input_text', text: '# Manual Generation Report\n\nMarkdown: output/manual.md' }] }] }), signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.output[0].content[0].text, '# Manual Generation Report\n\nMarkdown: output/manual.md')
})

test('the live controller can continue with Gemini after public transcript retrieval is unavailable', async (t) => {
  const fixture = await startYoutubeManualProviderFixture({ videoId: 'b2tjnxX8IHU', videoUrl: 'https://www.youtube.com/watch?v=b2tjnxX8IHU',
    documentRequest: { formats: ['markdown'], purpose: 'takeaways', instructions: 'MD takeaways with screenshots.' } })
  t.after(() => fixture.close())
  const response = await fetch(fixture.chatCompletionsUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture/youtube-manual', tools: [{ type: 'function', function: { name: 'youtube_extract' } }],
      messages: [{ role: 'tool', content: JSON.stringify({ action: 'capture', ok: false, error: { code: 'authentication_required', message: 'Public transcript retrieval unavailable.' } }) }] }), signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments).action, 'prepare_manual')
})
