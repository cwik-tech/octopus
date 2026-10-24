import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import {
  parseYoutubeRetryAfterMs,
  YoutubeGeminiAnalysisClient,
  YoutubeGeminiAnalysisError,
} from '../../domains/youtube/youtube-gemini-analysis.js'

test('Gemini Retry-After accepts delta seconds and HTTP dates', () => {
  const now = new Date('2026-08-13T12:00:00.000Z')
  assert.equal(parseYoutubeRetryAfterMs('1.5', now), 1_500)
  assert.equal(parseYoutubeRetryAfterMs('Thu, 13 Aug 2026 12:00:02 GMT', now), 2_000)
  assert.equal(parseYoutubeRetryAfterMs('invalid', now), 250)
})

test('Gemini analysis sends a stateless public YouTube request and validates structured output', async (context) => {
  let receivedBody: Record<string, unknown> | undefined
  let receivedKey: string | undefined
  const server = http.createServer(async (req, res) => {
    receivedKey = String(req.headers['x-goog-api-key'] ?? '')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'interaction-1',
      status: 'completed',
      model: 'gemini-3.6-flash',
      usage: { total_input_tokens: 123, total_output_tokens: 45 },
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify({
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: 'sha256:source',
          model: 'gemini-3.6-flash',
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: 'en',
          detectedSourceLanguage: 'en',
          generatedAt: '2026-08-12T12:00:00.000Z',
          summary: 'A concise instructional summary.',
          steps: [{
            id: 'first-step',
            title: 'Complete the first step',
            explanation: 'Follow the controls shown on screen.',
            startSeconds: 5,
            endSeconds: 10,
            visualCandidates: [{
              timestampSeconds: 7,
              importance: 'required',
              reason: 'The control is visible.',
              caption: 'The required control',
              altText: 'Application window with the required control highlighted',
            }],
          }],
        }) }],
      }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const client = new YoutubeGeminiAnalysisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  })

  const result = await client.analyze({
    apiKey: 'private-key',
    model: 'gemini-3.6-flash',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
    sourceRevisionFingerprint: 'sha256:source',
    outputLanguage: 'en',
    generatedAt: '2026-08-12T12:00:00.000Z',
  })

  assert.equal(receivedKey, 'private-key')
  assert.equal(receivedBody?.model, 'gemini-3.6-flash')
  assert.equal(receivedBody?.store, false)
  assert.match(JSON.stringify(receivedBody), /https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/)
  assert.equal(JSON.stringify(receivedBody).includes('transcript'), false)
  const prompt = (receivedBody?.input as Array<{ type?: string; text?: string }> | undefined)
    ?.find((item) => item.type === 'text')?.text ?? ''
  assert.match(prompt, /set outputLanguage to "en" exactly/iu)
  assert.equal((receivedBody?.response_format as { mime_type?: string }).mime_type, 'application/json')
  const schemaText = JSON.stringify((receivedBody?.response_format as { schema?: unknown }).schema)
  assert.match(schemaText, /"maximum":90/)
  assert.equal(result.analysis.steps[0]?.visualCandidates[0]?.timestampSeconds, 7)
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 })
  assert.equal(result.requestId, 'interaction-1')
})

test('Gemini analysis classifies authentication failures without exposing provider payloads', async (context) => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 401
    res.end('credential secret and provider diagnostic')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  await assert.rejects(
    new YoutubeGeminiAnalysisClient({ baseUrl: `http://127.0.0.1:${address.port}` }).analyze({
      apiKey: 'invalid-key',
      model: 'gemini-3.6-flash',
      video: {
        videoId: 'dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Build a workflow',
        durationSeconds: 90,
      },
      sourceRevisionFingerprint: 'sha256:source',
      outputLanguage: 'en',
      generatedAt: '2026-08-12T12:00:00.000Z',
    }),
    (error: unknown) => error instanceof YoutubeGeminiAnalysisError &&
      error.kind === 'authentication' &&
      !error.message.includes('provider diagnostic'),
  )
})

test('Gemini analysis defaults the manual to the detected video language', async (context) => {
  let prompt = ''
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      input?: Array<{ type?: string; text?: string }>
    }
    prompt = body.input?.find((item) => item.type === 'text')?.text ?? ''
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'interaction-source-language',
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify({
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: 'sha256:source',
          model: 'gemini-3.6-flash',
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: 'es',
          detectedSourceLanguage: 'es',
          generatedAt: '2026-08-12T12:00:00.000Z',
          summary: 'Resumen instructivo.',
          steps: [{
            id: 'primer-paso',
            title: 'Primer paso',
            explanation: 'Siga el control mostrado.',
            startSeconds: 1,
            endSeconds: 3,
            visualCandidates: [{
              timestampSeconds: 2,
              importance: 'required',
              reason: 'El control está visible.',
              caption: 'El control',
              altText: 'Ventana con el control visible',
            }],
          }],
        }) }],
      }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await new YoutubeGeminiAnalysisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  }).analyze({
    apiKey: 'private-key',
    model: 'gemini-3.6-flash',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Crear un flujo',
      durationSeconds: 90,
    },
    sourceRevisionFingerprint: 'sha256:source',
    generatedAt: '2026-08-12T12:00:00.000Z',
  })

  assert.match(prompt, /same language as the video/iu)
  assert.equal(result.analysis.outputLanguage, 'es')
})

test('Gemini analysis retries one transient rate limit without retrying authentication', async (context) => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests += 1
    if (requests === 1) {
      res.statusCode = 429
      res.setHeader('retry-after', '0')
      res.end('rate limited')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'interaction-retried',
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify({
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: 'sha256:source',
          model: 'gemini-3.6-flash',
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: 'en',
          generatedAt: '2026-08-12T12:00:00.000Z',
          summary: 'Retried summary.',
          steps: [{
            id: 'retried-step', title: 'Retried step', explanation: 'Complete it.',
            startSeconds: 1, endSeconds: 2,
            visualCandidates: [{
              timestampSeconds: 1.5, importance: 'required', reason: 'Visible state.',
              caption: 'Visible state', altText: 'Visible state in the application',
            }],
          }],
        }) }],
      }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  await new YoutubeGeminiAnalysisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  }).analyze({
    apiKey: 'private-key',
    model: 'gemini-3.6-flash',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
    sourceRevisionFingerprint: 'sha256:source',
    outputLanguage: 'en',
    generatedAt: '2026-08-12T12:00:00.000Z',
  })

  assert.equal(requests, 2)
})

test('Gemini analysis normalizes an inverted provider step range before validation', async (context) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'interaction-inverted-range',
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify({
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: 'sha256:source',
          model: 'gemini-3.6-flash',
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: 'en',
          generatedAt: '2026-08-12T12:00:00.000Z',
          summary: 'A valid analysis with one inverted provider range.',
          steps: [{
            id: 'configure-agent',
            title: 'Configure the agent',
            explanation: 'Open the settings and save the agent configuration.',
            startSeconds: 42,
            endSeconds: 36,
            visualCandidates: [{
              timestampSeconds: 39,
              importance: 'required',
              reason: 'The settings are visible.',
              caption: 'Agent settings',
              altText: 'Agent settings panel with the configuration fields visible',
            }],
          }],
        }) }],
      }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await new YoutubeGeminiAnalysisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  }).analyze({
    apiKey: 'private-key',
    model: 'gemini-3.6-flash',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
    sourceRevisionFingerprint: 'sha256:source',
    outputLanguage: 'en',
    generatedAt: '2026-08-12T12:00:00.000Z',
  })

  assert.equal(result.analysis.steps[0]?.startSeconds, 36)
  assert.equal(result.analysis.steps[0]?.endSeconds, 42)
  assert.equal(result.analysis.steps[0]?.visualCandidates[0]?.timestampSeconds, 39)
})

test('Gemini analysis clamps fractional media-boundary timestamps to the metadata duration', async (context) => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      id: 'interaction-media-boundary',
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify({
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: 'sha256:source',
          model: 'gemini-3.6-flash',
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: 'en',
          generatedAt: '2026-08-12T12:00:00.000Z',
          summary: 'A valid analysis ending at the fractional media boundary.',
          steps: [{
            id: 'finish-workflow',
            title: 'Finish the workflow',
            explanation: 'Verify the final workflow state.',
            startSeconds: 88,
            endSeconds: 90.75,
            visualCandidates: [{
              timestampSeconds: 90.5,
              importance: 'required',
              reason: 'The final state is visible.',
              caption: 'Completed workflow',
              altText: 'Application showing the completed workflow state',
            }],
          }],
        }) }],
      }],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const result = await new YoutubeGeminiAnalysisClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
  }).analyze({
    apiKey: 'private-key',
    model: 'gemini-3.6-flash',
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 90,
    },
    sourceRevisionFingerprint: 'sha256:source',
    outputLanguage: 'en',
    generatedAt: '2026-08-12T12:00:00.000Z',
  })

  assert.equal(result.analysis.steps[0]?.endSeconds, 90)
  assert.equal(result.analysis.steps[0]?.visualCandidates[0]?.timestampSeconds, 90)
})

test('screenshot review grounds captions in the captured pixels rather than the proposed video caption', async (t) => {
  let received: Record<string, unknown> = {}
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ captions: [{ index: 0, caption: 'Training-dataset slide', altText: 'A slide describing model training data' }] }) }] }], usage: { total_input_tokens: 20, total_output_tokens: 10 } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new YoutubeGeminiAnalysisClient({ baseUrl: `http://127.0.0.1:${address.port}` })
  const result = await client.reviewScreenshots({ apiKey: 'fixture', model: 'gemini-3.6-flash', outputLanguage: 'en',
    screenshots: [{ index: 0, data: 'cGl4ZWxz', proposedCaption: 'Claude horse promo', timestampSeconds: 40 }] })
  assert.equal(result.captions[0]?.caption, 'Training-dataset slide')
  assert.equal(result.usage?.inputTokens, 20)
  assert.deepEqual((received.input as { type: string; data?: string; mime_type?: string }[]).filter((part) => part.type === 'image'), [{ type: 'image', data: 'cGl4ZWxz', mime_type: 'image/png' }])
  assert.equal(JSON.stringify(received).includes('type":"video'), false)
})
