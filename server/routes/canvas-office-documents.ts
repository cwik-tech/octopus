import type * as http from 'node:http'
import type { SessionRoutesOptions } from './sessions.js'
import { ApiRequestError, createRequestAbort, readJsonBody, writeJson } from '../http.js'
import { CANVAS_REQUEST_TIMEOUT_MS, CANVAS_MAX_REQUEST_BYTES } from '../../contracts/canvas-workspace.js'
import { officePreviewRequestSchema, officeCreateRequestSchema, officeProposalRequestSchema, officeProposalDispositionSchema, officeWordSnapshotRequestSchema, type OfficeFailure } from '../../contracts/office-documents.js'
import { createWordSnapshot, getWordSnapshot } from '../../services/canvas-word-snapshot-service.js'
import { CanvasWorkspaceError } from '../../services/canvas-workspace-store.js'
import { renderOfficePreview, renderOfficeBytes } from '../../services/office-preview-service.js'
import { createOfficeDocument, officeDocumentId, readOfficeRevision } from '../../services/canvas-office-document-store.js'
import { getOfficeDocumentState, proposeOfficeEdit, disposeOfficeEdit, readOfficeCandidate } from '../../services/canvas-office-document-service.js'
import { CANVAS_PROPOSAL_TIMEOUT_MS } from '../../contracts/canvas-documents.js'
import { artifactMediaTypeForExtension } from '../../core/artifact-media.js'

export async function handleCanvasOfficeRoutes(input: { req: http.IncomingMessage; res: http.ServerResponse; url: URL; sessionId: string; options: SessionRoutesOptions }): Promise<boolean> {
  const { req, res, options, sessionId } = input
  if (!options.workspacePath || !options.sessionStore || !options.repoRootPath) { writeJson(res, 503, { error: 'Office preview is unavailable. Download the original file.' }); return true }
  const aborted = createRequestAbort(req, res)
  const signal = AbortSignal.any([aborted.signal, AbortSignal.timeout(input.url.pathname.endsWith('/proposals') ? CANVAS_PROPOSAL_TIMEOUT_MS : CANVAS_REQUEST_TIMEOUT_MS)])
  try {
    const scope = { workspacePath: options.workspacePath, sessionId, sessionStore: options.sessionStore, repoRoot: options.repoRootPath, signal }
    const tail = input.url.pathname.split('/canvas/office/')[1]?.split('/') ?? []
    if (tail[0] === 'word-snapshot' && req.method === 'POST') {
      const body: unknown = await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES)
      const stateOnly = tail.length === 2 && tail[1] === 'state'
      const parsed = (stateOnly ? officeCreateRequestSchema : officeWordSnapshotRequestSchema).safeParse(body)
      if (!parsed.success || !/\.(md|markdown)$/i.test(parsed.data.target.artifactPath)) { writeJson(res, 400, { error: 'Invalid Markdown snapshot request.' }); return true }
      const source = { ...scope, sessionStore: options.sessionStore, target: parsed.data.target }
      const result = 'expectedRevision' in parsed.data && typeof parsed.data.expectedRevision === 'number' ? await createWordSnapshot({ ...source, expectedRevision: parsed.data.expectedRevision }) : await getWordSnapshot(source)
      if (!result.ok && stateOnly && result.code === 'document_not_found') writeJson(res, 200, null)
      else if (!result.ok) writeOfficeFailure(res, result)
      else writeJson(res, 200, { document: result.document, stale: result.stale })
      return true
    }
    if (tail[0] === 'documents') {
      if (tail.length === 2 && tail[1] === 'lookup' && req.method === 'POST') {
        const parsed = officeCreateRequestSchema.safeParse(await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES))
        if (!parsed.success) { writeJson(res, 400, { error: 'Invalid Office document request.' }); return true }
        const result = await getOfficeDocumentState({ ...scope, documentId: officeDocumentId(parsed.data.target) })
        if (!result.ok && result.code === 'document_not_found') writeJson(res, 200, null)
        else if (!result.ok) writeOfficeFailure(res, result)
        else writeJson(res, 200, result.document)
        return true
      }
      if (tail.length === 1 && req.method === 'POST') {
        const parsed = officeCreateRequestSchema.safeParse(await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES))
        if (!parsed.success) { writeJson(res, 400, { error: 'Invalid Office document request.' }); return true }
        const result = await createOfficeDocument({ ...scope, target: parsed.data.target })
        if (!result.ok) writeOfficeFailure(res, result)
        else writeJson(res, 200, result.document)
        return true
      }
      const documentId = tail[1]
      if (documentId && tail.length === 3 && req.method === 'POST' && tail[2] === 'proposals') {
        const parsed = officeProposalRequestSchema.safeParse(await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES))
        if (!parsed.success) { writeJson(res, 400, { error: 'Invalid Office revision request.' }); return true }
        const result = await proposeOfficeEdit({ ...scope, documentId, request: parsed.data })
        if (!result.ok) writeOfficeFailure(res, result)
        else writeJson(res, 200, result.document)
        return true
      }
      if (documentId && tail.length === 3 && req.method === 'POST' && tail[2] === 'disposition') {
        const parsed = officeProposalDispositionSchema.safeParse(await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES))
        if (!parsed.success) { writeJson(res, 400, { error: 'Invalid Office revision decision.' }); return true }
        const result = await disposeOfficeEdit({ ...scope, documentId, disposition: parsed.data })
        if (!result.ok) writeOfficeFailure(res, result)
        else writeJson(res, 200, result.document)
        return true
      }
      if (!documentId || req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed.' }); return true }
      if (tail.length === 2) {
        const result = await getOfficeDocumentState({ ...scope, documentId })
        if (!result.ok) writeOfficeFailure(res, result)
        else writeJson(res, 200, result.document)
        return true
      }
      const original = tail.length === 4 && tail[2] === 'original' && tail[3] === 'download'
      const numbered = tail.length === 5 && tail[2] === 'revisions' && /^\d+$/.test(tail[3] ?? '') && tail[4] === 'download'
      if (original || numbered) {
        const revision = original ? 'original' : Number(tail[3])
        const result = await readOfficeRevision({ ...scope, documentId, revision })
        if (!result.ok) writeOfficeFailure(res, result)
        else {
          res.writeHead(200, { 'content-type': artifactMediaTypeForExtension(`.${result.format}`) ?? 'application/octet-stream', 'content-length': result.bytes.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`, etag: `"${result.digest}"` })
          res.end(result.bytes)
        }
        return true
      }
      writeJson(res, 404, { error: 'Office document endpoint not found.' }); return true
    }
    if (req.method !== 'POST' || tail.length !== 1 || tail[0] !== 'preview') { writeJson(res, 405, { error: 'Method not allowed.' }); return true }
    const parsed = officePreviewRequestSchema.safeParse(await readJsonBody(req, CANVAS_MAX_REQUEST_BYTES))
    if (!parsed.success) { writeJson(res, 400, { error: 'Invalid Office preview request.' }); return true }
    const result = 'target' in parsed.data
      ? await renderOfficePreview({ ...scope, target: parsed.data.target, repoRoot: options.repoRootPath })
      : await ('proposalId' in parsed.data ? readOfficeCandidate({ ...scope, ...parsed.data }) : readOfficeRevision({ ...scope, ...parsed.data })).then((source) => source.ok ? renderOfficeBytes({ ...scope, source }) : source)
    if ('ok' in result) { writeJson(res, result.code === 'foreign_origin' ? 404 : result.code === 'unsafe_package' ? 415 : 503, { ...result, error: `Office preview unavailable (${result.code}). Download the original file.` }); return true }
    writeJson(res, 200, result)
    return true
  } catch (error) {
    if (error instanceof CanvasWorkspaceError) { writeJson(res, error.statusCode, { error: error.message, code: error.code }); return true }
    if (error instanceof ApiRequestError) { writeJson(res, error.statusCode, { error: error.message }); return true }
    if (signal.aborted) { writeJson(res, 408, { error: 'Office preview cancelled or timed out.' }); return true }
    throw error
  } finally { aborted.dispose() }
}

function writeOfficeFailure(res: http.ServerResponse, failure: OfficeFailure): void {
  writeJson(res, failure.code === 'document_not_found' || failure.code === 'foreign_origin' ? 404 : 409, { ...failure, error: `Office document unavailable (${failure.code}).` })
}
