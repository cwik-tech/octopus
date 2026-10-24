import type * as http from 'node:http'
import type { URL } from 'node:url'

import type { SchedulingQueueSnapshot } from '../../domains/scheduling/scheduling-queue.js'
import { writeJson } from '../http.js'

const SCHEDULING_QUEUE_PATH = '/scheduling/queue'

export interface SchedulingQueueRouteRuntime {
  snapshot(): Promise<SchedulingQueueSnapshot>
}

export async function handleSchedulingQueueRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: SchedulingQueueRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== SCHEDULING_QUEUE_PATH) return false

  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    writeJson(res, 405, {
      error: 'Method not allowed.',
      code: 'method_not_allowed',
      retryable: false,
    })
    return true
  }

  if (!runtime) {
    writeJson(res, 503, {
      error: 'Scheduling and Queue are unavailable.',
      code: 'scheduling_unavailable',
      retryable: false,
    })
    return true
  }

  try {
    writeJson(res, 200, await runtime.snapshot())
  } catch {
    writeJson(res, 503, {
      error: 'Scheduling and Queue are unavailable.',
      code: 'scheduling_unavailable',
      retryable: true,
    })
  }
  return true
}
