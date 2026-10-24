import { beginSessionWork, observeSessionWorkClosing, sessionWorkClosed } from '../domains/sessions/session-work-lifecycle.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { OFFICE_PROFILE, type OfficeFailure, type OfficePreview, type OfficeFormat } from '../contracts/office-documents.js'
import { captureOfficeSource, type OfficeSourceInput } from './office-preview-source.js'
import { resolveOfficeBinary } from './officecli-binary-resolver.js'
import { runOfficeProcess, officeJobCleanupPending } from './officecli-process.js'
import { assembleOfficeHtml } from './office-preview-html.js'
import { OfficePreviewJobs } from './office-preview-jobs.js'
import type { OfficeDocumentScope } from './canvas-office-document-store.js'

const jobs = new OfficePreviewJobs()
observeSessionWorkClosing((scope) => jobs.invalidate(scope))

export async function renderOfficePreview(input: OfficeSourceInput & { readonly repoRoot: string }): Promise<OfficePreview | OfficeFailure> {
  const source = await captureOfficeSource(input)
  if (!source.ok) return source
  return renderOfficeBytes({ ...input, source })
}

export async function renderOfficeBytes(input: OfficeDocumentScope & { readonly repoRoot: string; readonly source: { bytes: Buffer; format: OfficeFormat; digest: string } }): Promise<OfficePreview | OfficeFailure> {
  if (sessionWorkClosed(input.workspacePath, input.sessionId)) return { ok: false, code: 'cancelled' }
  const { source } = input
  const executable = await resolveOfficeBinary(input.repoRoot, input.signal)
  if (!executable) return { ok: false, code: 'capability_unavailable' }
  const scope = JSON.stringify([path.resolve(input.workspacePath), input.sessionId])
  if (!await input.sessionStore.getSession(input.sessionId) || sessionWorkClosed(input.workspacePath, input.sessionId)) return { ok: false, code: 'foreign_origin' }
  return jobs.get(scope, JSON.stringify([source.digest, executable, OFFICE_PROFILE]), input.signal, async (signal) => {
    const work = beginSessionWork(input.workspacePath, input.sessionId, signal)
    if (!work) return { ok: false, code: 'cancelled' }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-office-'))
    signal = work.signal
    try {
    const file = path.join(directory, `source.${source.format}`)
    await fs.writeFile(file, source.bytes, { mode: 0o600 })
    const result = await runOfficeProcess({ executable, args: ['view', file, 'html'], directory, signal, lifetime: { workspacePath: input.workspacePath, sessionId: input.sessionId } })
    if (!result.ok) return result
    const current = await fs.readFile(file)
    if (createHash('sha256').update(current).digest('hex') !== source.digest) return { ok: false, code: 'invalid_output' }
    if (!await input.sessionStore.getSession(input.sessionId)) return { ok: false, code: 'foreign_origin' }
    signal.throwIfAborted()
    return assembleOfficeHtml(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout), source.digest)
    } finally { try { if (!officeJobCleanupPending(directory)) await fs.rm(directory, { recursive: true, force: true }) } finally { work.finish() } }
  })
}
