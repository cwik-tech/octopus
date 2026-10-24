/**
 * Provider-domain base_url validation.
 *
 * Team/agent configs can override a provider's base_url, and requests to that
 * URL carry API credentials. Config-file overrides are limited to each
 * provider's official API host or a loopback development server. An explicit
 * operator-owned environment override can opt into another HTTPS host.
 */

import { ProviderError } from './provider-error.js'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const OFFICIAL_PROVIDER_HOSTNAMES: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['api.anthropic.com'],
  deepseek: ['api.deepseek.com'],
  kimi: ['api.moonshot.ai'],
  openai: ['api.openai.com'],
  openrouter: ['openrouter.ai'],
  xai: ['api.x.ai'],
}

/**
 * Return base_url unchanged when it is safe to send credentials to it, or
 * throw a non-retryable configuration error naming the provider and the URL.
 */
export function assertProviderBaseUrl(
  value: string,
  options: { providerName: string; allowUnlistedHttpsHost?: boolean },
): string {
  const { providerName, allowUnlistedHttpsHost = false } = options
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidBaseUrl(providerName, value, 'is not a valid URL')
  }
  if (url.username || url.password) {
    throw invalidBaseUrl(
      providerName,
      value,
      'must not embed credentials (user:password@host)',
    )
  }
  const hostname = url.hostname.toLowerCase()
  if (
    LOOPBACK_HOSTNAMES.has(hostname) &&
    (url.protocol === 'http:' || url.protocol === 'https:')
  ) {
    return value
  }
  if (url.protocol === 'https:' && allowUnlistedHttpsHost) return value
  if (
    url.protocol === 'https:' &&
    OFFICIAL_PROVIDER_HOSTNAMES[providerName]?.includes(hostname)
  ) {
    return value
  }
  throw invalidBaseUrl(
    providerName,
    value,
    `must use an official ${providerName} API host (loopback hosts are also allowed for local development)`,
  )
}

function invalidBaseUrl(
  providerName: string,
  value: string,
  reason: string,
): ProviderError {
  return new ProviderError({
    provider: providerName,
    kind: 'configuration',
    message: `Provider '${providerName}' base_url ${JSON.stringify(value)} ${reason}.`,
    retryable: false,
  })
}
