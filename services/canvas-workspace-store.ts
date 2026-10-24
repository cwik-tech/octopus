import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { canvasWorkspaceSchema, CANVAS_MAX_STORE_BYTES, CANVAS_STORE_FILENAME, type CanvasAction, type CanvasWorkspace } from '../contracts/canvas-workspace.js'
import { isValidSessionId } from '../contracts/sessions.js'
import { applyCanvasAction, emptyCanvasWorkspace } from '../core/canvas-workspace.js'
import { writeFileAtomic } from '../core/file-mutation.js'
import { withFileLock } from '../domains/sessions/session-file-locks.js'
import type { SessionStore } from '../domains/sessions/session-store.js'

export class CanvasWorkspaceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message) }
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Validate before any session-store read, and again under the mutation lock. */
export async function canvasSessionDirectory(workspacePath: string, sessionId: string): Promise<string> {
  if (!isValidSessionId(sessionId)) throw new CanvasWorkspaceError(400, 'invalid_session', 'Invalid session id')
  try {
    const root = await fs.realpath(workspacePath)
    const sessionsPath = path.join(workspacePath, 'sessions')
    const directory = path.join(sessionsPath, sessionId)
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      await fs.realpath(sessionsPath) !== path.join(root, 'sessions') ||
      await fs.realpath(directory) !== path.join(root, 'sessions', sessionId)) {
      throw new CanvasWorkspaceError(409, 'unsafe_workspace', 'Canvas requires a contained session directory.')
    }
    return directory
  } catch (error) {
    if (isMissing(error)) throw new CanvasWorkspaceError(404, 'session_not_found', 'Session not found')
    throw error
  }
}

async function readSaved(file: string): Promise<CanvasWorkspace> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CANVAS_MAX_STORE_BYTES) {
      throw new CanvasWorkspaceError(409, 'invalid_saved_workspace', 'Canvas state is unavailable; the saved file was not changed.')
    }
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return canvasWorkspaceSchema.parse(raw)
  } catch (error) {
    if (isMissing(error)) return emptyCanvasWorkspace()
    if (error instanceof CanvasWorkspaceError) throw error
    throw new CanvasWorkspaceError(409, 'invalid_saved_workspace', 'Canvas state could not be read; the saved file was not changed.')
  }
}

/** Uses the same lock as session deletion; never recreates a deleted session. */
export async function accessCanvasWorkspace(input: {
  workspacePath: string
  sessionId: string
  sessionStore: Pick<SessionStore, 'getSession'>
  action?: CanvasAction
  signal: AbortSignal
}): Promise<CanvasWorkspace> {
  const { workspacePath, sessionId, sessionStore, action, signal } = input
  if (!isValidSessionId(sessionId)) throw new CanvasWorkspaceError(400, 'invalid_session', 'Invalid session id')
  const sessionsPath = path.join(workspacePath, 'sessions')
  await canvasSessionDirectory(workspacePath, sessionId)
  const lockPath = path.join(sessionsPath, '.locks', `${sessionId}.lock`)
  return withFileLock(lockPath, async () => {
    signal.throwIfAborted()
    const directory = await canvasSessionDirectory(workspacePath, sessionId)
    if (!await sessionStore.getSession(sessionId)) throw new CanvasWorkspaceError(404, 'session_not_found', 'Session not found')
    const file = path.join(directory, CANVAS_STORE_FILENAME)
    const state = await readSaved(file)
    if (!action) return state
    const result = applyCanvasAction(state, action)
    if (!result.ok) throw new CanvasWorkspaceError(409, result.reason, 'Canvas tab limit reached; close a tab first.')
    const next = result.workspace
    if (next !== state) {
      const serialized = JSON.stringify(next)
      if (Buffer.byteLength(serialized, 'utf8') > CANVAS_MAX_STORE_BYTES) {
        throw new CanvasWorkspaceError(409, 'workspace_size_limit', 'Canvas saved-state limit reached; close a tab first.')
      }
      signal.throwIfAborted()
      await writeFileAtomic(file, serialized)
    }
    return next
  })
}
