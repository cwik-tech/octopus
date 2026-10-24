import type * as http from 'node:http'
import type { SessionRoutesOptions } from './sessions.js'
import { ApiRequestError, createRequestAbort, readJsonBody, writeJson } from '../http.js'
import { canvasDocumentActionSchema, CANVAS_DOCUMENT_REQUEST_BYTES, CANVAS_PROPOSAL_TIMEOUT_MS } from '../../contracts/canvas-documents.js'
import { canvasTabSchema } from '../../contracts/canvas-workspace.js'
import { accessCanvasDocument, runCanvasProposal } from '../../services/canvas-document-service.js'
import { CanvasWorkspaceError } from '../../services/canvas-workspace-store.js'

export async function handleCanvasDocumentRoutes(input: { req: http.IncomingMessage; res: http.ServerResponse; url: URL; sessionId: string; options: SessionRoutesOptions }): Promise<boolean> {
  const { req, res, url, sessionId, options } = input
  const aborted = createRequestAbort(req, res)
  const signal = AbortSignal.any([aborted.signal, AbortSignal.timeout(CANVAS_PROPOSAL_TIMEOUT_MS)])
  try {
    if (!options.workspacePath || !options.sessionStore) { writeJson(res, 501, { code: 'storage_unavailable', error: 'Canvas document storage is unavailable.' }); return true }
    if (req.method !== 'GET' && req.method !== 'POST') { writeJson(res, 405, { code: 'method_not_allowed', error: 'Method not allowed.' }); return true }
    const parsed = req.method === 'POST' ? canvasDocumentActionSchema.safeParse(await readJsonBody(req, CANVAS_DOCUMENT_REQUEST_BYTES)) : null
    if (parsed && !parsed.success) { writeJson(res, 400, { code: 'invalid_document_action', error: 'Invalid Canvas document action.' }); return true }
    const action = parsed?.success ? parsed.data : undefined
    const target = canvasTabSchema.safeParse(action?.target ?? { runId: url.searchParams.get('runId'), artifactPath: url.searchParams.get('artifactPath') })
    if (!target.success) { writeJson(res, 400, { code: 'invalid_target', error: 'Invalid Canvas document target.' }); return true }
    const operation = { workspacePath: options.workspacePath, sessionId, sessionStore: options.sessionStore, target: target.data, signal, ...(action ? { action } : {}) }
    const document = await accessCanvasDocument(operation)
    writeJson(res, 200, action?.kind === 'propose' ? await runCanvasProposal(operation, document) : document)
    return true
  } catch (error) {
    if (error instanceof CanvasWorkspaceError) { writeJson(res, error.statusCode, { code: error.code, error: error.message }); return true }
    if (error instanceof ApiRequestError) { writeJson(res, error.statusCode, { code: 'invalid_document_request', error: error.message }); return true }
    throw error
  } finally { aborted.dispose() }
}
