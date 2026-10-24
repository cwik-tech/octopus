import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import { canvasDocumentAggregateSchema, CANVAS_DOCUMENT_MAX_BYTES, CANVAS_DOCUMENT_STORE_MAX_BYTES, type CanvasDocumentAggregate } from '../contracts/canvas-documents.js'
import { canvasTabKey, type CanvasTab } from '../contracts/canvas-workspace.js'
import { writeFileAtomic } from '../core/file-mutation.js'
import { withFileLock } from '../domains/sessions/session-file-locks.js'
import { canvasSessionDirectory, CanvasWorkspaceError } from './canvas-workspace-store.js'
import type { SessionStore } from '../domains/sessions/session-store.js'

export const canvasDigest = (bytes: Uint8Array | string): string => crypto.createHash('sha256').update(bytes).digest('hex')
export const canvasDocumentId = (target: CanvasTab): string => canvasDigest(canvasTabKey(target))
export function canvasDocumentError(code: string, message: string, statusCode = 409): CanvasWorkspaceError { return new CanvasWorkspaceError(statusCode, code, message) }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }

async function containedDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(await fs.realpath(parent), name)
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw canvasDocumentError('unsafe_document_store', 'Canvas document storage is not contained.')
  return directory
}

export async function readCanvasBytes(file: string, maxBytes: number, unavailable: string, changed: string): Promise<Buffer> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw canvasDocumentError(changed, 'Canvas content is unavailable or exceeds its size limit.')
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) throw canvasDocumentError(changed, 'Canvas content exceeds its size limit.')
    return bytes
  } catch (error) {
    if (error instanceof CanvasWorkspaceError) throw error
    throw canvasDocumentError(missing(error) ? unavailable : changed, 'Canvas content could not be read safely.')
  } finally { await handle?.close() }
}

export async function verifyCanvasSnapshot(directory: string, digest: string): Promise<void> {
  const snapshots = path.join(directory, 'snapshots')
  try {
    const stat = await fs.lstat(snapshots)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(snapshots) !== snapshots) throw canvasDocumentError('snapshot_changed', 'The retained snapshot directory changed. Editing is blocked.')
  } catch (error) {
    if (error instanceof CanvasWorkspaceError) throw error
    throw canvasDocumentError(missing(error) ? 'snapshot_unavailable' : 'snapshot_changed', 'The retained snapshot directory is unavailable.')
  }
  const bytes = await readCanvasBytes(path.join(snapshots, digest), CANVAS_DOCUMENT_MAX_BYTES, 'snapshot_unavailable', 'snapshot_changed')
  if (canvasDigest(bytes) !== digest) throw canvasDocumentError('snapshot_changed', 'The retained original changed. Editing is blocked.')
}

export async function retainCanvasSnapshot(directory: string, bytes: Buffer, digest: string): Promise<void> {
  const snapshots = await containedDirectory(directory, 'snapshots')
  const file = path.join(snapshots, digest)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(file, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  } finally { await handle?.close() }
  const parent = await fs.open(snapshots, 'r')
  try { await parent.sync() } finally { await parent.close() }
  await verifyCanvasSnapshot(directory, digest)
}

export async function mutateCanvasDocument<T>(input: { workspacePath: string; sessionId: string; sessionStore: Pick<SessionStore, 'getSession'>; target: CanvasTab; signal: AbortSignal }, operation: (saved: CanvasDocumentAggregate | null, directory: string) => Promise<{ aggregate: CanvasDocumentAggregate; result: T }>): Promise<T> {
  await canvasSessionDirectory(input.workspacePath, input.sessionId)
  return withFileLock(path.join(input.workspacePath, 'sessions', '.locks', `${input.sessionId}.lock`), async () => {
    input.signal.throwIfAborted()
    const sessionDirectory = await canvasSessionDirectory(input.workspacePath, input.sessionId)
    if (!await input.sessionStore.getSession(input.sessionId)) throw canvasDocumentError('session_not_found', 'Session not found.', 404)
    const directory = await containedDirectory(sessionDirectory, 'canvas-documents')
    const id = canvasDocumentId(input.target)
    const file = path.join(directory, `${id}.json`)
    let saved: CanvasDocumentAggregate | null = null
    try {
      const bytes = await readCanvasBytes(file, CANVAS_DOCUMENT_STORE_MAX_BYTES, 'document_not_found', 'invalid_saved_document')
      const raw: unknown = JSON.parse(bytes.toString('utf8'))
      saved = canvasDocumentAggregateSchema.parse(raw)
      if (saved.document.id !== id || saved.document.sessionId !== input.sessionId || canvasTabKey(saved.document.origin) !== canvasTabKey(input.target)) throw canvasDocumentError('invalid_saved_document', 'Canvas document identity is invalid.')
    } catch (error) {
      if (!(error instanceof CanvasWorkspaceError && error.code === 'document_not_found')) {
        if (error instanceof CanvasWorkspaceError) throw error
        throw canvasDocumentError('invalid_saved_document', 'Canvas document is corrupt; its saved state was not changed.')
      }
    }
    const next = await operation(saved, directory)
    input.signal.throwIfAborted()
    if (next.aggregate !== saved) {
      const validated = canvasDocumentAggregateSchema.safeParse(next.aggregate)
      const serialized = JSON.stringify(next.aggregate)
      if (!validated.success || Buffer.byteLength(serialized) > CANVAS_DOCUMENT_STORE_MAX_BYTES || Buffer.byteLength(next.aggregate.document.content) > CANVAS_DOCUMENT_MAX_BYTES) throw canvasDocumentError('document_size_limit', 'Canvas document exceeds its size limit.')
      await writeFileAtomic(file, serialized)
    }
    return next.result
  })
}
