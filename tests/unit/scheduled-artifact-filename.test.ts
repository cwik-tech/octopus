import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildScheduledArtifactFilename,
  generateScheduledArtifactFilename,
  timestampedResultFilename,
} from '../../domains/scheduling/scheduled-artifact-filename.js'

const FIRED_AT = new Date('2026-07-20T18:42:07.321Z')

test('scheduled artifact filenames use safe semantic kebab-case names', () => {
  assert.equal(
    buildScheduledArtifactFilename('Café & AI / Market: Outlook', FIRED_AT),
    'cafe-ai-market-outlook.md',
  )
  assert.match(
    buildScheduledArtifactFilename('A'.repeat(100), FIRED_AT),
    /^[a-z0-9-]{1,64}\.md$/,
  )
})

test('scheduled artifact filenames fall back to an unambiguous fire timestamp', () => {
  assert.equal(
    timestampedResultFilename(FIRED_AT),
    'result-2026-07-20-18-42-07Z.md',
  )
  assert.equal(
    buildScheduledArtifactFilename(null, FIRED_AT),
    'result-2026-07-20-18-42-07Z.md',
  )
  assert.equal(
    buildScheduledArtifactFilename('result', FIRED_AT),
    'result-2026-07-20-18-42-07Z.md',
  )
  assert.equal(
    buildScheduledArtifactFilename('CON', FIRED_AT),
    'result-2026-07-20-18-42-07Z.md',
  )
})

test('scheduled artifact generation reuses the chat-title brief fallback', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    assert.equal(
      await generateScheduledArtifactFilename({
        brief: 'Write a one-page report on Ohio for a general professional audience.',
        firedAt: FIRED_AT,
      }),
      'ohio-overview.md',
    )
    assert.equal(
      await generateScheduledArtifactFilename({
        brief: 'I will check that.',
        firedAt: FIRED_AT,
      }),
      'result-2026-07-20-18-42-07Z.md',
    )
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousApiKey
  }
})
