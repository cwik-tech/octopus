import type * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isTextArtifactExtension } from '../../core/artifact-media.js'
import type { SessionRoutesOptions } from './sessions.js'
import { writeJson } from '../http.js'
import { createRequestAbort, readJsonBody } from '../http.js'
import { CANVAS_MAX_PREVIEW_BYTES, CANVAS_MAX_REQUEST_BYTES, canvasActionSchema, canvasTabSchema, type CanvasTab } from '../../contracts/canvas-workspace.js'
import { isValidSessionId } from '../../contracts/sessions.js'
import { accessCanvasWorkspace, canvasSessionDirectory, CanvasWorkspaceError } from '../../services/canvas-workspace-store.js'

async function ownsRun(options: SessionRoutesOptions, sessionId: string, target: CanvasTab): Promise<boolean> {
  if (!options.sessionStore) return false
  const messages = await options.sessionStore.listChatMessages(sessionId)
  if (messages.some((message) => message.delivery?.artifacts.some((artifact) => artifact.runId === target.runId))) return true
  const tasks = await options.sessionStore.listTaskRecords(sessionId)
  return tasks.some((task) => task.runId === target.runId)
}

/** MUST validate chat/run ownership and serialize saved workspace actions. */
export async function handleCanvasRoutes(input: {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  sessionId: string
  options: SessionRoutesOptions
}): Promise<boolean> {
  const { req, res, url, sessionId, options } = input
  const aborted = createRequestAbort(req, res)
  try {
    if (!isValidSessionId(sessionId)) { writeJson(res, 400, { error: 'Invalid session id' }); return true }
    if (!options.sessionStore || !options.workspacePath) { writeJson(res, 501, { error: 'Canvas storage is unavailable' }); return true }
    await canvasSessionDirectory(options.workspacePath, sessionId)
    if (!await options.sessionStore.getSession(sessionId)) { writeJson(res, 404, { error: 'Session not found' }); return true }
    if (url.pathname.endsWith('/canvas/content')) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true }
      const target = canvasTabSchema.safeParse({ runId: url.searchParams.get('runId'), artifactPath: url.searchParams.get('artifactPath') })
      if (!target.success) { writeJson(res, 400, { error: 'Invalid artifact reference' }); return true }
      if (!await ownsRun(options, sessionId, target.data)) { writeJson(res, 404, { error: 'Artifact not found in this chat' }); return true }
      if (!isTextArtifactExtension(path.extname(target.data.artifactPath))) {
        writeJson(res, 415, { error: 'This format is available as a download.' }); return true
      }
      const artifact = await options.runStore?.readArtifact(target.data.runId, target.data.artifactPath, { maxBytes: CANVAS_MAX_PREVIEW_BYTES })
      aborted.signal.throwIfAborted()
      if (!artifact || typeof artifact.content !== 'string') { writeJson(res, 404, { error: 'Preview unavailable: file is missing, binary, or exceeds the preview limit.' }); return true }
      writeJson(res, 200, { content: artifact.content })
      return true
    }
    if (req.method !== 'GET' && req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true }
    const parsed = req.method === 'POST' ? canvasActionSchema.safeParse(await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES)) : null
    if (parsed && !parsed.success) { writeJson(res, 400, { error: 'Invalid Canvas action' }); return true }
    const action = parsed?.success ? parsed.data : undefined
    if (action?.kind === 'open' && !await ownsRun(options, sessionId, action.target)) { writeJson(res, 404, { error: 'Artifact not found in this chat' }); return true }
    const state = await accessCanvasWorkspace({ workspacePath: options.workspacePath, sessionId, sessionStore: options.sessionStore, signal: aborted.signal, ...(action ? { action } : {}) })
    writeJson(res, 200, state)
    return true
  } catch (error) {
    if (error instanceof CanvasWorkspaceError) { writeJson(res, error.statusCode, { error: error.message, code: error.code }); return true }
    // The session store's containment check may throw while deletion removes
    // its directory. Report absence only when the directory is actually gone.
    if (options.workspacePath && isValidSessionId(sessionId)) {
      try { await fs.lstat(path.join(options.workspacePath, 'sessions', sessionId)) }
      catch (lookupError) {
        if (lookupError instanceof Error && 'code' in lookupError && lookupError.code === 'ENOENT') {
          writeJson(res, 404, { error: 'Session not found' }); return true
        }
        throw lookupError
      }
    }
    throw error
  } finally { aborted.dispose() }
}
