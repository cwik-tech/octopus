import assert from 'node:assert/strict'
import * as http from 'node:http'
import test, { type TestContext } from 'node:test'

import { handleBrowserToolRoute } from '../../server/routes/browser-tool.js'
import { handleGenerateExcelToolRoute } from '../../server/routes/generate-excel-tool.js'
import { handleGenerateWordToolRoute } from '../../server/routes/generate-word-tool.js'
import { handleYoutubeToolRoute } from '../../server/routes/youtube-tool.js'
import {
  BROWSER_TOOL_CONTRACT_VERSION,
  type BrowserToolOutput,
} from '../../domains/browser/browser-types.js'
import {
  GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
  type GenerateExcelToolOutput,
} from '../../domains/excel-generation/generate-excel-types.js'
import {
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
  type GenerateWordToolOutput,
} from '../../domains/word-generation/generate-word-types.js'
import {
  YOUTUBE_TOOL_CONTRACT_VERSION,
  type YoutubeToolOutput,
} from '../../domains/youtube/youtube-types.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import type {
  RuntimeCapabilityAuthorityPort,
  RuntimeCapabilityAuthorityResolution,
  RuntimeCapabilityAuthorityVerification,
} from '../../contracts/runtime-capability-authority.js'
import { RuntimeCapabilityAuthorityError } from '../../services/runtime-capability-authority.js'

/**
 * Characterization of the transport the four broker tool routes share today:
 * method and origin refusal, body limits and parsing, authority outcomes, and
 * the success envelope. Every expected message and limit below is the literal
 * the route's source carries, so a route that drifts from the others fails
 * here instead of being papered over by a shared template.
 */

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>

/** What the stub invoker saw of one dispatch. */
interface RecordedDispatch {
  readonly toolCallId: string
  readonly initialAuthorityEvidence?: unknown
  readonly authority: unknown
  readonly source: unknown
  readonly signal?: AbortSignal | undefined
}

interface RouteFixture {
  readonly authority: RuntimeCapabilityAuthorityPort
  readonly dispatched: RecordedDispatch[]
  readonly reportFailure: (diagnostic: unknown) => void
  /** Awaited inside the invoker before it returns; resolves at once unless a test holds it. */
  readonly hold: () => Promise<void>
}

interface RouteUnderTest {
  /** Used in test titles only. No expected message is built from it. */
  readonly name: string
  readonly diagnosticTool: string
  readonly version: number
  readonly maxRequestBytes: number
  readonly invalidMessage: string
  readonly deniedMessage: string
  readonly failedMessage: string
  readonly input: Record<string, unknown>
  /** The authority and source the route hands the invoker, as literals. */
  readonly dispatchIdentity: { readonly authority: unknown; readonly source: unknown }
  /** What the stub invoker returns on success. */
  readonly output: unknown
  readonly start: (fixture: RouteFixture) => RouteHandler
}

const BROWSER_OUTPUT: BrowserToolOutput = {
  ok: true,
  action: 'observe',
  pageId: 'page-characterization',
  url: 'https://example.test/',
  title: 'Characterization page',
}

const GENERATE_EXCEL_OUTPUT: GenerateExcelToolOutput = {
  ok: true,
  action: 'list_profiles',
  profiles: [
    { id: 'excel-profile-1', displayName: 'Plain workbook', description: 'One sheet' },
  ],
}

const GENERATE_WORD_OUTPUT: GenerateWordToolOutput = {
  ok: true,
  action: 'list_profiles',
  profiles: [
    { id: 'word-profile-1', displayName: 'Plain document', description: 'No cover page' },
  ],
}

const YOUTUBE_OUTPUT: YoutubeToolOutput = {
  ok: true,
  action: 'inspect',
  itemCount: 1,
}

const ROUTES: readonly RouteUnderTest[] = [
  {
    name: 'Browser',
    dispatchIdentity: {
      authority: { kind: 'parent-capability', endpointId: 'browser.interact', processIdentity: 'process-1' },
      source: { kind: 'builtin', id: 'builtin.browser', version: String(BROWSER_TOOL_CONTRACT_VERSION) },
    },
    diagnosticTool: 'browser',
    version: BROWSER_TOOL_CONTRACT_VERSION,
    maxRequestBytes: 256 * 1_024,
    invalidMessage: 'Browser tool request is invalid',
    deniedMessage: 'Browser capability authority was denied',
    failedMessage: 'Browser tool failed',
    input: { action: 'observe' },
    output: BROWSER_OUTPUT,
    start: ({ authority, dispatched, reportFailure, hold }) => (req, res) =>
      handleBrowserToolRoute({
        req,
        res,
        authority,
        reportFailure,
        invoker: {
          execute: async (dispatch) => {
            dispatched.push(dispatch)
            await hold()
            return BROWSER_OUTPUT
          },
          releaseAssignment: async () => undefined,
        },
      }),
  },
  {
    name: 'Generate Excel',
    dispatchIdentity: {
      authority: { kind: 'parent-capability', endpointId: 'excel.generate', processIdentity: 'process-1' },
      source: { kind: 'builtin', id: 'builtin.generate-excel', version: String(GENERATE_EXCEL_TOOL_CONTRACT_VERSION) },
    },
    diagnosticTool: 'generate-excel',
    version: GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
    maxRequestBytes: 64 * 1_024,
    invalidMessage: 'Generate Excel tool request is invalid',
    deniedMessage: 'Generate Excel capability authority was denied',
    failedMessage: 'Generate Excel tool failed',
    input: { action: 'list_profiles' },
    output: GENERATE_EXCEL_OUTPUT,
    start: ({ authority, dispatched, reportFailure, hold }) => (req, res) =>
      handleGenerateExcelToolRoute({
        req,
        res,
        authority,
        reportFailure,
        invoker: {
          execute: async (dispatch) => {
            dispatched.push(dispatch)
            await hold()
            return GENERATE_EXCEL_OUTPUT
          },
        },
      }),
  },
  {
    name: 'Generate Word',
    dispatchIdentity: {
      authority: { kind: 'parent-capability', endpointId: 'word.generate', processIdentity: 'process-1' },
      source: { kind: 'builtin', id: 'builtin.generate-word', version: String(GENERATE_WORD_TOOL_CONTRACT_VERSION) },
    },
    diagnosticTool: 'generate-word',
    version: GENERATE_WORD_TOOL_CONTRACT_VERSION,
    maxRequestBytes: 10 * 1_024 * 1_024 + 64 * 1_024,
    invalidMessage: 'Generate Word tool request is invalid',
    deniedMessage: 'Generate Word capability authority was denied',
    failedMessage: 'Generate Word tool failed',
    input: { action: 'list_profiles' },
    output: GENERATE_WORD_OUTPUT,
    start: ({ authority, dispatched, reportFailure, hold }) => (req, res) =>
      handleGenerateWordToolRoute({
        req,
        res,
        authority,
        reportFailure,
        invoker: {
          execute: async (dispatch) => {
            dispatched.push(dispatch)
            await hold()
            return GENERATE_WORD_OUTPUT
          },
        },
      }),
  },
  {
    name: 'YouTube',
    dispatchIdentity: {
      authority: { kind: 'parent-capability', endpointId: 'youtube.extract', processIdentity: 'process-1' },
      source: { kind: 'builtin', id: 'builtin.youtube', version: String(YOUTUBE_TOOL_CONTRACT_VERSION) },
    },
    diagnosticTool: 'youtube',
    version: YOUTUBE_TOOL_CONTRACT_VERSION,
    maxRequestBytes: 512 * 1_024,
    invalidMessage: 'YouTube tool request is invalid',
    deniedMessage: 'YouTube capability authority was denied',
    failedMessage: 'YouTube tool failed',
    input: { action: 'inspect', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    output: YOUTUBE_OUTPUT,
    start: ({ authority, dispatched, reportFailure, hold }) => (req, res) =>
      handleYoutubeToolRoute({
        req,
        res,
        authority,
        reportFailure,
        invoker: {
          execute: async (dispatch) => {
            dispatched.push(dispatch)
            await hold()
            return YOUTUBE_OUTPUT
          },
        },
      }),
  },
]

for (const route of ROUTES) {
  test(`${route.name} tool route answers GET with 405, allow POST, and no-store`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await fetch(harness.url)

    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: 'Method not allowed' })
    assert.deepEqual(harness.authorityCalls, [])
    assert.deepEqual(harness.dispatched, [])
  })

  test(`${route.name} tool route refuses any request carrying an Origin header, loopback included`, async (context) => {
    const harness = await startRoute(context, route)

    for (const origin of [
      'https://attacker.example',
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]) {
      const response = await fetch(harness.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(makeToolRequest(route)),
      })

      assert.equal(response.status, 403, origin)
      assert.equal(response.headers.get('cache-control'), 'no-store', origin)
      assert.deepEqual(await response.json(), { error: 'Origin not allowed' }, origin)
    }
    assert.deepEqual(harness.authorityCalls, [])
    assert.deepEqual(harness.dispatched, [])
  })

  test(`${route.name} tool route accepts a body of exactly ${route.maxRequestBytes} bytes and answers one byte more with 413`, async (context) => {
    const harness = await startRoute(context, route)
    // Valid JSON padded with trailing whitespace, so size is the only
    // difference between the two requests.
    const atLimit = padJsonToBytes(makeToolRequest(route), route.maxRequestBytes)
    const overLimit = padJsonToBytes(makeToolRequest(route), route.maxRequestBytes + 1)

    const accepted = await postBody(harness.url, atLimit)
    const refused = await postBody(harness.url, overLimit)

    assert.equal(accepted.status, 200)
    await accepted.arrayBuffer()
    assert.equal(refused.status, 413)
    assert.equal(refused.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await refused.json(), { error: route.invalidMessage })
    assert.equal(harness.dispatched.length, 1)
  })

  test(`${route.name} tool route answers a text/plain body with 415`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await postBody(
      harness.url,
      JSON.stringify(makeToolRequest(route)),
      'text/plain',
    )

    assert.equal(response.status, 415)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: route.invalidMessage })
    assert.deepEqual(harness.dispatched, [])
  })

  test(`${route.name} tool route answers malformed JSON with 400`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await postBody(harness.url, '{')

    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: route.invalidMessage })
    assert.deepEqual(harness.dispatched, [])
  })

  test(`${route.name} tool route answers an empty body with 400`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await postBody(harness.url, '')

    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: route.invalidMessage })
    assert.deepEqual(harness.authorityCalls, [])
    assert.deepEqual(harness.dispatched, [])
  })

  test(`${route.name} tool route answers an inactive task with 409 and names the denial`, async (context) => {
    const harness = await startRoute(context, route, () => {
      throw new RuntimeCapabilityAuthorityError('inactive_task')
    })

    const response = await postBody(harness.url, JSON.stringify(makeToolRequest(route)))

    assert.equal(response.status, 409)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: route.deniedMessage })
    assert.deepEqual(harness.dispatched, [])
    assert.deepEqual(harness.diagnostics, [])
  })

  test(`${route.name} tool route answers an unauthorized caller with 403 and names the denial`, async (context) => {
    const harness = await startRoute(context, route, () => {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    })

    const response = await postBody(harness.url, JSON.stringify(makeToolRequest(route)))

    assert.equal(response.status, 403)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: route.deniedMessage })
    assert.deepEqual(harness.dispatched, [])
    assert.deepEqual(harness.diagnostics, [])
  })

  test(`${route.name} tool route wraps the invoker output in its contract version envelope`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await postBody(harness.url, JSON.stringify(makeToolRequest(route)))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { version: route.version, output: route.output })
  })

  test(`${route.name} tool route issues authority evidence once and hands that same evidence to the invoker`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await postBody(
      harness.url,
      JSON.stringify(makeToolRequest(route, { toolCallId: 'call-evidence-handoff' })),
    )

    assert.equal(response.status, 200)
    assert.deepEqual(harness.authorityCalls, [{ kind: 'issue-evidence' }])
    assert.equal(harness.dispatched.length, 1)
    assert.equal(harness.dispatched[0]?.toolCallId, 'call-evidence-handoff')
    // Identity, not equality: production resolvers authenticate the evidence
    // by the object itself.
    assert.equal(harness.dispatched[0]?.initialAuthorityEvidence, harness.evidence)
  })

  test(`${route.name} tool route answers a non-authority failure in authorize with 500 and one diagnostic`, async (context) => {
    const harness = await startRoute(context, route, () => {
      throw new Error('resolver crashed reading /Users/someone/private/run')
    })

    const response = await postBody(harness.url, JSON.stringify(makeToolRequest(route)))

    assert.equal(response.status, 500)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { error: route.failedMessage })
    assert.deepEqual(harness.dispatched, [])
    // The digests of 'request-1' and 'call-1' are fixed literals, the same
    // ones tool-route-failure-classification.test.ts pins.
    assert.deepEqual(harness.diagnostics, [
      {
        event: 'tool_route_unexpected_failure',
        tool: route.diagnosticTool,
        requestIdDigest: 'e66b757f1b602c8a',
        toolCallIdDigest: '13b37792a1e6758f',
        errorClass: 'Error',
      },
    ])
  })

  test(`${route.name} tool route dispatches under its own capability's authority and builtin source`, async (context) => {
    const harness = await startRoute(context, route)

    const response = await postBody(harness.url, JSON.stringify(makeToolRequest(route)))

    assert.equal(response.status, 200)
    assert.equal(harness.dispatched.length, 1)
    assert.deepEqual(harness.dispatched[0]?.authority, route.dispatchIdentity.authority)
    assert.deepEqual(harness.dispatched[0]?.source, route.dispatchIdentity.source)
  })

  test(`${route.name} tool route keeps running a tool call after the client disconnects, and writes nothing to the closed response`, { timeout: 5_000 }, async (context) => {
    // Current behavior, not a goal: the route cancels only while the body is
    // still arriving. A disconnect after the body was read leaves the tool
    // call running; making it cancel would be a separate behavior change.
    const held = await startHeldRoute(context, route)
    const client = http.request(held.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    client.on('error', () => undefined)
    client.end(JSON.stringify(makeToolRequest(route)))

    const signal = await held.invokerStarted
    client.destroy()
    await held.responseClosed

    assert.equal(signal?.aborted, false)
    held.release()
    await held.handlerSettled
    assert.equal(held.response().writableEnded, false)
    assert.equal(held.response().headersSent, false)
    assert.deepEqual(held.diagnostics, [])
  })
}

interface HeldRoute {
  readonly url: string
  /** Resolves with the signal the invoker received, once it has started. */
  readonly invokerStarted: Promise<AbortSignal | undefined>
  /** Resolves when the server-side response emits 'close'. */
  readonly responseClosed: Promise<void>
  /** Resolves when the route handler's promise settles. */
  readonly handlerSettled: Promise<void>
  readonly release: () => void
  readonly response: () => http.ServerResponse
  readonly diagnostics: unknown[]
}

/**
 * Starts the route with an invoker that waits for `release`, and exposes the
 * server-side response so a test can see what the route did to it after the
 * client went away. Every wait is on an event, never on time.
 */
async function startHeldRoute(context: TestContext, route: RouteUnderTest): Promise<HeldRoute> {
  const dispatched: RecordedDispatch[] = []
  const diagnostics: unknown[] = []
  const invokerStarted = deferred<AbortSignal | undefined>()
  const released = deferred<void>()
  const responseClosed = deferred<void>()
  const handlerSettled = deferred<void>()
  let captured: http.ServerResponse | undefined
  const handler = route.start({
    authority: {
      authorize: async () => ({
        taskId: 'task-1',
        workflowId: 'characterization-workflow',
        runPath: '/characterization/run',
        assignmentPath: '/characterization/run/assignments/assignment-1',
      }),
    },
    dispatched,
    reportFailure: (diagnostic) => diagnostics.push(diagnostic),
    hold: () => {
      invokerStarted.resolve(dispatched.at(-1)?.signal)
      return released.promise
    },
  })
  const server = http.createServer((req, res) => {
    captured = res
    res.once('close', () => responseClosed.resolve())
    handler(req, res).then(
      () => handlerSettled.resolve(),
      (error: unknown) => handlerSettled.reject(error),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  context.after(() => {
    released.resolve()
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/private-tool`,
    invokerStarted: invokerStarted.promise,
    responseClosed: responseClosed.promise,
    handlerSettled: handlerSettled.promise,
    release: () => released.resolve(),
    response: () => {
      assert.ok(captured, 'the route received no request')
      return captured
    },
    diagnostics,
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface RouteHarness {
  readonly url: string
  readonly evidence: RuntimeCapabilityAuthorityResolution
  /** The second argument of every authorize call, in order. */
  readonly authorityCalls: (RuntimeCapabilityAuthorityVerification | undefined)[]
  readonly dispatched: RecordedDispatch[]
  readonly diagnostics: unknown[]
}

/**
 * Starts the route on a loopback server with a recording stub authority and
 * invoker. `decide` runs inside authorize; by default it grants `evidence`.
 */
async function startRoute(
  context: TestContext,
  route: RouteUnderTest,
  decide?: () => RuntimeCapabilityAuthorityResolution,
): Promise<RouteHarness> {
  const evidence: RuntimeCapabilityAuthorityResolution = {
    taskId: 'task-1',
    workflowId: 'characterization-workflow',
    runPath: '/characterization/run',
    assignmentPath: '/characterization/run/assignments/assignment-1',
  }
  const authorityCalls: (RuntimeCapabilityAuthorityVerification | undefined)[] = []
  const dispatched: RecordedDispatch[] = []
  const diagnostics: unknown[] = []
  const authority: RuntimeCapabilityAuthorityPort = {
    authorize: async (_claims, verification) => {
      authorityCalls.push(verification)
      return decide ? decide() : evidence
    },
  }
  const server = await startServer(route.start({
    authority,
    dispatched,
    reportFailure: (diagnostic) => diagnostics.push(diagnostic),
    hold: async () => undefined,
  }))
  context.after(() => server.close())
  return { url: server.url, evidence, authorityCalls, dispatched, diagnostics }
}

function makeToolRequest(
  route: RouteUnderTest,
  ids: { readonly requestId?: string; readonly toolCallId?: string } = {},
): unknown {
  return {
    version: route.version,
    context: {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: ids.requestId ?? 'request-1',
      leaseId: 'lease-1',
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      processIdentity: 'process-1',
      agentPath: 'agents/documenter',
    },
    toolCallId: ids.toolCallId ?? 'call-1',
    input: route.input,
  }
}

/** The request as JSON followed by spaces, `totalBytes` bytes in all. */
function padJsonToBytes(request: unknown, totalBytes: number): string {
  const json = JSON.stringify(request)
  const jsonBytes = Buffer.byteLength(json, 'utf8')
  assert.ok(jsonBytes <= totalBytes, 'the request must fit before padding')
  const body = json + ' '.repeat(totalBytes - jsonBytes)
  assert.equal(Buffer.byteLength(body, 'utf8'), totalBytes)
  return body
}

function postBody(
  url: string,
  body: string,
  contentType = 'application/json',
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

async function startServer(
  handler: RouteHandler,
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
