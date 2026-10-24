import type * as http from 'node:http'
import type { URL } from 'node:url'

import {
  scheduleCreateRequestSchema,
  schedulePatchRequestSchema,
} from '../../contracts/schemas/scheduling-requests.js'
import {
  type ScheduleInput,
  type SchedulePatch,
  type SchedulesApiError,
  type SchedulesApiErrorCode,
  type ScheduleView,
} from '../../domains/scheduling/schedule-types.js'
import { ScheduledAgentTargetError } from '../../services/scheduled-agent-target.js'
import { ScheduleServiceError } from '../../services/schedule-service.js'
import {
  ApiRequestError,
  parseApiRequest,
  readJsonBody,
  writeJson,
} from '../http.js'

const SCHEDULES_PATH = '/schedules'
const RUN_NOW_SUFFIX = '/run-now'
const MAX_BODY_BYTES = 131_072

export interface SchedulesRouteRuntime {
  list(): Promise<ScheduleView[]>
  create(input: ScheduleInput): Promise<ScheduleView>
  update(id: string, patch: SchedulePatch): Promise<ScheduleView>
  delete(id: string): Promise<void>
  runNow(id: string): Promise<{ sessionId: string; taskId: string }>
}

export async function handleSchedulesRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: SchedulesRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== SCHEDULES_PATH && !url.pathname.startsWith(`${SCHEDULES_PATH}/`)) {
    return false
  }

  res.setHeader('cache-control', 'no-store')
  const segments = url.pathname.slice(SCHEDULES_PATH.length).split('/').filter(Boolean)
  let scheduleId: string | undefined
  try {
    const encodedScheduleId = segments[0]
    scheduleId = encodedScheduleId === undefined ? undefined : decodeURIComponent(encodedScheduleId)
  } catch {
    writeError(res, 400, {
      error: 'Schedule id is not valid URL encoding.',
      code: 'invalid_request',
      retryable: false,
    })
    return true
  }
  const isRunNow = segments.length === 2 && segments[1] === 'run-now'
  if (segments.length > 2 || (segments.length === 2 && !isRunNow)) {
    writeError(res, 404, {
      error: 'Not found.',
      code: 'not_found',
      retryable: false,
    })
    return true
  }

  if (!runtime) {
    writeError(res, 503, {
      error: 'Schedules are unavailable.',
      code: 'schedule_unavailable',
      retryable: false,
    })
    return true
  }

  try {
    // No id segment: the collection itself.
    if (scheduleId === undefined) {
      if (req.method === 'GET') {
        writeJson(res, 200, { schedules: await runtime.list() })
        return true
      }
      if (req.method === 'POST') {
        const input = parseScheduleCreateBody(await readJsonBody(req, MAX_BODY_BYTES))
        writeJson(res, 201, await runtime.create(input))
        return true
      }
      return methodNotAllowed(res, 'GET, POST')
    }

    if (isRunNow) {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      writeJson(res, 202, await runtime.runNow(scheduleId))
      return true
    }

    if (req.method === 'PATCH') {
      const patch = parseSchedulePatchBody(await readJsonBody(req, MAX_BODY_BYTES))
      writeJson(res, 200, await runtime.update(scheduleId, patch))
      return true
    }
    if (req.method === 'DELETE') {
      await runtime.delete(scheduleId)
      res.writeHead(204)
      res.end()
      return true
    }
    return methodNotAllowed(res, 'PATCH, DELETE')
  } catch (error) {
    writeServiceError(res, error)
    return true
  }
}

export function parseScheduleCreateBody(payload: unknown): ScheduleInput {
  return parseApiRequest(scheduleCreateRequestSchema, payload)
}

export function parseSchedulePatchBody(payload: unknown): SchedulePatch {
  return parseApiRequest(schedulePatchRequestSchema, payload)
}

function methodNotAllowed(res: http.ServerResponse, allow: string): boolean {
  res.setHeader('allow', allow)
  writeError(res, 405, {
    error: 'Method not allowed.',
    code: 'method_not_allowed',
    retryable: false,
  })
  return true
}

function writeServiceError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ApiRequestError) {
    writeError(res, error.statusCode, {
      error: error.message,
      code: 'invalid_request',
      retryable: false,
    })
    return
  }
  if (error instanceof ScheduleServiceError) {
    switch (error.code) {
      case 'invalid_request':
        writeError(res, 400, { error: error.message, code: 'invalid_request', retryable: false })
        return
      case 'not_found':
        writeError(res, 404, { error: error.message, code: 'not_found', retryable: false })
        return
      case 'conflict':
        writeError(res, 409, { error: error.message, code: 'conflict', retryable: false })
        return
      case 'workflow_requires_input':
        writeError(res, 422, {
          error: error.message,
          code: 'workflow_requires_input',
          retryable: false,
        })
        return
      case 'schedule_unavailable':
      case 'configuration_invalid':
        writeError(res, 503, { error: error.message, code: 'schedule_unavailable', retryable: true })
        return
      case 'persistence_failed':
        writeError(res, 500, { error: error.message, code: 'persistence_failed', retryable: true })
        return
      case 'fire_failed':
        writeError(res, 500, { error: error.message, code: 'schedule_unavailable', retryable: true })
        return
    }
  }
  if (error instanceof ScheduledAgentTargetError) {
    if (error.code === 'unknown_agent') {
      writeError(res, 400, { error: error.message, code: 'invalid_request', retryable: false })
      return
    }
    writeError(res, 500, { error: error.message, code: 'schedule_unavailable', retryable: true })
    return
  }
  writeError(res, 500, {
    error: 'Schedules request failed.',
    code: 'schedule_unavailable',
    retryable: true,
  })
}

function writeError(
  res: http.ServerResponse,
  statusCode: number,
  error: SchedulesApiError,
): void {
  writeJson(res, statusCode, error)
}
