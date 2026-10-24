import assert from 'node:assert/strict'

import {
  BraveSearchProvider,
  ExaSearchProvider,
  FirecrawlReaderProvider,
} from '../../domains/acquisition/acquisition-providers.js'
import {
  apiKeyCapability,
  liveTest,
} from './live-provider-support.js'

liveTest(
  'Exa returns live normalized discovery results',
  'exa-search',
  apiKeyCapability('EXA_API_KEY'),
  async () => {
    const results = await new ExaSearchProvider(
      process.env.EXA_API_KEY!,
    ).search({
      query: 'OpenAI official research',
      maximumResults: 3,
      includeDomains: ['openai.com'],
      excludeDomains: [],
    })
    assert.ok(results.length > 0)
    assert.ok(results.every((result) => result.provider === 'exa'))
    assert.ok(results.every((result) => new URL(result.canonicalUrl).protocol === 'https:'))
  },
)

liveTest(
  'Brave Search returns live normalized discovery results',
  'brave-search',
  apiKeyCapability('BRAVE_SEARCH_API_KEY'),
  async () => {
    const results = await new BraveSearchProvider(
      process.env.BRAVE_SEARCH_API_KEY!,
    ).search({
      query: 'OpenAI official research',
      maximumResults: 3,
      includeDomains: ['openai.com'],
      excludeDomains: [],
    })
    assert.ok(results.length > 0)
    assert.ok(results.every((result) => result.provider === 'brave'))
    assert.ok(results.every((result) => new URL(result.canonicalUrl).protocol === 'https:'))
  },
)

liveTest(
  'Firecrawl returns live readable source content',
  'firecrawl-reader',
  apiKeyCapability('FIRECRAWL_API_KEY'),
  async () => {
    const result = await new FirecrawlReaderProvider(
      process.env.FIRECRAWL_API_KEY!,
    ).acquire('https://example.com/')
    assert.match(result.text, /Example Domain/i)
    assert.equal(result.mediaType, 'text/markdown')
  },
)

