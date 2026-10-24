import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { canvasDocumentAggregateSchema, CANVAS_DOCUMENT_STORE_MAX_BYTES } from '../contracts/canvas-documents.js'
import { OFFICE_INPUT_MAX_BYTES, OFFICE_MAX_REVISIONS, officeDocumentSchema, type OfficeDocument, type OfficeFailure } from '../contracts/office-documents.js'
import { generateWordBuffer } from '../domains/word-generation/generate-word.js'
import { beginSessionWork } from '../domains/sessions/session-work-lifecycle.js'
import { resolveRunAssignmentLocation } from '../domains/run/run-location.js'
import { accessCanvasDocument, type CanvasDocumentInput } from './canvas-document-service.js'
import { canvasDocumentId } from './canvas-document-store.js'
import { canvasSessionDirectory } from './canvas-workspace-store.js'
import { getOfficeDocument, officeDocumentId, officeDigest, retainOfficeBlob, withOfficeDocument } from './canvas-office-document-store.js'
import { readOfficeFile } from './office-preview-source.js'
import { inspectOfficePackage } from '../core/office-package.js'
export type WordSnapshotResult = { ok: true; document: OfficeDocument; stale: boolean } | OfficeFailure
const nodeSchema = z.object({ type: z.string(), url: z.string().optional(), identifier: z.string().optional(), children: z.array(z.unknown()).optional() })

export async function getWordSnapshot(input: CanvasDocumentInput): Promise<WordSnapshotResult> {
  const saved = await getOfficeDocument({ ...input, documentId: officeDocumentId(input.target) })
  if (!saved.ok) return saved
  const markdown = await accessCanvasDocument(input)
  return { ...saved, stale: saved.document.source?.revision !== markdown.revision }
}

export async function createWordSnapshot(input: CanvasDocumentInput & { expectedRevision: number }): Promise<WordSnapshotResult> {
  const work = beginSessionWork(input.workspacePath, input.sessionId, input.signal)
  if (!work) return { ok: false, code: 'cancelled' }
  const signal = work.signal
  let directory: string | undefined
  try {
    const source = await accessCanvasDocument({ ...input, signal })
    if (source.revision !== input.expectedRevision) return { ok: false, code: 'revision_conflict' }
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'octopus-word-source-'))
    const assetRoot = path.join(directory, 'assets')
    await fs.mkdir(assetRoot, { mode: 0o700 })
    const captured = await captureAssets(input, source.content, assetRoot, signal)
    if (!captured.ok) return captured
    const generated = await generateWordBuffer(source.content, { profile: 'business-report', sourceDirectory: assetRoot, renderMermaid: false, mermaidFailure: 'keep-code', signal })
    signal.throwIfAborted()
    if (generated.buffer.length > OFFICE_INPUT_MAX_BYTES) return { ok: false, code: 'storage_limit' }
    const inspected = inspectOfficePackage(generated.buffer, 'docx')
    if (!inspected.ok) return inspected
    const sourceInfo = { target: input.target, revision: source.revision, digest: officeDigest(source.content), assets: captured.assets.map((asset) => ({ path: asset.path, digest: officeDigest(asset.bytes) })), profile: 'business-report' as const, mermaid: 'keep-code' as const, notices: [...generated.warnings.map((warning) => warning.slice(0, 500)), 'Mermaid diagrams remain code; external images are links.'].slice(0, 128), forked: false }
    return await withOfficeDocument<WordSnapshotResult>({ ...input, signal, documentId: officeDocumentId(input.target) }, async (saved, storage) => {
      if (saved?.proposal?.status === 'generating' || saved?.proposal?.status === 'ready') return { next: saved, result: { ok: false, code: 'proposal_busy' } }
      if (saved && saved.revisions.length >= OFFICE_MAX_REVISIONS) return { next: saved, result: { ok: false, code: 'storage_limit' } }
      // Both document stores use this session lock. Recheck the source at the
      // actual publication point without recursively acquiring that lock.
      const session = await canvasSessionDirectory(input.workspacePath, input.sessionId)
      const sourceFile = path.join(session, 'canvas-documents', `${canvasDocumentId(input.target)}.json`)
      if (await fs.realpath(path.dirname(sourceFile)) !== path.dirname(sourceFile)) return { next: saved, result: { ok: false, code: 'invalid_saved_document' } }
      const raw: unknown = JSON.parse((await readOfficeFile(sourceFile, CANVAS_DOCUMENT_STORE_MAX_BYTES, signal)).toString('utf8'))
      const current = canvasDocumentAggregateSchema.parse(raw).document
      if (current.id !== source.id || current.sessionId !== input.sessionId) return { next: saved, result: { ok: false, code: 'foreign_origin' } }
      for (const asset of captured.assets) {
        const retained = await retainOfficeBlob(storage, asset.bytes, signal)
        if (!retained.ok) return { next: saved, result: retained }
      }
      const binary = await retainOfficeBlob(storage, generated.buffer, signal)
      if (!binary.ok) return { next: saved, result: binary }
      const revision = saved ? saved.revision + 1 : 0
      const entry = { revision, digest: binary.digest, source: sourceInfo }
      const document = officeDocumentSchema.parse(saved ? { ...saved, revision, source: sourceInfo, proposal: null, revisions: [...saved.revisions, entry] } : { schemaVersion: 1, id: officeDocumentId(input.target), sessionId: input.sessionId, origin: input.target, originalDigest: binary.digest, format: 'docx', revision, revisions: [entry], source: sourceInfo })
      return { next: document, result: { ok: true, document, stale: current.revision !== source.revision } }
    }, true)
  } finally { try { if (directory) await fs.rm(directory, { recursive: true, force: true }) } finally { work.finish() } }
}

async function captureAssets(input: CanvasDocumentInput, content: string, directory: string, signal: AbortSignal): Promise<{ ok: true; assets: { path: string; bytes: Buffer }[] } | OfficeFailure> {
  const tree: unknown = unified().use(remarkParse).use(remarkGfm).parse(content)
  const urls = new Set<string>()
  const definitions = new Map<string, string>()
  const references: string[] = []
  function visit(value: unknown): void {
    const node = nodeSchema.parse(value)
    if (node.type === 'image' && node.url) urls.add(node.url)
    if (node.type === 'definition' && node.url && node.identifier) definitions.set(node.identifier.toLowerCase(), node.url)
    if (node.type === 'imageReference' && node.identifier) references.push(node.identifier.toLowerCase())
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  for (const reference of references) { const url = definitions.get(reference); if (url) urls.add(url) }
  if (urls.size > 128) return { ok: false, code: 'storage_limit' }
  const location = resolveRunAssignmentLocation(input.workspacePath, input.target.runId)
  const assets: { path: string; bytes: Buffer }[] = []
  let total = 0
  for (const url of urls) {
    signal.throwIfAborted()
    if (/^https?:\/\//i.test(url)) continue
    if (/^data:/i.test(url)) { total += Buffer.byteLength(url); if (total > OFFICE_INPUT_MAX_BYTES) return { ok: false, code: 'storage_limit' }; continue }
    let relative: string
    try { relative = decodeURIComponent(url) } catch { return { ok: false, code: 'unsafe_package' } }
    if (!location || !relative || /[\\:\x00-\x1f]/.test(relative) || relative.split('/').some((part) => !part || part.startsWith('.')) || !/\.(png|jpe?g|gif|bmp)$/i.test(relative)) return { ok: false, code: 'unsafe_package' }
    const file = path.join(location.assignmentPath, path.dirname(input.target.artifactPath), relative)
    try {
      if (await fs.realpath(file) !== file) return { ok: false, code: 'origin_unavailable' }
      const bytes = await readOfficeFile(file, 2 * 1024 * 1024, signal)
      total += bytes.length
      if (total > OFFICE_INPUT_MAX_BYTES) return { ok: false, code: 'storage_limit' }
      const staged = path.join(directory, relative)
      await fs.mkdir(path.dirname(staged), { recursive: true, mode: 0o700 })
      await fs.writeFile(staged, bytes, { mode: 0o600 })
      assets.push({ path: relative, bytes })
    } catch { return { ok: false, code: signal.aborted ? 'cancelled' : 'origin_unavailable' } }
  }
  return { ok: true, assets }
}
