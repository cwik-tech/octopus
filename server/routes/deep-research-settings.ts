import type * as http from 'node:http'
import type { URL } from 'node:url'

import { deepResearchSettingsPatchRequestSchema } from '../../contracts/schemas/settings-requests.js'
import {
  type DeepResearchSettingsApiError,
  type DeepResearchSettingsApiErrorCode,
  type DeepResearchSettingsSnapshot,
  type DeepResearchSettingsValues,
} from '../../domains/deep-research/deep-research-settings.js'
import { DeepResearchSettingsServiceError } from '../../services/deep-research-settings-service.js'
import {
  ApiRequestError,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from '../http.js'

const DEEP_RESEARCH_SETTINGS_PATH = '/settings/deep-research'
const ALLOWED_METHODS = ['GET', 'PATCH'] as const

export interface DeepResearchSettingsRouteRuntime {
  snapshot(): Promise<DeepResearchSettingsSnapshot>
  update(values: DeepResearchSettingsValues): Promise<DeepResearchSettingsSnapshot>
}

export async function handleDeepResearchSettingsRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: DeepResearchSettingsRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== DEEP_RESEARCH_SETTINGS_PATH) return false

  res.setHeader('cache-control', 'no-store')
  if (!ALLOWED_METHODS.includes(req.method as 'GET' | 'PATCH')) {
    res.setHeader('allow', ALLOWED_METHODS.join(', '))
    writeError(res, 405, {
      error: 'Method not allowed.',
      code: 'method_not_allowed',
      retryable: false,
    })
    return true
  }

  if (!runtime) {
    writeError(res, 503, {
      error: 'Deep Research settings are unavailable.',
      code: 'deep_research_settings_unavailable',
      retryable: false,
    })
    return true
  }

  if (req.method === 'GET') {
    try {
      writeJson(res, 200, await runtime.snapshot())
    } catch {
      writeError(res, 503, {
        error: 'Deep Research settings are unavailable.',
        code: 'deep_research_settings_unavailable',
        retryable: false,
      })
    }
    return true
  }

  let values: DeepResearchSettingsValues
  try {
    values = parseDeepResearchSettingsPatchBody(await readJsonBody(req, 4_096))
  } catch (error) {
    if (!(error instanceof ApiRequestError)) throw error
    writeError(res, 400, {
      error: error.message,
      code: 'invalid_request',
      retryable: false,
    })
    return true
  }

  try {
    writeJson(res, 200, await runtime.update(values))
  } catch (error) {
    writeUpdateError(res, error)
  }
  return true
}

export function parseDeepResearchSettingsPatchBody(
  payload: unknown,
): DeepResearchSettingsValues {
  return parseApiRequest(deepResearchSettingsPatchRequestSchema, payload)
}

function writeUpdateError(
  res: http.ServerResponse,
  error: unknown,
): void {
  if (error instanceof DeepResearchSettingsServiceError) {
    switch (error.code) {
      case 'invalid_request':
        writeError(res, 400, {
          error: error.message,
          code: 'invalid_request',
          retryable: false,
        })
        return
      case 'configuration_invalid':
        writeError(res, 503, {
          error: 'Deep Research settings are unavailable.',
          code: 'deep_research_settings_unavailable',
          retryable: false,
        })
        return
      case 'settings_persistence_failed':
        writeError(res, 500, {
          error: 'Deep Research settings could not be persisted.',
          code: 'settings_persistence_failed',
          retryable: true,
        })
        return
    }
  }

  writeError(res, 500, {
    error: 'Deep Research settings could not be persisted.',
    code: 'settings_persistence_failed',
    retryable: true,
  })
}

function writeError(
  res: http.ServerResponse,
  statusCode: number,
  error: DeepResearchSettingsApiError,
): void {
  writeJson(res, statusCode, error satisfies {
    readonly error: string
    readonly code: DeepResearchSettingsApiErrorCode
    readonly retryable: boolean
  })
}
