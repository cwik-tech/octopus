import * as http from 'node:http'

/**
 * A loopback stand-in for the Browser Use V4 direct-browser API.
 *
 * It exists so the session client's create/stop lifecycle, payload validation,
 * metering and cleanup behaviour are provable without an account, a key, or a
 * billable call. Every request is recorded, including the ones a test expects
 * never to arrive: "abort issued zero requests" is only meaningful when the
 * server can testify that it saw none.
 */

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface BrowserUseApiFixture {
  readonly url: string
  readonly requests: readonly RecordedRequest[]
  /** Requests whose socket carried an aborted client signal. */
  readonly abortedRequests: readonly string[]
  /**
   * Resolves once the server has received the create request.
   *
   * Tests that need to act *while* a request is in flight wait on this rather
   * than on a timer. A timer races the server and makes the test's meaning
   * depend on how busy the machine is; this resolves at the one moment the
   * scenario is actually about.
   */
  readonly createRequestReceived: Promise<void>
  /** Resolves once the server has received a stop request. */
  readonly stopRequestReceived: Promise<void>
  /** Replaces the create handler for the next call. */
  respondToCreate(handler: ScriptedResponse): void
  /** Replaces the stop handler for the next call. */
  respondToStop(handler: ScriptedResponse): void
  close(): Promise<void>
}

export interface ScriptedResponse {
  readonly status?: number
  readonly body?: unknown
  /** Raw body, used to script payloads that are not valid JSON. */
  readonly raw?: string
  /** Holds the response open for this long before answering. */
  readonly delayMs?: number
}

export const SESSION_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

export function activeSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: SESSION_ID,
    status: 'active',
    cdpUrl: null,
    liveUrl: null,
    startedAt: '2026-08-30T10:00:00.000Z',
    timeoutAt: '2026-08-30T10:01:00.000Z',
    finishedAt: null,
    proxyUsedMb: '0',
    proxyCost: '0',
    browserCost: '0',
    agentSessionId: null,
    recordingUrl: null,
    metadata: {},
    ...overrides,
  }
}

export function stoppedSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return activeSession({
    status: 'stopped',
    finishedAt: '2026-08-30T10:00:30.000Z',
    ...overrides,
  })
}

export async function startBrowserUseApiFixture(): Promise<BrowserUseApiFixture> {
  const requests: RecordedRequest[] = []
  const abortedRequests: string[] = []
  let announceCreate = (): void => undefined
  let announceStop = (): void => undefined
  const createRequestReceived = new Promise<void>((resolve) => {
    announceCreate = resolve
  })
  const stopRequestReceived = new Promise<void>((resolve) => {
    announceStop = resolve
  })
  let createResponse: ScriptedResponse = { status: 200 }
  let stopResponse: ScriptedResponse = { status: 200 }

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const path = request.url ?? ''
      const isStop = request.method === 'PATCH'
      requests.push({
        method: request.method ?? '',
        path,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : String(value ?? ''),
          ]),
        ),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (isStop) announceStop()
      else announceCreate()
      const scripted = isStop ? stopResponse : createResponse
      // Tracked from the 'aborted' event rather than read from
      // `request.destroyed`: Node destroys the IncomingMessage once its body
      // has been consumed, so a completed request looks identical to an
      // abandoned one, and a delayed reply would never be sent.
      let aborted = false
      request.on('aborted', () => {
        aborted = true
        abortedRequests.push(path)
      })
      const send = (): void => {
        if (aborted || response.writableEnded) return
        const payload =
          scripted.raw ??
          JSON.stringify(
            scripted.body ?? (isStop ? stoppedSession() : activeSession()),
          )
        response.writeHead(scripted.status ?? 200, {
          'content-type': 'application/json',
        })
        response.end(payload)
      }
      if (scripted.delayMs) setTimeout(send, scripted.delayMs).unref()
      else send()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Browser Use fixture did not bind a port.')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    abortedRequests,
    createRequestReceived,
    stopRequestReceived,
    respondToCreate(handler) {
      createResponse = handler
    },
    respondToStop(handler) {
      stopResponse = handler
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
