export const DEFAULT_LLM_PROVIDER = 'openai'
export const DEFAULT_LLM_MODEL = 'gpt-4.1-mini'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Set to `1` to keep every parse local; enrichment then stays off whatever else is set. */
export const LOCAL_ONLY_ENV = 'FILE_PARSER_LOCAL_ONLY'

export interface LlmRuntimeConfig {
  enabled: boolean
  provider: string
  model: string
  openAiBaseUrl: string
  openAiApiKey?: string
}

export function getLlmRuntimeConfigFromEnv(): LlmRuntimeConfig {
  const enabledRaw = process.env["FILE_PARSER_LLM_ENABLED"] ?? process.env["FILE_PARSER_LM_ENABLED"]
  const providerRaw = process.env["FILE_PARSER_LLM_PROVIDER"] ?? process.env["FILE_PARSER_LM_PROVIDER"]
  const modelRaw = process.env["FILE_PARSER_LLM_MODEL"] ?? process.env["FILE_PARSER_LM_MODEL"]
  const openAiApiKeyRaw = process.env["FILE_PARSER_OPENAI_API_KEY"] ?? process.env["OPENAI_API_KEY"]
  const localOnly = process.env[LOCAL_ONLY_ENV] === '1'
  return {
    // Local-only wins over every other setting: nothing here can switch enrichment back on.
    enabled: enabledRaw === '1' && !localOnly,
    provider: (providerRaw || DEFAULT_LLM_PROVIDER).trim().toLowerCase(),
    model: (modelRaw || DEFAULT_LLM_MODEL).trim(),
    openAiBaseUrl: (process.env["FILE_PARSER_OPENAI_BASE_URL"] || DEFAULT_OPENAI_BASE_URL).trim(),
    ...(openAiApiKeyRaw?.trim() ? { openAiApiKey: openAiApiKeyRaw.trim() } : {}),
  }
}
