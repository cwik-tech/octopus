import { sessionWorkClosed } from '../domains/sessions/session-work-lifecycle.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { OFFICE_BLOB_DIRECTORY, OFFICE_BLOB_QUOTA_BYTES, OFFICE_DOCUMENT_DIRECTORY, OFFICE_INPUT_MAX_BYTES, OFFICE_METADATA_MAX_BYTES, officeDigestSchema, officeDocumentSchema, type OfficeDocument, type OfficeDocumentResult, type OfficeFailure, type OfficeFormat } from '../contracts/office-documents.js'
import { canvasTabKey, type CanvasTab } from '../contracts/canvas-workspace.js'
import { withFileLock } from '../domains/sessions/session-file-locks.js'
import { canvasSessionDirectory, CanvasWorkspaceError } from './canvas-workspace-store.js'
import { captureOfficeSource, readOfficeFile, type OfficeSourceInput } from './office-preview-source.js'
export type OfficeDocumentScope = Omit<OfficeSourceInput, 'target'>
export const officeDigest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
export const officeDocumentId = (target: CanvasTab): string => officeDigest(canvasTabKey(target))
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

export async function createOfficeDocument(input: OfficeSourceInput): Promise<OfficeDocumentResult> {
  return withOfficeDocument<OfficeDocumentResult>({ ...input, documentId: officeDocumentId(input.target) }, async (saved, directory) => {
    if (saved) return { next: saved, result: { ok: true, document: saved } }
    const source = await captureOfficeSource(input)
    if (!source.ok) return { next: null, result: source }
    const messages = await input.sessionStore.listChatMessages(input.sessionId)
    const digests = new Set<string>()
    for (const message of messages) {
      const delivery = message.delivery
      if (!delivery) continue
      const matches = delivery.artifacts.filter((artifact) => artifact.runId === input.target.runId && artifact.path === input.target.artifactPath)
      if (matches.length === 0) continue
      for (const artifact of matches) if (artifact.digest) digests.add(artifact.digest.toLowerCase())
      if (delivery.executionAttemptId) {
        const publication = await input.sessionStore.resolveTaskPublication(input.sessionId, delivery.taskId, delivery.executionAttemptId)
        if (publication.status === 'ready') {
          for (const artifact of publication.artifacts) {
            if (artifact.childRunId === input.target.runId && artifact.path === input.target.artifactPath) digests.add(artifact.sha256.toLowerCase())
          }
        }
      }
    }
    if (digests.size !== 1 || !digests.has(source.digest)) return { next: null, result: { ok: false, code: 'origin_unverifiable' } }
    const retained = await retainOfficeBlob(directory, source.bytes, input.signal)
    if (!retained.ok) return { next: null, result: retained }
    const document = officeDocumentSchema.parse({ schemaVersion: 1, id: officeDocumentId(input.target), sessionId: input.sessionId, origin: input.target, originalDigest: retained.digest, format: source.format, revision: 0, revisions: [{ revision: 0, digest: retained.digest }] })
    return { next: document, result: { ok: true, document } }
  }, true)
}

export async function getOfficeDocument(input: OfficeDocumentScope & { documentId: string }): Promise<OfficeDocumentResult> {
  return withOfficeDocument<OfficeDocumentResult>(input, async (saved) => ({ next: saved, result: saved ? { ok: true, document: saved } : { ok: false, code: 'document_not_found' } }))
}

export async function readOfficeRevision(input: OfficeDocumentScope & { documentId: string; revision: number | 'original' }): Promise<{ ok: true; bytes: Buffer; format: OfficeFormat; name: string; digest: string } | OfficeFailure> {
  return withOfficeDocument<{ ok: true; bytes: Buffer; format: OfficeFormat; name: string; digest: string } | OfficeFailure>(input, async (saved, directory) => {
    const digest = input.revision === 'original' ? saved?.originalDigest : saved?.revisions.find((revision) => revision.revision === input.revision)?.digest
    if (!saved || !digest) return { next: saved, result: { ok: false, code: 'document_not_found' } }
    const bytes = await readOfficeBlob(directory, digest, input.signal)
    if (!bytes.ok) return { next: saved, result: bytes }
    return { next: saved, result: { ok: true, bytes: bytes.bytes, digest, format: saved.format, name: saved.source ? `${path.basename(saved.origin.artifactPath, path.extname(saved.origin.artifactPath))}.${saved.format}` : path.basename(saved.origin.artifactPath) } }
  })
}

/** Shares the session deletion lock; no converter/provider runs inside it. */
export async function withOfficeDocument<T>(input: OfficeDocumentScope & { documentId: string }, operation: (saved: OfficeDocument | null, directory: string) => Promise<{ next: OfficeDocument | null; result: T }>, create = false): Promise<T | OfficeFailure> {
  if (!officeDigestSchema.safeParse(input.documentId).success) return { ok: false, code: 'document_not_found' }
  try {
    await canvasSessionDirectory(input.workspacePath, input.sessionId)
    return await withFileLock(path.join(input.workspacePath, 'sessions', '.locks', `${input.sessionId}.lock`), async () => {
      input.signal.throwIfAborted()
      if (sessionWorkClosed(input.workspacePath, input.sessionId)) return { ok: false, code: 'cancelled' }
      const session = await canvasSessionDirectory(input.workspacePath, input.sessionId)
      if (!await input.sessionStore.getSession(input.sessionId)) return { ok: false, code: 'document_not_found' }
      const directory = path.join(session, OFFICE_DOCUMENT_DIRECTORY)
      if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
      if (await fs.realpath(directory) !== directory || (await fs.lstat(directory)).isSymbolicLink()) return { ok: false, code: 'invalid_saved_document' }
      const file = path.join(directory, `${input.documentId}.json`)
      let saved: OfficeDocument | null = null
      try {
        const raw: unknown = JSON.parse((await readOfficeFile(file, OFFICE_METADATA_MAX_BYTES, input.signal)).toString('utf8'))
        const parsed = officeDocumentSchema.safeParse(raw)
        if (!parsed.success || parsed.data.id !== input.documentId || parsed.data.sessionId !== input.sessionId || officeDocumentId(parsed.data.origin) !== input.documentId || !parsed.data.revisions.every((revision, index) => revision.revision === index) || parsed.data.revision !== parsed.data.revisions.length - 1 || parsed.data.revisions[0]?.digest !== parsed.data.originalDigest) return { ok: false, code: 'invalid_saved_document' }
        saved = parsed.data
      } catch (error) {
        if (!absent(error)) return { ok: false, code: 'invalid_saved_document' }
      }
      const change = await operation(saved, directory)
      if (change.next && change.next !== saved) {
        const next = officeDocumentSchema.safeParse(change.next)
        if (!next.success) return { ok: false, code: 'invalid_saved_document' }
        const serialized = JSON.stringify(next.data)
        if (Buffer.byteLength(serialized) > OFFICE_METADATA_MAX_BYTES) return { ok: false, code: 'storage_limit' }
        await writeOfficeMetadata(file, serialized, input.signal)
      }
      return change.result
    })
  } catch (error) {
    if (input.signal.aborted) return { ok: false, code: 'cancelled' }
    if (absent(error) || error instanceof CanvasWorkspaceError) return { ok: false, code: 'document_not_found' }
    throw error
  }
}

export async function retainOfficeBlob(directory: string, bytes: Buffer, signal: AbortSignal): Promise<{ ok: true; digest: string } | OfficeFailure> {
  if (bytes.length > OFFICE_INPUT_MAX_BYTES) return { ok: false, code: 'storage_limit' }
  const blobs = path.join(directory, OFFICE_BLOB_DIRECTORY)
  await fs.mkdir(blobs, { mode: 0o700 }).catch((error: unknown) => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error })
  if (await fs.realpath(blobs) !== blobs) return { ok: false, code: 'invalid_saved_document' }
  const digest = officeDigest(bytes)
  const existing = await readOfficeBlob(directory, digest, signal)
  if (existing.ok) return { ok: true, digest }
  if (existing.code !== 'document_not_found') return existing
  let total = 0
  for (const name of await fs.readdir(blobs)) {
    if (!officeDigestSchema.safeParse(name).success) return { ok: false, code: 'invalid_saved_document' }
    const stat = await fs.lstat(path.join(blobs, name))
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, code: 'invalid_saved_document' }
    total += stat.size
  }
  if (total + bytes.length > OFFICE_BLOB_QUOTA_BYTES) return { ok: false, code: 'storage_limit' }
  signal.throwIfAborted()
  const handle = await fs.open(path.join(blobs, digest), 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  const parent = await fs.open(blobs, 'r')
  try { await parent.sync() } finally { await parent.close() }
  return { ok: true, digest }
}

export async function readOfficeBlob(directory: string, digest: string, signal: AbortSignal): Promise<{ ok: true; bytes: Buffer } | OfficeFailure> {
  if (!officeDigestSchema.safeParse(digest).success) return { ok: false, code: 'invalid_saved_document' }
  const blobs = path.join(directory, OFFICE_BLOB_DIRECTORY)
  try {
    if (await fs.realpath(blobs) !== blobs) return { ok: false, code: 'invalid_saved_document' }
    const bytes = await readOfficeFile(path.join(blobs, digest), OFFICE_INPUT_MAX_BYTES, signal)
    return officeDigest(bytes) === digest ? { ok: true, bytes } : { ok: false, code: 'invalid_saved_document' }
  } catch (error) {
    if (absent(error)) return { ok: false, code: 'document_not_found' }
    if (signal.aborted) return { ok: false, code: 'cancelled' }
    return { ok: false, code: 'invalid_saved_document' }
  }
}

async function writeOfficeMetadata(file: string, serialized: string, signal: AbortSignal): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(serialized); await handle.sync() } finally { await handle.close() }
    signal.throwIfAborted()
    await fs.rename(temporary, file)
    const parent = await fs.open(path.dirname(file), 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally { await fs.rm(temporary, { force: true }) }
}
