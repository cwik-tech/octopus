import type * as http from 'node:http'
import type { URL } from 'node:url'

import { schedulingSettingsPatchRequestSchema } from '../../contracts/schemas/settings-requests.js'
import {
  MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE,
  type SchedulingSettingsApiError,
  type SchedulingSettingsApiErrorCode,
  type SchedulingSettingsSnapshot,
} from '../../domains/scheduling/scheduling-settings.js'
import { SchedulingSettingsServiceError } from '../../services/scheduling-settings-service.js'
import {
  ApiRequestError,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from '../http.js'

const SCHEDULING_SETTINGS_PATH = '/settings/scheduling'
const ALLOWED_METHODS = ['GET', 'PATCH'] as const

export interface SchedulingSettingsRouteRuntime {
  snapshot(): Promise<SchedulingSettingsSnapshot>
  updateMaximumConcurrentTasks(
    maximumConcurrentTasks: number,
  ): Promise<SchedulingSettingsSnapshot>
  isReady(): boolean
}

export async function handleSchedulingSettingsRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: SchedulingSettingsRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== SCHEDULING_SETTINGS_PATH) return false

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
      error: 'Scheduling and Queue settings are unavailable.',
      code: 'scheduling_unavailable',
      retryable: false,
    })
    return true
  }

  if (req.method === 'GET') {
    try {
      writeJson(res, 200, await runtime.snapshot())
    } catch {
      writeError(res, 503, {
        error: 'Scheduling and Queue settings are unavailable.',
        code: 'scheduling_unavailable',
        retryable: false,
      })
    }
    return true
  }

  if (!runtime.isReady()) {
    res.setHeader('retry-after', '1')
    writeError(res, 503, {
      error: 'Task admission is still recovering.',
      code: 'task_admission_recovering',
      retryable: true,
    })
    return true
  }

  let maximumConcurrentTasks: number
  try {
    maximumConcurrentTasks = parsePatchBody(await readJsonBody(req, 4_096))
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
    writeJson(
      res,
      200,
      await runtime.updateMaximumConcurrentTasks(maximumConcurrentTasks),
    )
  } catch (error) {
    writeUpdateError(res, error)
  }
  return true
}

export function parseSchedulingSettingsPatchBody(payload: unknown): number {
  return parsePatchBody(payload)
}

function parsePatchBody(payload: unknown): number {
  return parseApiRequest(schedulingSettingsPatchRequestSchema, payload)
}

function writeUpdateError(
  res: http.ServerResponse,
  error: unknown,
): void {
  if (error instanceof SchedulingSettingsServiceError) {
    switch (error.code) {
      case 'invalid_request':
        writeError(res, 400, {
          error: error.message,
          code: 'invalid_request',
          retryable: false,
        })
        return
      case 'managed_by_environment':
        writeError(res, 409, {
          error: `Maximum concurrent tasks is managed by ${MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE}.`,
          code: 'managed_by_environment',
          retryable: false,
        })
        return
      case 'settings_persistence_failed':
        writeError(res, 500, {
          error: 'Scheduling settings could not be persisted.',
          code: 'settings_persistence_failed',
          retryable: true,
        })
        return
      case 'configuration_invalid':
        writeError(res, 503, {
          error: 'Scheduling and Queue settings are unavailable.',
          code: 'scheduling_unavailable',
          retryable: false,
        })
        return
    }
  }

  writeError(res, 500, {
    error: 'Scheduling settings could not be persisted.',
    code: 'settings_persistence_failed',
    retryable: true,
  })
}

function writeError(
  res: http.ServerResponse,
  statusCode: number,
  error: SchedulingSettingsApiError,
): void {
  writeJson(res, statusCode, error satisfies {
    readonly error: string
    readonly code: SchedulingSettingsApiErrorCode
    readonly retryable: boolean
  })
}
