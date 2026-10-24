import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { callParentBrowserTool, BrowserToolClientError } from '../../domains/browser/browser-tool-client.js'
import {
  BROWSER_TOOL_CONTRACT_VERSION,
  BROWSER_TOOL_URL_ENV,
} from '../../domains/browser/browser-types.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'

test('browser child client sends bounded scoped requests only to a loopback capability URL', async () => {
  let received: unknown
  let origin: string | string[] | undefined
  const server = http.createServer((request, response) => {
    origin = request.headers.origin
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        version: BROWSER_TOOL_CONTRACT_VERSION,
        output: { ok: true, action: 'observe' },
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const environment = {
    [BROWSER_TOOL_URL_ENV]: `http://127.0.0.1:${address.port}/_private-browser-capability`,
    [RUNTIME_SESSION_ID_ENV]: 'session-client',
    [RUNTIME_RUN_ID_ENV]: 'run-client',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-client',
    [RUNTIME_TASK_ID_ENV]: 'task-client',
    [RUNTIME_PROCESS_IDENTITY_ENV]: 'process-client',
  }

  try {
    const response = await callParentBrowserTool({
      agentPath: 'agents/researcher',
      toolCallId: 'call-client',
      input: { action: 'observe', pageId: 'page-client' },
      environment,
    })
    assert.equal(response.output.ok, true)
    assert.equal(origin, undefined)
    assert.deepEqual(received, {
      version: BROWSER_TOOL_CONTRACT_VERSION,
      context: {
        contractVersion: 1,
        requestId: (received as { context: { requestId: string } }).context.requestId,
        leaseId: 'browser-assignment-client',
        sessionId: 'session-client',
        runId: 'run-client',
        assignmentId: 'assignment-client',
        taskId: 'task-client',
        processIdentity: 'process-client',
        agentPath: 'agents/researcher',
      },
      toolCallId: 'call-client',
      input: { action: 'observe', pageId: 'page-client' },
    })
    assert.match((received as { context: { requestId: string } }).context.requestId, /^[0-9a-f-]{36}$/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('browser child client rejects non-loopback, credentialed, and query-bearing capabilities', async () => {
  const base = {
    [RUNTIME_SESSION_ID_ENV]: 'session-client',
    [RUNTIME_RUN_ID_ENV]: 'run-client',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-client',
    [RUNTIME_TASK_ID_ENV]: 'task-client',
    [RUNTIME_PROCESS_IDENTITY_ENV]: 'process-client',
  }
  for (const value of [
    'https://example.com/private',
    'http://user:secret@127.0.0.1/private',
    'http://127.0.0.1/private?token=visible',
    'http://127.0.0.1/',
  ]) {
    await assert.rejects(
      callParentBrowserTool({
        agentPath: 'agents/researcher',
        toolCallId: 'call-rejected',
        input: { action: 'observe' },
        environment: { ...base, [BROWSER_TOOL_URL_ENV]: value },
      }),
      BrowserToolClientError,
    )
  }
})
