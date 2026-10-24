import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import {
  handleSchedulingQueueRoutes,
  type SchedulingQueueRouteRuntime,
} from '../../server/routes/scheduling-queue.js'
import type { SchedulingQueueSnapshot } from '../../domains/scheduling/scheduling-queue.js'

interface TestServer {
  readonly url: string
  close(): Promise<void>
}

async function startRouteServer(
  runtime?: SchedulingQueueRouteRuntime,
): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    void handleSchedulingQueueRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      ...whenDefined(runtime, (definedRuntime) => ({ runtime: definedRuntime })),
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

const snapshot: SchedulingQueueSnapshot = {
  version: 1,
  status: 'ready',
  maximumConcurrentTasks: 2,
  slotsInUse: 1,
  availableSlots: 1,
  waitingCount: 1,
  observedAt: '2026-07-14T12:00:00.000Z',
  items: [
    {
      sessionId: 'session-1',
      taskId: 'task-1',
      runId: 'run-1',
      workflowId: 'workflow-1',
      state: 'waiting',
      executionKind: 'initial',
      source: 'apply',
      requestedAt: '2026-07-14T11:59:00.000Z',
    },
  ],
}

test('queue route exposes the no-store live snapshot and rejects writes', async () => {
  const server = await startRouteServer({ snapshot: async () => snapshot })
  try {
    const response = await fetch(`${server.url}/scheduling/queue`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), snapshot)

    const methodResponse = await fetch(`${server.url}/scheduling/queue`, {
      method: 'POST',
    })
    assert.equal(methodResponse.status, 405)
    assert.equal(methodResponse.headers.get('allow'), 'GET')
    assert.deepEqual(await methodResponse.json(), {
      error: 'Method not allowed.',
      code: 'method_not_allowed',
      retryable: false,
    })
  } finally {
    await server.close()
  }
})

test('queue route distinguishes absent and temporarily failing runtimes', async () => {
  const unavailableServer = await startRouteServer()
  const failingServer = await startRouteServer({
    snapshot: async () => {
      throw new Error('projection unavailable')
    },
  })
  try {
    const unavailable = await fetch(`${unavailableServer.url}/scheduling/queue`)
    assert.equal(unavailable.status, 503)
    assert.deepEqual(await unavailable.json(), {
      error: 'Scheduling and Queue are unavailable.',
      code: 'scheduling_unavailable',
      retryable: false,
    })

    const failing = await fetch(`${failingServer.url}/scheduling/queue`)
    assert.equal(failing.status, 503)
    assert.deepEqual(await failing.json(), {
      error: 'Scheduling and Queue are unavailable.',
      code: 'scheduling_unavailable',
      retryable: true,
    })
  } finally {
    await unavailableServer.close()
    await failingServer.close()
  }
})
import { whenDefined } from '../../core/optional-properties.js'
