import type * as http from 'node:http'
import { once } from 'node:events'
import { isValidSessionId } from '../../contracts/sessions.js'
import { interjectAgentDialogueRequestSchema, startAgentDialogueRequestSchema } from '../../contracts/agent-dialogue.js'
import { createSerializedSseWriter } from '../../domains/runtime/sse-serialized-writer.js'
import type { AgentDialogueService } from '../../services/agent-dialogue-service.js'
import { SessionActivityConflictError } from '../../domains/sessions/session-activity-claims.js'
import { parseServiceRequest, ServiceError, statusCodeForServiceError } from '../../services/service-errors.js'
import { readJsonBody, writeJson } from '../http.js'

export async function handleSessionDialogueRoutes(input: {
  req: http.IncomingMessage; res: http.ServerResponse; url: URL; service?: AgentDialogueService
}): Promise<boolean> {
  const match = /^\/sessions\/([^/]+)\/dialogues(?:\/([^/]+)(?:\/(events|stop|pause|resume|interjections))?)?$/.exec(input.url.pathname)
  if (!match) return false
  const sessionId = match[1]
  const dialogueId = match[2]
  if (!sessionId || !isValidSessionId(sessionId) || (dialogueId !== undefined && !isValidSessionId(dialogueId))) {
    writeJson(input.res, 400, { error: 'Invalid dialogue or session id' })
    return true
  }
  const service = input.service
  if (!service) { writeJson(input.res, 501, { error: 'Agent dialogue is not configured' }); return true }
  try {
    if (input.req.method === 'POST' && dialogueId === undefined) {
      const request = parseServiceRequest(startAgentDialogueRequestSchema, await readJsonBody(input.req))
      writeJson(input.res, 202, await service.start(sessionId, request))
    } else if (input.req.method === 'POST' && dialogueId !== undefined && match[3] === 'stop') {
      writeJson(input.res, 200, await service.stop(sessionId, dialogueId))
    } else if (input.req.method === 'POST' && dialogueId !== undefined && match[3] === 'pause') {
      writeJson(input.res, 200, await service.pause(sessionId, dialogueId))
    } else if (input.req.method === 'POST' && dialogueId !== undefined && match[3] === 'resume') {
      writeJson(input.res, 200, await service.resume(sessionId, dialogueId))
    } else if (input.req.method === 'POST' && dialogueId !== undefined && match[3] === 'interjections') {
      const request = parseServiceRequest(interjectAgentDialogueRequestSchema, await readJsonBody(input.req))
      writeJson(input.res, 200, await service.interject(sessionId, dialogueId, request))
    } else if (input.req.method === 'GET' && dialogueId === undefined) {
      const status = input.url.searchParams.get('status')
      if (status !== null && status !== 'active') throw new ServiceError('bad_request', 'status must be active when supplied')
      const dialogues = await service.list(sessionId)
      writeJson(input.res, 200, { dialogues: status === 'active' ? dialogues.filter((record) => record.status === 'running' || record.status === 'paused') : dialogues })
    } else if (input.req.method === 'GET' && dialogueId !== undefined && (match[3] === undefined || match[3] === 'events')) {
      const record = await service.get(sessionId, dialogueId)
      if (!record) { writeJson(input.res, 404, { error: 'Dialogue not found' }); return true }
      if (match[3] !== 'events') writeJson(input.res, 200, record)
      else await serveEvents(input, service, sessionId, dialogueId)
    } else writeJson(input.res, 405, { error: 'Method not allowed' })
  } catch (error) {
    if (error instanceof SessionActivityConflictError) { writeJson(input.res, 409, { code: error.code, error: error.message }); return true }
    if (!(error instanceof ServiceError)) throw error
    writeJson(input.res, statusCodeForServiceError(error), { code: error.code, error: error.message })
  }
  return true
}

async function serveEvents(input: { req: http.IncomingMessage; res: http.ServerResponse; url: URL }, service: AgentDialogueService, sessionId: string, dialogueId: string): Promise<void> {
  let cursor = Number(input.url.searchParams.get('from') ?? '0')
  if (!Number.isSafeInteger(cursor) || cursor < 0) { writeJson(input.res, 400, { error: 'from must be a nonnegative integer' }); return }
  const controller = new AbortController()
  input.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
  const writer = createSerializedSseWriter(async (payload) => {
    if (input.res.destroyed || input.res.writableEnded) throw new Error('Dialogue event stream closed')
    if (!input.res.write(payload)) await once(input.res, 'drain', { signal: controller.signal })
  })
  let pumping = false
  let pending = false
  let unsubscribe: (() => void) | undefined
  const close = () => { controller.abort(); unsubscribe?.(); if (!input.res.writableEnded && !input.res.destroyed) input.res.end() }
  const pump = async () => {
    if (pumping) { pending = true; return }
    pumping = true
    try {
      do {
        pending = false
        const record = await service.get(sessionId, dialogueId)
        if (!record || controller.signal.aborted) return
        for (const event of record.events.filter((event) => event.sequence >= cursor)) {
          await writer.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          cursor = event.sequence + 1
        }
        if (record.events.some((event) => event.type === 'ended')) close()
      } while (pending && !controller.signal.aborted)
    } finally { pumping = false }
  }
  unsubscribe = service.subscribe(dialogueId, () => { void pump().catch(close) /* Socket failure only ends this subscriber. */ })
  input.res.once('close', close)
  input.res.once('error', close)
  await pump()
}
