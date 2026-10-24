import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { handleBrowserToolRoute } from '../../server/routes/browser-tool.js'
import { handleGenerateExcelToolRoute } from '../../server/routes/generate-excel-tool.js'
import { handleGenerateWordToolRoute } from '../../server/routes/generate-word-tool.js'
import { handleYoutubeToolRoute } from '../../server/routes/youtube-tool.js'
import { BROWSER_TOOL_CONTRACT_VERSION } from '../../domains/browser/browser-types.js'
import { GENERATE_EXCEL_TOOL_CONTRACT_VERSION } from '../../domains/excel-generation/generate-excel-types.js'
import { GENERATE_WORD_TOOL_CONTRACT_VERSION } from '../../domains/word-generation/generate-word-types.js'
import { YOUTUBE_TOOL_CONTRACT_VERSION } from '../../domains/youtube/youtube-types.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { RuntimeCapabilityAuthorityError } from '../../services/runtime-capability-authority.js'

/**
 * A failure inside the route that is nobody's bad request: the dispatcher, the
 * journal, or a bug. The path and token in it stand for detail that must reach
 * neither the caller nor the log.
 */
const PRIVATE_DETAIL = '/Users/someone/private/run?token=sk-live-123'
const INTERNAL_FAILURE = new Error(`journal append failed at ${PRIVATE_DETAIL}`)

const allowAuthority: RuntimeCapabilityAuthorityPort = {
  authorize: async (claims) => ({
    taskId: claims.taskId,
    workflowId: claims.workflowId ?? 'classification-workflow',
    runPath: '/classification/run',
    assignmentPath: '/classification/run/assignments/assignment-1',
  }),
}

const denyAuthority: RuntimeCapabilityAuthorityPort = {
  authorize: async () => {
    throw new RuntimeCapabilityAuthorityError('unauthorized')
  },
}

interface RouteUnderTest {
  readonly tool: string
  readonly id: string
  readonly version: number
  readonly input: Record<string, unknown>
  readonly start: (
    authority: RuntimeCapabilityAuthorityPort,
    execute: () => Promise<never>,
    reportFailure: (diagnostic: unknown) => void,
  ) => (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
}

const ROUTES: readonly RouteUnderTest[] = [
  {
    tool: 'Browser',
    id: 'browser',
    version: BROWSER_TOOL_CONTRACT_VERSION,
    input: { action: 'observe' },
    start: (authority, execute, reportFailure) => (req, res) =>
      handleBrowserToolRoute({
        req,
        res,
        authority,
        invoker: { execute, releaseAssignment: async () => undefined },
        reportFailure,
      }),
  },
  {
    tool: 'Generate Excel',
    id: 'generate-excel',
    version: GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
    input: { action: 'list_profiles' },
    start: (authority, execute, reportFailure) => (req, res) =>
      handleGenerateExcelToolRoute({ req, res, authority, invoker: { execute }, reportFailure }),
  },
  {
    tool: 'Generate Word',
    id: 'generate-word',
    version: GENERATE_WORD_TOOL_CONTRACT_VERSION,
    input: { action: 'list_profiles' },
    start: (authority, execute, reportFailure) => (req, res) =>
      handleGenerateWordToolRoute({ req, res, authority, invoker: { execute }, reportFailure }),
  },
  {
    tool: 'YouTube',
    id: 'youtube',
    version: YOUTUBE_TOOL_CONTRACT_VERSION,
    input: { action: 'inspect', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    start: (authority, execute, reportFailure) => (req, res) =>
      handleYoutubeToolRoute({ req, res, authority, invoker: { execute }, reportFailure }),
  },
]

for (const route of ROUTES) {
  test(`${route.tool} tool route reports an unexpected failure as a server failure without its detail`, async (context) => {
    const diagnostics: unknown[] = []
    const server = await startServer(
      route.start(
        allowAuthority,
        async () => {
          throw INTERNAL_FAILURE
        },
        (diagnostic) => diagnostics.push(diagnostic),
      ),
    )
    context.after(() => server.close())

    const response = await postJson(server.url, toolRequest(route.version, route.input))

    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: `${route.tool} tool failed` })
    // The operator can find the failing call by digesting the request and tool
    // call ids they hold, and learns what kind of error it was, but never its
    // message. The digests are fixed literals, not recomputed here.
    assert.deepEqual(diagnostics, [
      {
        event: 'tool_route_unexpected_failure',
        tool: route.id,
        requestIdDigest: 'e66b757f1b602c8a',
        toolCallIdDigest: '13b37792a1e6758f',
        errorClass: 'Error',
      },
    ])
  })

  test(`${route.tool} tool route logs nothing from a thrown value that is not an Error`, async (context) => {
    const diagnostics: unknown[] = []
    const server = await startServer(
      route.start(
        allowAuthority,
        async () => {
          // A thrown string is the error message itself, so none of it may be logged.
          throw PRIVATE_DETAIL
        },
        (diagnostic) => diagnostics.push(diagnostic),
      ),
    )
    context.after(() => server.close())

    const response = await postJson(server.url, toolRequest(route.version, route.input))

    assert.equal(response.status, 500)
    assert.equal(JSON.stringify(diagnostics).includes('sk-live-123'), false)
    assert.deepEqual(diagnostics, [
      {
        event: 'tool_route_unexpected_failure',
        tool: route.id,
        requestIdDigest: 'e66b757f1b602c8a',
        toolCallIdDigest: '13b37792a1e6758f',
        errorClass: 'non-error',
      },
    ])
  })

  test(`${route.tool} tool route names an authority denial as a denial`, async (context) => {
    const diagnostics: unknown[] = []
    const server = await startServer(
      route.start(
        denyAuthority,
        async () => {
          throw new Error('the executor must not run without authority')
        },
        (diagnostic) => diagnostics.push(diagnostic),
      ),
    )
    context.after(() => server.close())

    const response = await postJson(server.url, toolRequest(route.version, route.input))

    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: `${route.tool} capability authority was denied`,
    })
    // A refusal is an expected answer, not a failure to diagnose.
    assert.deepEqual(diagnostics, [])
  })
}

test('the default stderr diagnostic never carries the text of a correlation id', async (context) => {
  // Both ids are caller-chosen text. These carry a token and an email address.
  const requestId = 'request-for-person@example.com?token=sk-live-456'
  const toolCallId = 'call-sk-live-789'
  const written: string[] = []
  context.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  const server = await startServer((req, res) =>
    handleGenerateExcelToolRoute({
      req,
      res,
      authority: allowAuthority,
      invoker: {
        execute: async () => {
          throw INTERNAL_FAILURE
        },
      },
    }))
  context.after(() => server.close())

  const response = await postJson(
    server.url,
    toolRequest(GENERATE_EXCEL_TOOL_CONTRACT_VERSION, { action: 'list_profiles' }, {
      requestId,
      toolCallId,
    }),
  )

  assert.equal(response.status, 500)
  const stderr = written.join('')
  for (const secret of ['person@example.com', 'sk-live-456', 'sk-live-789', 'sk-live-123']) {
    assert.equal(stderr.includes(secret), false, `stderr must not contain ${secret}`)
  }
  assert.deepEqual(JSON.parse(stderr), {
    event: 'tool_route_unexpected_failure',
    tool: 'generate-excel',
    requestIdDigest: 'cfea52652027d835',
    toolCallIdDigest: '50c4b519348fb489',
    errorClass: 'Error',
  })
})

function toolRequest(
  version: number,
  input: Record<string, unknown>,
  ids: { readonly requestId: string; readonly toolCallId: string } = {
    requestId: 'request-1',
    toolCallId: 'call-1',
  },
): unknown {
  return {
    version,
    context: {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: ids.requestId,
      leaseId: 'lease-1',
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      processIdentity: 'process-1',
      agentPath: 'agents/documenter',
    },
    toolCallId: ids.toolCallId,
    input,
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      res.statusCode = 599
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
    url: `http://127.0.0.1:${address.port}/private-tool`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
