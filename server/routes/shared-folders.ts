import type * as http from 'node:http'
import type { URL } from 'node:url'

import {
  SHARED_FOLDER_ALREADY_IN_PROJECT,
  attachSharedFolderRequestSchema,
  sharedFolderIdSchema,
  type SharedFolderView,
} from '../../contracts/shared-folders.js'
import { WorkspaceProjectServiceError } from '../../domains/projects/workspace-project-service.js'
import type { SessionStore } from '../../domains/sessions/session-store.js'
import { isCanonicalSessionId } from '../../domains/shared-folders/shared-folder-store.js'
import type {
  AttachSharedFolderResult,
  SharedFolderService,
} from '../../services/shared-folder-service.js'
import { ApiRequestError, readJsonBody, writeJson } from '../http.js'

/**
 * `/sessions/:id/folders` and `/projects/:id/folders` — the folders a chat or
 * a project has attached (docs/feature-local-folder-access.md).
 *
 * The posted path must already carry a grant from the native folder picker;
 * the service refuses anything else, and anything overlapping the app's data.
 * The project routes are dispatched from the projects route, which has already
 * checked the project ID's shape.
 */

export const SHARED_FOLDER_ROUTE_PATTERN = /^\/sessions\/([^/]+)\/folders(?:\/([^/]+))?$/

const STATUS_FOR_REFUSAL = {
  not_a_folder: 400,
  not_granted: 403,
  protected_overlap: 403,
} as const

/** One owner's folder list, as the shared request handling needs it. */
interface FolderOwnerOperations {
  list(): Promise<SharedFolderView[]>
  attach(requestedPath: string): Promise<AttachSharedFolderResult>
  detach(folderId: string): Promise<boolean>
}

export async function handleSharedFolderRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly url: URL
  readonly service?: SharedFolderService
  readonly sessionStore?: Pick<SessionStore, 'getSession'>
}): Promise<boolean> {
  const { req, res, url, service, sessionStore } = params
  const match = SHARED_FOLDER_ROUTE_PATTERN.exec(url.pathname)
  if (!match) return false
  res.setHeader('cache-control', 'no-store')
  const sessionId = match[1] ?? ''
  const folderId = match[2]
  if (!service || !sessionStore) return writeUnavailable(res)
  if (!isCanonicalSessionId(sessionId) || !await sessionStore.getSession(sessionId)) {
    writeJson(res, 404, { error: 'Session not found.', code: 'session_not_found' })
    return true
  }
  return serveFolderRequest(req, res, folderId, {
    list: () => service.listForSession(sessionId),
    attach: (requestedPath) => service.attachToSession(sessionId, requestedPath),
    detach: (id) => service.detachFromSession(sessionId, id),
  })
}

export async function handleProjectSharedFolderRoutes(params: {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  readonly projectId: string
  readonly folderId: string | undefined
  readonly service: SharedFolderService | undefined
}): Promise<true> {
  const { req, res, projectId, folderId, service } = params
  res.setHeader('cache-control', 'no-store')
  if (!service) return writeUnavailable(res)
  return serveFolderRequest(req, res, folderId, {
    list: () => service.listForProject(projectId),
    attach: (requestedPath) => service.attachToProject(projectId, requestedPath),
    detach: (id) => service.detachFromProject(projectId, id),
  })
}

function writeUnavailable(res: http.ServerResponse): true {
  writeJson(res, 503, { error: 'Folder access is unavailable.', code: 'shared_folders_unavailable' })
  return true
}

async function serveFolderRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  folderId: string | undefined,
  owner: FolderOwnerOperations,
): Promise<true> {
  try {
    if (folderId === undefined && req.method === 'GET') {
      writeJson(res, 200, { folders: await owner.list() })
      return true
    }
    if (folderId === undefined && req.method === 'POST') {
      const parsed = attachSharedFolderRequestSchema.safeParse(await readJsonBody(req, 16_384))
      if (!parsed.success) {
        writeJson(res, 400, { error: 'A folder path is required.', code: 'invalid_shared_folder_request' })
        return true
      }
      const attached = await owner.attach(parsed.data.path)
      if (attached.kind === 'refused') {
        writeJson(res, STATUS_FOR_REFUSAL[attached.code], { error: attached.message, code: attached.code })
        return true
      }
      if (attached.kind === 'limit') {
        writeJson(res, 409, { error: attached.message, code: 'shared_folder_limit' })
        return true
      }
      if (attached.kind === 'already_in_project') {
        writeJson(res, 409, { error: attached.message, code: SHARED_FOLDER_ALREADY_IN_PROJECT })
        return true
      }
      writeJson(res, attached.kind === 'attached' ? 201 : 200, attached.folder)
      return true
    }
    if (folderId !== undefined && req.method === 'DELETE') {
      if (!sharedFolderIdSchema.safeParse(folderId).success || !await owner.detach(folderId)) {
        writeJson(res, 404, { error: 'Folder not found.', code: 'shared_folder_not_found' })
        return true
      }
      res.writeHead(204).end()
      return true
    }
    res.setHeader('allow', folderId === undefined ? 'GET, POST' : 'DELETE')
    writeJson(res, 405, { error: 'Method not allowed.', code: 'invalid_shared_folder_request' })
    return true
  } catch (error) {
    if (error instanceof ApiRequestError) {
      writeJson(res, error.statusCode, { error: error.message, code: 'invalid_shared_folder_request' })
      return true
    }
    if (error instanceof WorkspaceProjectServiceError) {
      writeJson(res, error.code === 'project_not_found' ? 404 : 409, { error: error.message, code: error.code })
      return true
    }
    writeJson(res, 500, { error: 'Folder request failed.', code: 'internal_shared_folder_error' })
    return true
  }
}
