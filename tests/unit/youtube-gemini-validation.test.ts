import assert from 'node:assert/strict'
import * as http from 'node:http'
import { test } from 'node:test'

import {
  listYoutubeGeminiModels,
  validateYoutubeGeminiModel,
} from '../../domains/youtube/youtube-gemini-validation.js'

test('Gemini model validation rejects a model without generateContent support', async (context) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      name: 'models/gemini-3.6-flash',
      supportedGenerationMethods: ['countTokens'],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  await assert.rejects(validateYoutubeGeminiModel(
    { apiKey: 'private-api-key', model: 'gemini-3.6-flash', source: 'persisted' },
    undefined,
    `http://127.0.0.1:${address.port}`,
  ), /validation failed/i)
})

test('Gemini model discovery follows pagination and returns only generateContent Gemini models', async (context) => {
  const requests: URL[] = []
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-goog-api-key'], 'private-api-key')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(url)
    response.setHeader('content-type', 'application/json')
    if (!url.searchParams.has('pageToken')) {
      response.end(JSON.stringify({
        models: [
          {
            name: 'models/gemini-3.6-pro',
            displayName: 'Gemini 3.6 Pro',
            description: 'Higher-capability model.',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-3.7-flash-image',
            displayName: 'Nano Banana',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-3.7-flash-preview-tts',
            displayName: 'Gemini 3.7 Flash Preview TTS',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/gemini-3.7-computer-use',
            displayName: 'Gemini 3.7 Computer Use',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Text Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
        nextPageToken: 'second-page',
      }))
      return
    }
    response.end(JSON.stringify({
      models: [
        {
          name: 'models/gemini-3.6-flash',
          displayName: 'Gemini 3.6 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-3.7-flash',
          displayName: 'Gemini 3.7 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemma-3-27b-it',
          displayName: 'Gemma',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const address = server.address()
  assert(address && typeof address === 'object')

  const models = await listYoutubeGeminiModels(
    { apiKey: 'private-api-key', model: 'gemini-3.6-flash', source: 'persisted' },
    undefined,
    `http://127.0.0.1:${address.port}`,
  )

  assert.deepEqual(models, [
    { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
    { id: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash' },
    {
      id: 'gemini-3.6-pro',
      displayName: 'Gemini 3.6 Pro',
      description: 'Higher-capability model.',
    },
  ])
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.searchParams.get('pageSize'), '1000')
  assert.equal(requests[1]?.searchParams.get('pageToken'), 'second-page')
})

test('Gemini model discovery rejects provider failures without exposing the API key', async () => {
  await assert.rejects(
    listYoutubeGeminiModels(
      { apiKey: 'secret-that-must-not-leak', model: 'gemini-3.6-flash', source: 'persisted' },
      undefined,
      'http://127.0.0.1:1',
    ),
    (error: unknown) => {
      assert(error instanceof Error)
      assert.equal(error.message.includes('secret-that-must-not-leak'), false)
      return true
    },
  )
})
