import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  AcquisitionSearchCoordinator,
  BraveSearchProvider,
  ExaSearchProvider,
} from '../../domains/acquisition/acquisition-providers.js'

test('real local provider endpoints merge and deduplicate complementary search results', async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    response.setHeader('content-type', 'application/json')
    if (request.url === '/exa') {
      assert.equal(request.headers['x-api-key'], 'exa-key')
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        query: string
        startPublishedDate: string
        endPublishedDate: string
      }
      assert.equal(input.query, 'state of the art acquisition')
      assert.equal(input.startPublishedDate, '2026-01-01T00:00:00.000Z')
      assert.equal(input.endPublishedDate, '2026-07-24T23:59:59.999Z')
      response.end(JSON.stringify({
        results: [
          {
            title: 'Primary specification',
            url: 'https://standards.example.org/spec?version=2&utm_source=exa',
            text: 'Primary specification excerpt',
            score: 0.9,
          },
        ],
      }))
      return
    }
    assert.match(request.url ?? '', /^\/brave\?/u)
    assert.equal(request.headers['x-subscription-token'], 'brave-key')
    assert.equal(
      new URL(request.url ?? '/', 'http://localhost').searchParams.get('freshness'),
      '2026-01-01to2026-07-24',
    )
    response.end(JSON.stringify({
      web: {
        results: [
          {
            title: 'Primary specification duplicate',
            url: 'https://standards.example.org/spec?version=2',
            description: 'Duplicate result from a complementary index.',
          },
          {
            title: 'Independent analysis',
            url: 'https://analysis.example.com/report',
            description: 'Independent analysis.',
          },
        ],
      },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    const coordinator = new AcquisitionSearchCoordinator([
      new ExaSearchProvider('exa-key', `${baseUrl}/exa`),
      new BraveSearchProvider('brave-key', `${baseUrl}/brave`),
    ])
    const results = await coordinator.search({
      query: 'state of the art acquisition',
      maximumResults: 5,
      includeDomains: [],
      excludeDomains: [],
      publishedAfter: '2026-01-01',
      publishedBefore: '2026-07-24',
    })
    assert.equal(results.length, 2)
    assert.equal(results[0]?.canonicalUrl, 'https://standards.example.org/spec?version=2')
    assert.equal(results[0]?.score, 1.25)
    assert.equal(results[1]?.provider, 'brave')
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  }
})
