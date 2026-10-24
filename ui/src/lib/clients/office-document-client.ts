import { officePreviewSchema, officeDocumentSchema, wordSnapshotSchema, type OfficePreview, type OfficePreviewRequest, type OfficeDocument, type OfficeProposalRequest, type OfficeProposalDisposition } from '@contracts/office-documents'
import { CANVAS_REQUEST_TIMEOUT_MS, type CanvasTab } from '@contracts/canvas-workspace'
import { CANVAS_PROPOSAL_TIMEOUT_MS } from '@contracts/canvas-documents'
import { canvasWorkspaceUrl } from './canvas-client'

async function request(sessionId: string, endpoint: string, body: unknown, signal: AbortSignal, timeout = CANVAS_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(`${canvasWorkspaceUrl(sessionId)}/office/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) })
  const payload: unknown = await response.json()
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Office preview unavailable. Download the original file.'
    throw new Error(message)
  }
  return payload
}
export async function fetchOfficePreview(sessionId: string, source: CanvasTab | OfficePreviewRequest, signal: AbortSignal): Promise<OfficePreview> {
  return officePreviewSchema.parse(await request(sessionId, 'preview', 'runId' in source ? { target: source } : source, signal))
}
export async function lookupOfficeDocument(sessionId: string, target: CanvasTab, signal: AbortSignal): Promise<OfficeDocument | null> {
  return officeDocumentSchema.nullable().parse(await request(sessionId, 'documents/lookup', { target }, signal))
}
export async function createOfficeCopy(sessionId: string, target: CanvasTab, signal: AbortSignal): Promise<OfficeDocument> {
  return officeDocumentSchema.parse(await request(sessionId, 'documents', { target }, signal))
}
export async function proposeOfficeRevision(sessionId: string, documentId: string, proposal: OfficeProposalRequest, signal: AbortSignal): Promise<OfficeDocument> {
  return officeDocumentSchema.parse(await request(sessionId, `documents/${documentId}/proposals`, proposal, signal, CANVAS_PROPOSAL_TIMEOUT_MS))
}
export async function decideOfficeRevision(sessionId: string, documentId: string, decision: OfficeProposalDisposition, signal: AbortSignal): Promise<OfficeDocument> {
  return officeDocumentSchema.parse(await request(sessionId, `documents/${documentId}/disposition`, decision, signal))
}
export const officeDownloadUrl = (sessionId: string, document: OfficeDocument, original = false): string => `${canvasWorkspaceUrl(sessionId)}/office/documents/${document.id}/${original ? 'original' : `revisions/${document.revision}`}/download`
export async function fetchWordSnapshot(sessionId: string, target: CanvasTab, signal: AbortSignal, expectedRevision?: number) {
  const result = await request(sessionId, expectedRevision === undefined ? 'word-snapshot/state' : 'word-snapshot', { target, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, signal)
  return wordSnapshotSchema.nullable().parse(result)
}
