import { canvasDocumentSchema, canvasDocumentErrorSchema, CANVAS_PROPOSAL_TIMEOUT_MS, type CanvasDocumentAction } from '@contracts/canvas-documents'
import type { CanvasTab } from '@contracts/canvas-workspace'
import { canvasWorkspaceUrl } from './canvas-client'

export function canvasDocumentUrl(sessionId: string, target: CanvasTab) {
  return `${canvasWorkspaceUrl(sessionId)}/document?${new URLSearchParams(target)}`
}

export class CanvasDocumentRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'CanvasDocumentRequestError'; this.code = code }
}

export async function requestCanvasDocument(sessionId: string, target: CanvasTab, signal: AbortSignal, action?: CanvasDocumentAction) {
  const response = await fetch(canvasDocumentUrl(sessionId, target), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(CANVAS_PROPOSAL_TIMEOUT_MS + 5000)]),
    ...(action ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) } : {}),
  })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const failure = canvasDocumentErrorSchema.safeParse(payload)
    if (response.status === 404 && failure.success && failure.data.code === 'document_not_found' && !action) return null
    throw new CanvasDocumentRequestError(failure.success ? failure.data.code : 'request_failed', failure.success ? failure.data.error : 'Canvas document request failed')
  }
  const document = canvasDocumentSchema.parse(payload)
  if (document.sessionId !== sessionId || document.origin.runId !== target.runId || document.origin.artifactPath !== target.artifactPath) throw new CanvasDocumentRequestError('invalid_response', 'The response belongs to another document.')
  return document
}
