import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveTitleFromBrief,
  isLazyPrefixOfBrief,
  postProcessTitle,
  resolveTitleSummarizerConfig,
  summarizeJobTitle,
} from '../../domains/job-title/job-title-summarizer.js'
import type { AppDefaultModelState } from '../../contracts/agent-model-selection.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { registerProvider } from '../../providers/registry.js'
import type { ProviderExecuteOptions, ProviderResult } from '../../providers/types.js'

function withAppDefault(state: AppDefaultModelState, fn: () => void): void {
  setRuntimeDefaultModelState(state)
  try {
    fn()
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
}

test('the title helper runs on the application default, not a team setting', () => {
  withAppDefault(
    { status: 'available', provider: 'connection:abc', model: 'gpt-5.4-mini' },
    () => {
      assert.deepEqual(resolveTitleSummarizerConfig(), {
        provider: 'connection:abc',
        model: 'gpt-5.4-mini',
        thinking: 'low',
      })
    },
  )
})

test('the title helper declines rather than reaching for another model', () => {
  withAppDefault({ status: 'unset' }, () => {
    assert.equal(resolveTitleSummarizerConfig(), null)
  })
  withAppDefault(
    { status: 'unavailable', provider: 'connection:abc', model: 'gpt-5.4-mini' },
    () => {
      assert.equal(resolveTitleSummarizerConfig(), null)
    },
  )
})

test('postProcessTitle returns a clean single-line title from a one-line response', () => {
  assert.equal(postProcessTitle('Krakow City Profile'), 'Krakow City Profile')
})

test('postProcessTitle picks the last clean line when the model narrates first', () => {
  const raw = [
    "I'm reading `prompt.md` first to identify the user's request",
    '',
    'Krakow City Profile',
  ].join('\n')

  assert.equal(postProcessTitle(raw), 'Krakow City Profile')
})

test('postProcessTitle strips quotes, markdown bullets, and trailing punctuation', () => {
  assert.equal(postProcessTitle('- "Michigan State Overview."'), 'Michigan State Overview')
})

test('postProcessTitle rejects pure narration with no clean line', () => {
  const raw = "I'm reading `prompt.md` first to identify the user's request"
  assert.equal(postProcessTitle(raw), null)
})

test('postProcessTitle truncates long titles to at most 8 words and 70 characters', () => {
  const raw = 'Strategic Investor Memo About Agridynamics Robotics Series A Round Evaluation'
  const result = postProcessTitle(raw)
  assert.ok(result, 'expected a truncated title')
  assert.ok((result?.split(' ').length ?? 0) <= 8, 'expected ≤8 words')
  assert.ok((result?.length ?? 0) <= 70, 'expected ≤70 chars')
})

test('isLazyPrefixOfBrief flags a model echoing the opening words of the brief', () => {
  assert.equal(
    isLazyPrefixOfBrief(
      'Write a one-page overview',
      'Write a one-page overview of New York for a general professional audience.',
    ),
    true,
  )
})

test('isLazyPrefixOfBrief allows a real summary that names the subject', () => {
  assert.equal(
    isLazyPrefixOfBrief(
      'New York City Profile',
      'Write a one-page overview of New York for a general professional audience.',
    ),
    false,
  )
})

test('isLazyPrefixOfBrief is case- and punctuation-insensitive', () => {
  assert.equal(
    isLazyPrefixOfBrief(
      'WRITE A CONCISE ONE-PAGER!',
      'Write a concise one-pager on London for a general professional audience.',
    ),
    true,
  )
})

test('deriveTitleFromBrief extracts the subject instead of the request prefix', () => {
  assert.equal(
    deriveTitleFromBrief('Write a one-page report on Ohio for a general professional audience.'),
    'Ohio Overview',
  )
  assert.equal(
    deriveTitleFromBrief('Write a concise one-pager on London for a general professional audience.'),
    'London Overview',
  )
  assert.equal(
    deriveTitleFromBrief('Write a concise investor memo about Agridynamics Robotics for a general professional audience.'),
    'Agridynamics Robotics Memo',
  )
})

test('summarizeJobTitle falls back when the model echoes a generic request prefix', async () => {
  registerProvider({
    name: 'title-test-echo',
    execute: async (_options: ProviderExecuteOptions): Promise<ProviderResult> => ({
      text: 'Write a one-page report',
      cost: 0,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      model: 'test',
    }),
  })

  const title = await summarizeJobTitle({
    brief: 'Write a one-page report on Ohio for a general professional audience.',
    config: { provider: 'title-test-echo', model: 'test', thinking: 'low' },
  })

  assert.equal(title, 'Ohio Overview')
})

test('summarizeJobTitle forwards compact provider config for the direct title call', async () => {
  let seenProviderConfig: Record<string, unknown> | undefined
  registerProvider({
    name: 'title-test-config',
    execute: async (options: ProviderExecuteOptions): Promise<ProviderResult> => {
      seenProviderConfig = options.providerConfig
      return {
        text: 'Ohio Overview',
        cost: 0,
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: 'test',
      }
    },
  })

  const title = await summarizeJobTitle({
    brief: 'Write a one-page report on Ohio for a general professional audience.',
    config: {
      provider: 'title-test-config',
      model: 'test',
      thinking: 'low',
      providerConfig: { max_output_tokens: 24 },
    },
  })

  assert.equal(title, 'Ohio Overview')
  assert.deepEqual(seenProviderConfig, {
    max_output_tokens: 24,
    reasoning: false,
  })
})
