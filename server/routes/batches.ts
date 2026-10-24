import type * as http from 'node:http'
import type { URL } from 'node:url'

import {
  BatchRequestValidationError,
  parseCreateBatchRequest,
  parseEmptyBatchRequest,
  parsePatchBatchRequest,
} from '../../contracts/schemas/batch-requests.js'
import type { BatchErrorCode } from '../../contracts/batches.js'
import { BatchStoreUnavailableError } from '../../domains/batches/batch-store.js'
import { BatchService, BatchServiceError } from '../../services/batch-service.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

const MAX_BODY_BYTES = 131_072

export type BatchesRouteRuntime = Pick<BatchService,
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'preflight'
  | 'runNow'
  | 'listExecutionsPage'
  | 'getExecutionItemsPage'
  | 'cancelExecution'
  | 'clearExecutionResults'
  | 'readResultArtifact'
>

export async function handleBatchesRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: BatchesRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== '/batches' && !url.pathname.startsWith('/batches/')) return false
  res.setHeader('cache-control', 'no-store')
  if (!runtime) {
    writeJson(res, 503, { error: 'Batches are unavailable.', code: 'batch_service_unavailable' })
    return true
  }
  let segments: string[]
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return writeBatchError(res, new BatchServiceError('invalid_batch_request', 'Batch path is invalid.'))
  }
  try {
    if (segments.length === 1) {
      requireNoQuery(url)
      if (req.method === 'GET') {
        writeJson(res, 200, { batches: await runtime.list() })
        return true
      }
      if (req.method === 'POST') {
        const input = parseCreateBatchRequest(await readJsonBody(req, MAX_BODY_BYTES))
        writeJson(res, 201, await runtime.create(input))
        return true
      }
      return methodNotAllowed(res, 'GET, POST')
    }
    const batchId = requireSegment(segments, 1)
    if (segments.length === 2) {
      requireNoQuery(url)
      if (req.method === 'GET') {
        const batch = await runtime.get(batchId)
        if (!batch) throw new BatchServiceError('batch_not_found', `Batch not found: ${batchId}`)
        writeJson(res, 200, batch)
        return true
      }
      if (req.method === 'PATCH') {
        const input = parsePatchBatchRequest(await readJsonBody(req, MAX_BODY_BYTES))
        writeJson(res, 200, await runtime.update(batchId, input))
        return true
      }
      if (req.method === 'DELETE') {
        await runtime.delete(batchId)
        res.writeHead(204).end()
        return true
      }
      return methodNotAllowed(res, 'GET, PATCH, DELETE')
    }
    if (segments.length === 3 && (segments[2] === 'preflight' || segments[2] === 'run-now')) {
      requireNoQuery(url)
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      parseEmptyBatchRequest(await readJsonBody(req, MAX_BODY_BYTES))
      if (segments[2] === 'preflight') {
        writeJson(res, 200, await runtime.preflight(batchId))
      } else {
        const execution = await runtime.runNow(batchId)
        writeJson(res, 202, { executionId: execution.id })
      }
      return true
    }
    if (segments.length === 3 && segments[2] === 'executions') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      writeJson(res, 200, await runtime.listExecutionsPage(batchId, pagination(url)))
      return true
    }
    if (segments.length === 4 && segments[2] === 'executions') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      writeJson(res, 200, await runtime.getExecutionItemsPage(batchId, requireSegment(segments, 3), pagination(url)))
      return true
    }
    if (
      segments.length === 5 && segments[2] === 'executions' &&
      (segments[4] === 'cancel' || segments[4] === 'results')
    ) {
      requireNoQuery(url)
      const executionId = requireSegment(segments, 3)
      if (segments[4] === 'cancel') {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        parseEmptyBatchRequest(await readJsonBody(req, MAX_BODY_BYTES))
        const execution = await runtime.cancelExecution(batchId, executionId)
        writeJson(res, 202, {
          executionId: execution.id,
          status: execution.status,
          ...(execution.cancelRequestedAt ? { cancelRequestedAt: execution.cancelRequestedAt } : {}),
        })
      } else {
        if (req.method !== 'DELETE') return methodNotAllowed(res, 'DELETE')
        parseEmptyBatchRequest(await readJsonBody(req, MAX_BODY_BYTES))
        await runtime.clearExecutionResults(batchId, executionId)
        res.writeHead(204).end()
      }
      return true
    }
    if (
      segments.length === 8 && segments[2] === 'executions' &&
      segments[4] === 'items' && segments[6] === 'artifacts'
    ) {
      requireNoQuery(url)
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      const artifactIndex = parseArtifactIndex(requireSegment(segments, 7))
      const artifact = await runtime.readResultArtifact(
        batchId,
        requireSegment(segments, 3),
        requireSegment(segments, 5),
        artifactIndex,
      )
      res.statusCode = 200
      res.setHeader('content-type', artifact.contentType)
      res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`)
      res.end(artifact.content)
      return true
    }
    writeJson(res, 404, { error: 'Not found.', code: 'batch_not_found' })
    return true
  } catch (error) {
    return writeBatchError(res, error)
  }
}

function pagination(url: URL): { cursor?: string; limit?: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== 'cursor' && key !== 'limit') {
      throw new BatchServiceError('invalid_batch_request', `Unknown pagination field: ${key}`)
    }
  }
  const cursor = url.searchParams.get('cursor') ?? undefined
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) {
    throw new BatchServiceError('invalid_batch_request', 'Pagination limit must be between 1 and 100.')
  }
  return { ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: Number(rawLimit) } : {}) }
}

function requireSegment(segments: readonly string[], index: number): string {
  const segment = segments[index]
  if (segment === undefined) {
    throw new Error(`Batch route segment ${index} is missing after the route length check.`)
  }
  return segment
}

function parseArtifactIndex(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BatchServiceError('invalid_batch_request', 'Artifact index is invalid.')
  }
  return Number(value)
}

function requireNoQuery(url: URL): void {
  if (url.search) throw new BatchServiceError('invalid_batch_request', 'Query parameters are not allowed.')
}

function methodNotAllowed(res: http.ServerResponse, allow: string): boolean {
  res.setHeader('allow', allow)
  writeJson(res, 405, { error: 'Method not allowed.', code: 'invalid_batch_request' })
  return true
}

function writeBatchError(res: http.ServerResponse, error: unknown): true {
  if (error instanceof ApiRequestError) {
    writeJson(res, error.statusCode, { error: error.message, code: 'invalid_batch_request' })
    return true
  }
  if (error instanceof BatchRequestValidationError) {
    writeJson(res, 400, { error: error.message, code: 'invalid_batch_request' })
    return true
  }
  if (error instanceof BatchStoreUnavailableError) {
    writeJson(res, 503, { error: 'Batches are unavailable.', code: 'batch_service_unavailable' })
    return true
  }
  if (!(error instanceof BatchServiceError)) {
    writeJson(res, 500, { error: 'Batch request failed.', code: 'internal_batch_error' })
    return true
  }
  const code: BatchErrorCode = error.code
  const status = code === 'invalid_batch_request' ? 400
    : code === 'folder_access_denied' ? 403
      : code === 'batch_not_found' || code === 'execution_not_found' ||
          code === 'item_not_found' || code === 'artifact_not_found' ||
          code === 'grant_not_found' ? 404
        : code === 'artifact_cleared' ? 410
          : code === 'batch_too_large' ? 413
            : code === 'batch_service_unavailable' || code === 'task_queue_recovering' ? 503
              : 409
  writeJson(res, status, {
    error: error.message,
    code: error.code,
    ...(error.details?.limits ? { limits: error.details.limits } : {}),
    ...(error.details?.preflight ? { preflight: error.details.preflight } : {}),
  })
  return true
}
