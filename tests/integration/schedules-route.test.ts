import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  handleSchedulesRoutes,
  type SchedulesRouteRuntime,
} from '../../server/routes/schedules.js'
import { ScheduleService } from '../../services/schedule-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

interface TestServer {
  readonly url: string
  close(): Promise<void>
}

test('schedules route provides real HTTP CRUD over the durable service', async () => {
  const fixture = createSchedulerFixture('schedules-route-repo-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-route-workspace-'))
  const service = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    tickIntervalMs: 60_000,
    now: () => new Date('2026-07-19T14:00:00.000Z'),
  })
  await service.initialize()
  const server = await startRouteServer(service)
  try {
    const empty = await fetch(`${server.url}/schedules`)
    assert.equal(empty.status, 200)
    assert.equal(empty.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await empty.json(), { schedules: [] })

    const invalidContentType = await fetch(`${server.url}/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(invalidContentType.status, 415)
    assert.deepEqual(await invalidContentType.json(), {
      error: 'Content-Type must be application/json',
      code: 'invalid_request',
      retryable: false,
    })

    const invalidObject = await jsonRequest(`${server.url}/schedules`, 'POST', null)
    assert.equal(invalidObject.status, 400)
    assert.deepEqual(await invalidObject.json(), {
      error: 'Schedule must be a JSON object.',
      code: 'invalid_request',
      retryable: false,
    })

    const createdResponse = await jsonRequest(`${server.url}/schedules`, 'POST', {
      name: 'HTTP schedule',
      kind: 'workflow',
      target: fixture.workflowId,
      prompt: 'Produce a concise HTTP route integration report.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
    })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json() as {
      id: string
      enabled: boolean
      runtime: { nextFireAt?: string }
    }
    assert.match(created.id, /^sch_/)
    assert.equal(created.enabled, true)
    assert.equal(created.runtime.nextFireAt, '2026-07-20T13:00:00.000Z')

    const unknownField = await jsonRequest(`${server.url}/schedules`, 'POST', {
      name: 'Unknown field schedule',
      kind: 'workflow',
      target: fixture.workflowId,
      prompt: 'Produce a report.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      ignored: true,
    })
    assert.equal(unknownField.status, 400)
    assert.deepEqual(await unknownField.json(), {
      error: 'Schedule contains unknown fields: ignored.',
      code: 'invalid_request',
      retryable: false,
    })

    // A schedule of either kind may no longer name a model. Refused, not
    // accepted and ignored: success here would claim a control that is gone.
    const invalidModel = await jsonRequest(`${server.url}/schedules`, 'POST', {
      name: 'Retired model override',
      kind: 'workflow',
      target: fixture.workflowId,
      modelOverride: { provider: 'openai', model: 'gpt-5-mini' },
      prompt: 'Produce a concise HTTP route integration report.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
    })
    assert.equal(invalidModel.status, 400)
    assert.match(
      (await invalidModel.json() as { error: string }).error,
      /'modelOverride' is no longer supported/,
    )

    const paused = await jsonRequest(
      `${server.url}/schedules/${encodeURIComponent(created.id)}`,
      'PATCH',
      { enabled: false },
    )
    assert.equal(paused.status, 200)
    assert.equal((await paused.json() as { enabled: boolean }).enabled, false)

    const emptyPatch = await jsonRequest(
      `${server.url}/schedules/${encodeURIComponent(created.id)}`,
      'PATCH',
      {},
    )
    assert.equal(emptyPatch.status, 400)
    assert.deepEqual(await emptyPatch.json(), {
      error: 'Schedule patch must contain at least one field.',
      code: 'invalid_request',
      retryable: false,
    })

    const runNow = await fetch(
      `${server.url}/schedules/${encodeURIComponent(created.id)}/run-now`,
      { method: 'POST' },
    )
    assert.equal(runNow.status, 503)
    assert.equal((await runNow.json() as { code: string }).code, 'schedule_unavailable')

    const malformedId = await rawRequest(server.url, '/schedules/%E0%A4%A')
    assert.equal(malformedId.statusCode, 400)

    const method = await fetch(
      `${server.url}/schedules/${encodeURIComponent(created.id)}`,
      { method: 'POST' },
    )
    assert.equal(method.status, 405)
    assert.equal(method.headers.get('allow'), 'PATCH, DELETE')

    const deleted = await fetch(
      `${server.url}/schedules/${encodeURIComponent(created.id)}`,
      { method: 'DELETE' },
    )
    assert.equal(deleted.status, 204)
    assert.deepEqual(
      await fetch(`${server.url}/schedules`).then((response) => response.json()),
      { schedules: [] },
    )
  } finally {
    await server.close()
    await service.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('schedules route distinguishes an unavailable runtime', async () => {
  const server = await startRouteServer()
  try {
    const response = await fetch(`${server.url}/schedules`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'Schedules are unavailable.',
      code: 'schedule_unavailable',
      retryable: false,
    })
  } finally {
    await server.close()
  }
})

test('schedules route rejects human-in-the-loop workflows as non-retryable input', async () => {
  const fixture = createSchedulerFixture('schedules-route-hitl-repo-')
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-route-hitl-workspace-'))
  fs.writeFileSync(
    path.join(
      fixture.repoRootPath,
      'workflows',
      'user-generated',
      `${fixture.workflowId}.yaml`,
    ),
    [
      'workflow:',
      `  id: ${fixture.workflowId}`,
      '  steps:',
      '    - id: draft',
      '      type: agent',
      '      team: test-team',
      '      agent: test-agent',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: round-one.md',
      '    - id: human-feedback',
      '      type: human-in-the-loop',
      '      input_artifact: review/round-one.md',
      '      result_artifact: feedback/round-one.json',
      '  output:',
      '    from_step: draft',
      '    artifact: round-one.md',
      '',
    ].join('\n'),
  )
  const service = new ScheduleService({
    storagePath: path.join(workspacePath, 'task-queue', 'schedules.json'),
    sessionStore: new FileSystemSessionStore(workspacePath),
    repoRootPath: fixture.repoRootPath,
    workspacePath,
    workflowsRegistryPath: fixture.workflowsRegistryPath,
    tickIntervalMs: 60_000,
  })
  await service.initialize()
  const server = await startRouteServer(service)
  try {
    const response = await jsonRequest(`${server.url}/schedules`, 'POST', {
      name: 'HITL schedule',
      kind: 'workflow',
      target: fixture.workflowId,
      prompt: 'Run the workflow later.',
      cron: '0 9 * * *',
      timezone: 'America/Detroit',
      scheduleLabel: 'Every day at 09:00',
      overlap: 'skip',
      notifyOnFailure: false,
      enabled: true,
    })

    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), {
      error: `Workflow '${fixture.workflowId}' contains a human-in-the-loop step and cannot be scheduled.`,
      code: 'workflow_requires_input',
      retryable: false,
    })
  } finally {
    await server.close()
    await service.close()
    fixture.cleanup()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

async function startRouteServer(runtime?: SchedulesRouteRuntime): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    void handleSchedulesRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://127.0.0.1'),
      ...whenDefined(runtime, (definedRuntime) => ({ runtime: definedRuntime })),
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    }).catch((error: unknown) => {
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : String(error))
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

function jsonRequest(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function rawRequest(
  baseUrl: string,
  requestPath: string,
): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const base = new URL(baseUrl)
    const request = http.request({
      host: base.hostname,
      port: base.port,
      path: requestPath,
      method: 'GET',
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        ...whenDefined(response.statusCode, (statusCode) => ({ statusCode })),
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}
import { whenDefined } from '../../core/optional-properties.js'
