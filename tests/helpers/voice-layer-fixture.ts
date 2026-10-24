/**
 * A stand-in for the voice layer: a real MCP server on loopback that serves
 * `set_status` and `notify`, advertises itself in the discovery folder the way
 * Hexa Puffs will, and records every call it receives.
 *
 * Tests wait on `waitFor`, which settles when a matching call has arrived, so
 * nothing here waits on time.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { voiceSayInputSchema, voiceSayResultSchema, type VoiceSayInput, type VoiceSayProgress, type VoiceSayResult } from '../../contracts/voice-control.js'

export interface RecordedVoiceCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
  /** The Authorization header the call arrived with. */
  readonly authorization: string | undefined
}

export interface VoiceLayerFixture {
  readonly calls: readonly RecordedVoiceCall[]
  /** The bearer token written to Octopus's grant. */
  readonly token: string
  /**
   * Settles with the first recorded call, past or future, that matches.
   * Rejects when `signal` aborts, so a test that times out still cleans up.
   */
  waitFor(match: (call: RecordedVoiceCall) => boolean, signal: AbortSignal): Promise<RecordedVoiceCall>
  /** Settles when `count` recorded calls match. Rejects when `signal` aborts. */
  waitForCount(match: (call: RecordedVoiceCall) => boolean, count: number, signal: AbortSignal): Promise<void>
  /** The next `notify` is recorded, then its connection is dropped before any reply. */
  dropNextNotifyReply(): void
  close(): Promise<void>
}

const TOOLS = [
  { name: 'set_status', description: 'Show a state.', inputSchema: { type: 'object' as const } },
  { name: 'notify', description: 'Show and speak a notification.', inputSchema: { type: 'object' as const } },
]

export async function startVoiceLayerFixture(discoveryDir: string, options: {
  onSay?: (input: VoiceSayInput, context: { signal: AbortSignal; progress(value: VoiceSayProgress): Promise<void> }) => Promise<VoiceSayResult>
} = {}): Promise<VoiceLayerFixture> {
  const token = randomBytes(24).toString('base64url')
  const calls: RecordedVoiceCall[] = []
  const waiters: { match: (call: RecordedVoiceCall) => boolean; count: number; resolve: () => void }[] = []
  let dropNext = false
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const record = (call: RecordedVoiceCall): void => {
    calls.push(call)
    for (const waiter of [...waiters]) {
      if (calls.filter(waiter.match).length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }

  const waitForCount = (
    match: (call: RecordedVoiceCall) => boolean,
    count: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (calls.filter(match).length >= count) return Promise.resolve()
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Stopped waiting for a voice call: the test ended.'))
        return
      }
      const waiter = {
        match,
        count,
        resolve: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      const onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index !== -1) waiters.splice(index, 1)
        reject(new Error('Stopped waiting for a voice call: the test ended.'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  const openSession = async (authorization: string | undefined): Promise<StreamableHTTPServerTransport> => {
    const server = new Server({ name: 'voice-layer-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.onSay
      ? [...TOOLS, { name: 'say', description: 'Speak a reply.', inputSchema: { type: 'object' as const } }]
      : TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      record({
        name: request.params.name,
        arguments: { ...(request.params.arguments ?? {}) },
        authorization,
      })
      if (request.params.name === 'say' && options.onSay) {
        const result = voiceSayResultSchema.parse(await options.onSay(voiceSayInputSchema.parse(request.params.arguments), {
          signal: extra.signal,
          progress: async (value) => {
            const progressToken = request.params._meta?.progressToken
            if (progressToken === undefined) throw new Error('Speech must request progress receipts.')
            await extra.sendNotification({ method: 'notifications/progress', params: {
              progressToken, progress: value.heardChars, total: value.totalChars, message: JSON.stringify(value),
            } })
          },
        }))
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } }
      }
      return { content: [{ type: 'text' as const, text: 'Recorded.' }] }
    })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport)
      },
    })
    await server.connect(new ExactOptionalMcpTransport(transport))
    return transport
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString('utf8')
      const body: unknown = text === '' ? undefined : JSON.parse(text)
      const authorization = req.headers.authorization
      if (authorization !== `Bearer ${token}`) {
        res.writeHead(401).end()
        return
      }
      if (dropNext && isNotifyCall(body)) {
        dropNext = false
        record({ name: 'notify', arguments: notifyArguments(body), authorization })
        req.socket.destroy()
        return
      }
      const sessionHeader = req.headers['mcp-session-id']
      const existing = typeof sessionHeader === 'string' ? sessions.get(sessionHeader) : undefined
      const transport = existing ?? await openSession(authorization)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('The voice fixture has no port.')

  fs.mkdirSync(path.join(discoveryDir, 'voice'), { recursive: true })
  fs.writeFileSync(
    path.join(discoveryDir, 'voice', 'octopus.json'),
    JSON.stringify({ contract: 'voice-control/1', appId: 'octopus', headers: { Authorization: `Bearer ${token}` } }),
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(discoveryDir, 'voice.json'),
    JSON.stringify({
      contract: 'voice-control/1',
      appId: 'hexa-puffs',
      name: 'Hexa Puffs',
      role: 'voice',
      pid: process.pid,
      mcp: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp` },
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  )

  return {
    calls,
    token,
    waitFor: async (match, signal) => {
      await waitForCount(match, 1, signal)
      const call = calls.find(match)
      if (!call) throw new Error('A matched call was not recorded.')
      return call
    },
    waitForCount,
    dropNextNotifyReply: () => {
      dropNext = true
    },
    close: async () => {
      fs.rmSync(path.join(discoveryDir, 'voice.json'), { force: true })
      await Promise.allSettled([...sessions.values()].map((transport) => transport.close()))
      sessions.clear()
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        httpServer.closeAllConnections()
      })
    },
  }
}

function isNotifyCall(body: unknown): boolean {
  return (
    typeof body === 'object' && body !== null && 'method' in body && body.method === 'tools/call' &&
    'params' in body && typeof body.params === 'object' && body.params !== null &&
    'name' in body.params && body.params.name === 'notify'
  )
}

function notifyArguments(body: unknown): Record<string, unknown> {
  if (
    typeof body === 'object' && body !== null && 'params' in body &&
    typeof body.params === 'object' && body.params !== null && 'arguments' in body.params &&
    typeof body.params.arguments === 'object' && body.params.arguments !== null
  ) {
    return { ...body.params.arguments }
  }
  return {}
}
