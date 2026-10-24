import type * as http from 'node:http'
import type { URL } from 'node:url'

import { revokeSharedFolderGrantRequestSchema } from '../../contracts/shared-folders.js'
import {
  BatchFolderGrantStoreUnavailableError,
  type BatchFolderGrantStore,
} from '../../domains/batches/batch-folder-grant-store.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

/**
 * `/settings/shared-folder-grants`: the folders the person picked for sharing
 * with agents (docs/feature-local-folder-access.md, SEC-2 and SEC-9).
 *
 * The same contract as `/settings/batch-folder-grants`, over the shared
 * folders' own grant list. Revoking a grant does not detach the folder; every
 * folder tool call reads the list, so the next one fails with "Access to this
 * folder was removed".
 */

const SHARED_FOLDER_GRANTS_PATH = '/settings/shared-folder-grants'

export type SharedFolderGrantsRouteRuntime = Pick<BatchFolderGrantStore, 'list' | 'revoke'>

function writeUnavailable(res: http.ServerResponse): true {
  writeJson(res, 503, { error: 'Shared folder grants are unavailable.', code: 'shared_folders_unavailable' })
  return true
}

export async function handleSharedFolderGrantRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly runtime?: SharedFolderGrantsRouteRuntime
}): Promise<boolean> {
  const { req, res, url, runtime } = params
  if (url.pathname !== SHARED_FOLDER_GRANTS_PATH) return false
  res.setHeader('cache-control', 'no-store')
  if (!runtime) {
    if (req.method === 'GET') {
      writeJson(res, 200, { grants: [] })
      return true
    }
    return writeUnavailable(res)
  }
  if (url.search) {
    writeJson(res, 400, { error: 'Query parameters are not allowed.', code: 'invalid_shared_folder_request' })
    return true
  }
  try {
    if (req.method === 'GET') {
      writeJson(res, 200, { grants: (await runtime.list()).map((folderPath) => ({ path: folderPath })) })
      return true
    }
    if (req.method === 'DELETE') {
      const parsed = revokeSharedFolderGrantRequestSchema.safeParse(await readJsonBody(req, 16_384))
      if (!parsed.success) {
        writeJson(res, 400, {
          error: 'Shared folder grant request must be { "path": "<absolute path>" }.',
          code: 'invalid_shared_folder_request',
        })
        return true
      }
      if (!await runtime.revoke(parsed.data.path)) {
        writeJson(res, 404, { error: 'Shared folder grant not found.', code: 'grant_not_found' })
        return true
      }
      res.writeHead(204).end()
      return true
    }
    res.setHeader('allow', 'GET, DELETE')
    writeJson(res, 405, { error: 'Method not allowed.', code: 'invalid_shared_folder_request' })
    return true
  } catch (error) {
    if (error instanceof ApiRequestError) {
      writeJson(res, error.statusCode, { error: error.message, code: 'invalid_shared_folder_request' })
      return true
    }
    if (error instanceof BatchFolderGrantStoreUnavailableError) return writeUnavailable(res)
    writeJson(res, 500, { error: 'Shared folder grant request failed.', code: 'internal_shared_folder_error' })
    return true
  }
}
