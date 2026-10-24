/**
 * Provider Registry
 *
 * Central registry for all provider implementations.
 * Providers self-register at boot via registerProvider().
 * Agent dispatch looks up the desired provider via getProvider().
 */

import type { Provider } from './types.js'
import { createConfiguredProvider } from './configured-provider.js'

export interface ProviderProvenance {
  readonly source: string
  readonly version?: string
  readonly trustClass: string
}

interface ProviderRegistration {
  readonly provider: Provider
  readonly provenance: ProviderProvenance
}

export interface ProviderRegistrationOptions {
  readonly replaceExisting?: boolean
}

const registry = new Map<string, ProviderRegistration>()

/**
 * Register a provider implementation. Provider names are stable identities;
 * accidental replacement would silently change execution behavior.
 */
export function registerProvider(
  provider: Provider,
  provenance: ProviderProvenance = {
    source: `runtime:${provider.name}`,
    trustClass: 'unknown',
  },
  options: ProviderRegistrationOptions = {},
): void {
  const normalizedProvenance = normalizeProvenance(provenance)
  const existing = registry.get(provider.name)
  if (existing && options.replaceExisting !== true) {
    throw new Error(
      `Provider '${provider.name}' is already registered by '${existing.provenance.source}'; ` +
      `incoming source '${normalizedProvenance.source}' was rejected`,
    )
  }
  registry.set(provider.name, Object.freeze({
    provider,
    provenance: normalizedProvenance,
  }))
}

export function getProviderProvenance(
  name: string,
): ProviderProvenance | undefined {
  return registry.get(name)?.provenance
}

/**
 * Look up a registered provider by name.
 * Throws with a list of available provider names if not found.
 */
export function getProvider(name: string): Provider {
  const provider = registry.get(name)?.provider ?? createConfiguredProvider(name)
  if (!provider) {
    const available = Array.from(registry.keys()).join(', ') || '(none registered)'
    throw new Error(
      `Unknown provider '${name}'. Available providers: ${available}`
    )
  }
  return provider
}

function normalizeProvenance(
  provenance: ProviderProvenance,
): ProviderProvenance {
  const source = provenance.source.trim()
  const trustClass = provenance.trustClass.trim()
  const version = provenance.version?.trim()
  if (!source) throw new Error('Provider provenance source is required')
  if (!trustClass) throw new Error('Provider provenance trust class is required')
  if (provenance.version !== undefined && !version) {
    throw new Error('Provider provenance version must not be empty')
  }
  return Object.freeze({
    source,
    trustClass,
    ...(version ? { version } : {}),
  })
}
