import type { CanvasTab } from '../contracts/canvas-workspace.js'
import type { OfficeFailure, OfficeFormat } from '../contracts/office-documents.js'
import type { SessionStore } from '../domains/sessions/session-store.js'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { officeFormatSchema, OFFICE_INPUT_MAX_BYTES } from '../contracts/office-documents.js'
import { canvasTabSchema } from '../contracts/canvas-workspace.js'
import { inspectOfficePackage } from '../core/office-package.js'
import { resolveRunAssignmentLocation } from '../domains/run/run-location.js'
import { canvasSessionDirectory } from './canvas-workspace-store.js'

export interface OfficeSourceInput {
  readonly workspacePath: string
  readonly sessionId: string
  readonly sessionStore: Pick<SessionStore, 'getSession' | 'listChatMessages' | 'resolveTaskPublication'>
  readonly target: CanvasTab
  readonly signal: AbortSignal
}
export type OfficeSourceResult = { readonly ok: true; readonly bytes: Buffer; readonly digest: string; readonly format: OfficeFormat } | OfficeFailure
export async function captureOfficeSource(input: OfficeSourceInput): Promise<OfficeSourceResult> {
  const target = canvasTabSchema.safeParse(input.target)
  if (!target.success || target.data.artifactPath.split('/').some((part) => part.startsWith('.'))) return { ok: false, code: 'foreign_origin' }
  const format = officeFormatSchema.safeParse(path.extname(target.data.artifactPath).slice(1).toLowerCase())
  if (!format.success) return { ok: false, code: 'unsafe_package' }
  input.signal.throwIfAborted()
  try {
    await canvasSessionDirectory(input.workspacePath, input.sessionId)
    if (!await input.sessionStore.getSession(input.sessionId)) return { ok: false, code: 'foreign_origin' }
    const messages = await input.sessionStore.listChatMessages(input.sessionId)
    if (!messages.some((message) => message.delivery?.artifacts.some((artifact) => artifact.runId === target.data.runId && artifact.path === target.data.artifactPath))) return { ok: false, code: 'foreign_origin' }
    const location = resolveRunAssignmentLocation(input.workspacePath, target.data.runId)
    if (!location) return { ok: false, code: 'origin_unavailable' }
    const file = path.join(location.assignmentPath, target.data.artifactPath)
    if (await fs.realpath(file) !== file) return { ok: false, code: 'origin_unavailable' }
    const bytes = await readOfficeFile(file, OFFICE_INPUT_MAX_BYTES, input.signal)
    if (await fs.realpath(file) !== file) return { ok: false, code: 'origin_unavailable' }
    const inspected = inspectOfficePackage(bytes, format.data)
    if (!inspected.ok) return inspected
    return { ok: true, bytes, digest: createHash('sha256').update(bytes).digest('hex'), format: format.data }
  } catch (error) {
    if (input.signal.aborted) return { ok: false, code: 'cancelled' }
    if (error instanceof Error) return { ok: false, code: 'origin_unavailable' }
    throw error
  }
}

/** Reads at most limit+1 bytes, including a file that grows after its stat. */
export async function readOfficeFile(file: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit) throw new Error('Office input exceeds its byte limit.')
    const bytes = Buffer.alloc(Math.min(limit, before.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const after = await fs.lstat(file)
    if (offset > limit || !after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== offset) throw new Error('Office input changed during capture.')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}
