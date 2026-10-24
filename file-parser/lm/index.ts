import { createOpenAiLmEnricherFromEnv } from './openai.js'
import { getLlmRuntimeConfigFromEnv } from './llm-model.js'
import type { LmEnricher } from './types.js'

export function createLmEnricherFromEnv(): LmEnricher | null {
  const config = getLlmRuntimeConfigFromEnv()
  if (!config.enabled) return null

  const provider = config.provider
  if (provider === 'openai') {
    return createOpenAiLmEnricherFromEnv()
  }

  return null
}
