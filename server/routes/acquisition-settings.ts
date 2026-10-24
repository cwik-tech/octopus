import type * as http from 'node:http'

import {
  ACQUISITION_PROVIDER_IDS,
  type AcquisitionProviderUpdate,
  type AcquisitionSettingsUpdate,
} from '../../domains/acquisition/acquisition-settings.js'
import type { AcquisitionProviderId } from '../../domains/acquisition/acquisition-providers.js'
import type { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { readJsonBody, writeJson } from '../http.js'

const SETTINGS_PATH = '/settings/research-acquisition'
const VALIDATE_PATH = '/settings/research-acquisition/validate'

export async function handleAcquisitionSettingsRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly service?: AcquisitionSettingsService
}): Promise<boolean> {
  const { req, res, url, service } = params
  if (url.pathname !== SETTINGS_PATH && url.pathname !== VALIDATE_PATH) return false
  res.setHeader('cache-control', 'no-store')
  if (!service) {
    writeJson(res, 503, {
      error: 'Research acquisition settings are unavailable.',
      code: 'acquisition_settings_unavailable',
      retryable: true,
    })
    return true
  }
  try {
    if (url.pathname === SETTINGS_PATH && req.method === 'GET') {
      writeJson(res, 200, await service.snapshot())
      return true
    }
    if (url.pathname === SETTINGS_PATH && req.method === 'PATCH') {
      const body = await readJsonBody(req, 64 * 1_024)
      writeJson(res, 200, await service.update(parseUpdate(body)))
      return true
    }
    if (url.pathname === VALIDATE_PATH && req.method === 'POST') {
      const body = await readJsonBody(req, 8 * 1_024)
      writeJson(res, 200, await service.validateProvider(parseProvider(body)))
      return true
    }
    res.setHeader('allow', url.pathname === SETTINGS_PATH ? 'GET, PATCH' : 'POST')
    writeJson(res, 405, {
      error: 'Method not allowed',
      code: 'method_not_allowed',
      retryable: false,
    })
  } catch (error) {
    writeJson(res, 400, {
      error: error instanceof Error ? error.message : 'Research acquisition settings are invalid.',
      code: 'invalid_request',
      retryable: false,
    })
  }
  return true
}

function parseProvider(value: unknown): AcquisitionProviderId {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  const provider = record.provider
  // Narrowed by the guard rather than asserted: this is a request body, and
  // asserting the type it is supposed to have is exactly the check that does
  // not happen at a boundary.
  if (Object.keys(record).length !== 1 || !isAcquisitionProviderId(provider)) {
    invalid()
  }
  return provider
}

function isAcquisitionProviderId(value: unknown): value is AcquisitionProviderId {
  return (
    typeof value === 'string' &&
    ACQUISITION_PROVIDER_IDS.some((candidate) => candidate === value)
  )
}

function parseUpdate(value: unknown): AcquisitionSettingsUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (
    !hasExactKeys(record, [
      'providerPriority',
      'providers',
      'budgets',
      'extractionModel',
    ]) ||
    !Array.isArray(record.providerPriority) ||
    !record.providers ||
    typeof record.providers !== 'object' ||
    Array.isArray(record.providers) ||
    !record.budgets ||
    typeof record.budgets !== 'object' ||
    Array.isArray(record.budgets)
  ) invalid()
  const providers = record.providers as Record<string, unknown>
  const budgets = record.budgets as Record<string, unknown>
  if (
    !hasExactKeys(providers, [...ACQUISITION_PROVIDER_IDS]) ||
    !hasExactKeys(budgets, [
      'maximumSearchCalls',
      'maximumBrowserFallbacks',
      'maximumManagedReaderCalls',
      'maximumModelExtractions',
      'maximumCloudBrowserCalls',
      'maximumCloudBrowserCostMicros',
    ])
  ) {
    invalid()
  }
  return {
    providerPriority: record.providerPriority as ('exa' | 'brave')[],
    providers: {
      exa: parseProviderUpdate(providers.exa),
      brave: parseProviderUpdate(providers.brave),
      firecrawl: parseProviderUpdate(providers.firecrawl),
      'browser-use': parseProviderUpdate(providers['browser-use']),
    },
    budgets: record.budgets as AcquisitionSettingsUpdate['budgets'],
    extractionModel: parseModelSelection(record.extractionModel),
  }
}

function parseModelSelection(
  value: unknown,
): AcquisitionSettingsUpdate['extractionModel'] {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (
    !hasExactKeys(record, ['provider', 'model']) ||
    typeof record.provider !== 'string' ||
    typeof record.model !== 'string'
  ) {
    invalid()
  }
  return { provider: record.provider, model: record.model }
}

function parseProviderUpdate(value: unknown): AcquisitionProviderUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (
    !hasExactKeys(record, ['enabled', 'apiKey'], true) ||
    typeof record.enabled !== 'boolean' ||
    (record.apiKey !== undefined && typeof record.apiKey !== 'string')
  ) invalid()
  return {
    enabled: record.enabled,
    ...(record.apiKey !== undefined ? { apiKey: record.apiKey as string } : {}),
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optionalLast = false,
): boolean {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) return false
  const required = optionalLast ? keys.slice(0, -1) : keys
  return required.every((key) => key in value)
}

function invalid(): never {
  throw new Error('Research acquisition settings request is invalid.')
}
