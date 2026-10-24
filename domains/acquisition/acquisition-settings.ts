import type { AcquisitionProviderId } from './acquisition-providers.js'
import type { ProviderModelSelection } from '../provider/provider-settings.js'

export const ACQUISITION_SETTINGS_SCHEMA_VERSION = 3 as const

/**
 * Every acquisition provider, in one place.
 *
 * The id was enumerated by hand in a dozen places, and a provider missing from
 * one of them is a provider that silently cannot be configured, validated, or
 * loaded. Everything that needs the full set reads it from here.
 */
export const ACQUISITION_PROVIDER_IDS: readonly AcquisitionProviderId[] =
  Object.freeze(['exa', 'brave', 'firecrawl', 'browser-use'])

export interface AcquisitionBudgets {
  readonly maximumSearchCalls: number
  readonly maximumBrowserFallbacks: number
  readonly maximumManagedReaderCalls: number
  readonly maximumModelExtractions: number
  /**
   * Cloud browser calls allowed per assignment.
   *
   * Zero means unlimited calls. The provider enable switch controls whether
   * the paid rung is available.
   */
  readonly maximumCloudBrowserCalls: number
  /**
   * A **post-spend stop threshold**, not a hard cap.
   *
   * Provider cost is only known after a call returns, so this blocks the *next*
   * create rather than predicting the current one. The documented worst case is
   * therefore one call of overshoot. Zero means no spend threshold.
   */
  readonly maximumCloudBrowserCostMicros: number
}

export interface AcquisitionProviderSettingsView {
  readonly enabled: boolean
  readonly hasApiKey: boolean
  readonly keyHint?: string
  readonly status: 'unknown' | 'connected' | 'error'
  readonly error?: string
  readonly lastCheckedAt?: string
}

export interface AcquisitionSettingsSnapshot {
  readonly schemaVersion: typeof ACQUISITION_SETTINGS_SCHEMA_VERSION
  readonly providerPriority: readonly Extract<AcquisitionProviderId, 'exa' | 'brave'>[]
  readonly providers: Readonly<Record<AcquisitionProviderId, AcquisitionProviderSettingsView>>
  readonly budgets: AcquisitionBudgets
  readonly extractionModel: ProviderModelSelection | null
  readonly source: 'default' | 'persisted'
  readonly editable: boolean
}

export interface AcquisitionProviderUpdate {
  readonly enabled: boolean
  readonly apiKey?: string
}

export interface AcquisitionSettingsUpdate {
  readonly providerPriority: readonly Extract<AcquisitionProviderId, 'exa' | 'brave'>[]
  readonly providers: Readonly<Record<AcquisitionProviderId, AcquisitionProviderUpdate>>
  readonly budgets: AcquisitionBudgets
  readonly extractionModel: ProviderModelSelection | null
}

export const DEFAULT_ACQUISITION_BUDGETS: AcquisitionBudgets = {
  maximumSearchCalls: 20,
  maximumBrowserFallbacks: 10,
  maximumManagedReaderCalls: 5,
  maximumModelExtractions: 20,
  maximumCloudBrowserCalls: 0,
  maximumCloudBrowserCostMicros: 0,
}

export function validateAcquisitionSettingsUpdate(
  value: AcquisitionSettingsUpdate,
): void {
  if (
    value.providerPriority.length !== 2 ||
    new Set(value.providerPriority).size !== 2 ||
    !value.providerPriority.includes('exa') ||
    !value.providerPriority.includes('brave')
  ) {
    throw new Error('Acquisition search priority must contain Exa and Brave exactly once.')
  }
  for (const provider of ACQUISITION_PROVIDER_IDS) {
    const apiKey = value.providers[provider]?.apiKey
    if (
      typeof value.providers[provider]?.enabled !== 'boolean' ||
      (
        apiKey !== undefined &&
        (
          typeof apiKey !== 'string' ||
          apiKey.length > 10_000
        )
      )
    ) {
      throw new Error(`Acquisition provider '${provider}' settings are invalid.`)
    }
  }
  validateBudget(
    value.budgets.maximumSearchCalls,
    1,
    100,
    'maximumSearchCalls',
  )
  validateBudget(
    value.budgets.maximumBrowserFallbacks,
    0,
    50,
    'maximumBrowserFallbacks',
  )
  validateBudget(
    value.budgets.maximumManagedReaderCalls,
    0,
    50,
    'maximumManagedReaderCalls',
  )
  validateBudget(
    value.budgets.maximumModelExtractions,
    0,
    100,
    'maximumModelExtractions',
  )
  validateBudget(
    value.budgets.maximumCloudBrowserCalls,
    0,
    20,
    'maximumCloudBrowserCalls',
  )
  validateBudget(
    value.budgets.maximumCloudBrowserCostMicros,
    0,
    100_000_000,
    'maximumCloudBrowserCostMicros',
  )
  if (
    value.extractionModel !== null &&
    (
      !value.extractionModel ||
      typeof value.extractionModel.provider !== 'string' ||
      !value.extractionModel.provider.trim() ||
      value.extractionModel.provider.length > 160 ||
      typeof value.extractionModel.model !== 'string' ||
      !value.extractionModel.model.trim() ||
      value.extractionModel.model.length > 300
    )
  ) {
    throw new Error('Extraction model selection is invalid.')
  }
}

function validateBudget(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`)
  }
}
