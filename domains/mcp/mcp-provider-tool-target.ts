import { whenDefined } from '../../core/optional-properties.js'
import {
  CONFIGURED_PROVIDER_PREFIX,
  type ProviderConnectionKind,
} from '../provider/provider-settings.js'

/** Parent-process-only target. Never serialize this value into an API response. */
export interface ProviderToolLoopTarget {
  readonly apiUrl: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  /**
   * The saved connection's kind, for a configured connection only.
   *
   * The endpoint's URL cannot say what serves it, and one kind (Ollama)
   * accepts a request shape the others honour but ignores part of it.
   */
  readonly connectionKind?: ProviderConnectionKind
}

export interface ConfiguredProviderToolLoopTargetResolver {
  resolveConfiguredToolLoopTarget(
    provider: string,
    model: string,
  ): Promise<ProviderToolLoopTarget>
}

export interface ResolveProviderToolLoopTargetInput {
  readonly provider: string
  readonly model: string
  readonly providerConfig?: Readonly<Record<string, unknown>>
}

export async function resolveProviderToolLoopTarget(
  input: ResolveProviderToolLoopTargetInput,
  providerSettingsService: ConfiguredProviderToolLoopTargetResolver,
): Promise<ProviderToolLoopTarget> {
  const provider = input.provider.trim()
  if (provider.startsWith(CONFIGURED_PROVIDER_PREFIX)) {
    return providerSettingsService.resolveConfiguredToolLoopTarget(
      provider,
      input.model,
    )
  }

  const baseUrl = stringConfig(input.providerConfig?.base_url)
  switch (provider) {
    case 'openai':
      return target({
        apiUrl: chatCompletionsUrl(
          baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        ),
        ...whenDefined(process.env.OPENAI_API_KEY, (definedValue) => ({ apiKey: definedValue })),
        requiresApiKey: true,
      })
    case 'openrouter':
      return target({
        apiUrl: chatCompletionsUrl(
          baseUrl || 'https://openrouter.ai/api/v1',
        ),
        ...whenDefined(process.env.OPENROUTER_API_KEY, (definedValue) => ({ apiKey: definedValue })),
        requiresApiKey: true,
        headers: openRouterHeaders(input.providerConfig),
      })
    case 'deepseek':
      return target({
        apiUrl: chatCompletionsUrl(
          baseUrl || 'https://api.deepseek.com',
        ),
        ...whenDefined(process.env.DEEPSEEK_API_KEY, (definedValue) => ({ apiKey: definedValue })),
        requiresApiKey: true,
      })
    case 'kimi':
      return target({
        apiUrl: chatCompletionsUrl(
          baseUrl || 'https://api.moonshot.ai/v1',
        ),
        ...whenDefined(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY, (definedValue) => ({ apiKey: definedValue })),
        requiresApiKey: true,
      })
    case 'xai':
      return target({
        apiUrl: chatCompletionsUrl(
          baseUrl || 'https://api.x.ai/v1',
        ),
        ...whenDefined(process.env.XAI_API_KEY, (definedValue) => ({ apiKey: definedValue })),
        requiresApiKey: true,
      })
    case 'lm-studio':
      return target({
        apiUrl: chatCompletionsUrl(baseUrl || 'http://127.0.0.1:1234'),
      })
    default:
      throw new Error('Provider does not support the parent MCP tool loop.')
  }
}

function target(input: {
  apiUrl: string
  apiKey?: string
  requiresApiKey?: boolean
  headers?: Readonly<Record<string, string>>
}): ProviderToolLoopTarget {
  const apiKey = input.apiKey?.trim()
  if (input.requiresApiKey && !apiKey) {
    throw new Error('Provider credentials are unavailable for MCP tools.')
  }
  return {
    apiUrl: input.apiUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(input.headers && Object.keys(input.headers).length > 0
      ? { headers: input.headers }
      : {}),
  }
}

function chatCompletionsUrl(value: string): string {
  const base = value.trim().replace(/\/+$/, '')
  if (/\/responses$/i.test(base)) {
    return base.replace(/\/responses$/i, '/chat/completions')
  }
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function openRouterHeaders(
  providerConfig: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
  const siteUrl =
    stringConfig(providerConfig?.site_url) ||
    stringConfig(providerConfig?.http_referer) ||
    process.env.OPENROUTER_SITE_URL?.trim()
  const siteTitle =
    stringConfig(providerConfig?.site_name) ||
    stringConfig(providerConfig?.title) ||
    process.env.OPENROUTER_SITE_NAME?.trim()
  return {
    ...(siteUrl ? { 'HTTP-Referer': siteUrl } : {}),
    ...(siteTitle ? { 'X-OpenRouter-Title': siteTitle } : {}),
  }
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
