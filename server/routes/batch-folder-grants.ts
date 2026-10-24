import type * as http from 'node:http'
import type { URL } from 'node:url'

import {
  BatchRequestValidationError,
  parseRevokeBatchFolderGrantRequest,
} from '../../contracts/schemas/batch-requests.js'
import {
  BatchFolderGrantStoreUnavailableError,
  type BatchFolderGrantStore,
} from '../../domains/batches/batch-folder-grant-store.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

export type BatchFolderGrantsRouteRuntime = Pick<BatchFolderGrantStore, 'list' | 'revoke'>

export async function handleBatchFolderGrantRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: BatchFolderGrantsRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== '/settings/batch-folder-grants') return false
  res.setHeader('cache-control', 'no-store')
  if (!runtime) {
    if (req.method === 'GET') {
      writeJson(res, 200, { grants: [] })
      return true
    }
    writeJson(res, 503, { error: 'Batch folder grants are unavailable.', code: 'batch_service_unavailable' })
    return true
  }
  if (url.search) {
    writeJson(res, 400, { error: 'Query parameters are not allowed.', code: 'invalid_batch_request' })
    return true
  }
  try {
    if (req.method === 'GET') {
      writeJson(res, 200, { grants: (await runtime.list()).map((folderPath) => ({ path: folderPath })) })
      return true
    }
    if (req.method === 'DELETE') {
      const input = parseRevokeBatchFolderGrantRequest(await readJsonBody(req, 16_384))
      if (!await runtime.revoke(input.path)) {
        writeJson(res, 404, { error: 'Batch folder grant not found.', code: 'grant_not_found' })
        return true
      }
      res.writeHead(204).end()
      return true
    }
    res.setHeader('allow', 'GET, DELETE')
    writeJson(res, 405, { error: 'Method not allowed.', code: 'invalid_batch_request' })
    return true
  } catch (error) {
    if (error instanceof ApiRequestError || error instanceof BatchRequestValidationError) {
      writeJson(res, error instanceof ApiRequestError ? error.statusCode : 400, {
        error: error.message,
        code: 'invalid_batch_request',
      })
      return true
    }
    if (error instanceof BatchFolderGrantStoreUnavailableError) {
      writeJson(res, 503, {
        error: 'Batch folder grants are unavailable.',
        code: 'batch_service_unavailable',
      })
      return true
    }
    writeJson(res, 500, {
      error: 'Batch folder grant request failed.',
      code: 'internal_batch_error',
    })
    return true
  }
}
