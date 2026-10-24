import { createHash } from 'node:crypto'
import { documentSourceSchema, pdfPageIndexSchema, type DocumentSource } from '../contracts/document-reference.js'
import type { SessionFile } from '../contracts/sessions.js'
import type { SessionStore } from '../domains/sessions/session-store.js'
import { escapeFileContext } from './session-chat-file-context.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FileParserLauncher } from '../core/file-parser-launcher.js'
import { isSafePathSegment, resolveExistingPathInside } from '../core/path-safety.js'
import { parseDocumentCopy } from '../domains/document-access/copied-document-parser.js'
import type { WorkspaceProjectContextSelection } from '../contracts/projects.js'
import type { WorkspaceProjectContextStore } from '../domains/projects/project-context-store.js'
import type { ChatMessage } from '../contracts/sessions.js'
import { readDeliveryArtifactExcerpt, type DeliveryArtifactReader } from './delivery-context.js'
import { createDocumentSource } from '../domains/document-access/document-source.js'
import { estimateContextTokens } from '../core/context-tokens.js'
import type { ModelImage } from '../contracts/model-image.js'

/** Selection membership is checked by the chat/admission boundary before this reader. */
export async function captureProjectDocuments(input: { selection: WorkspaceProjectContextSelection; store: WorkspaceProjectContextStore; parserLauncher?: FileParserLauncher; signal?: AbortSignal }): Promise<DocumentSource[]> {
  const documents: DocumentSource[] = []
  if (input.selection.includeBrief) {
    const brief = await input.store.readBrief(input.selection.projectId)
    if (brief) documents.push(createDocumentSource({ owner: input.selection.projectId, name: 'Project brief', text: brief.content, revisionKey: brief.updatedAt }))
  }
  for (const name of [...new Set(input.selection.fileNames)].sort()) {
    input.signal?.throwIfAborted()
    const bytes = await input.store.readFile(input.selection.projectId, name)
    if (!bytes) throw new Error('Selected project document is unavailable')
    const plain = new Set(['.md', '.txt', '.csv', '.json']).has(path.extname(name).toLowerCase())
    const parsed = !plain && input.parserLauncher ? await parseDocumentCopy({ name, contents: bytes, launcher: input.parserLauncher, ...(input.signal ? { signal: input.signal } : {}) }) : undefined
    documents.push(createDocumentSource({ owner: input.selection.projectId, name, text: plain ? bytes.toString('utf8') : parsed?.text ?? null, revisionKey: createHash('sha256').update(bytes).digest('hex'), ...(parsed?.pages ? { pages: parsed.pages } : {}) }))
  }
  return documents
}

export async function captureDeliveryDocuments(input: { sessionId: string; history: readonly ChatMessage[]; readArtifact?: DeliveryArtifactReader; signal?: AbortSignal }): Promise<DocumentSource[]> {
  if (!input.readArtifact) return []
  const documents = new Map<string, DocumentSource>()
  for (const message of input.history) for (const artifact of message.delivery?.artifacts ?? []) {
    input.signal?.throwIfAborted()
    const captured = await readDeliveryArtifactExcerpt(artifact, input.readArtifact)
    const source = createDocumentSource({ owner: `${input.sessionId}/${artifact.runId}`, name: artifact.title ?? path.basename(artifact.path), text: 'text' in captured ? captured.text : null, revisionKey: `${artifact.path}\0${artifact.digest ?? ''}` })
    documents.set(source.id, source)
  }
  return [...documents.values()]
}

/** Capture full parsed sources once; tools read this admitted revision, never later live files. */
export async function captureSessionDocuments(input: {
  readonly sessionId: string
  readonly files: readonly SessionFile[]
  readonly sessionStore: Pick<SessionStore, 'readParsedText'>
  readonly signal?: AbortSignal
  readonly sourceRoot?: string
  readonly parserLauncher?: FileParserLauncher
  readonly requirePageIndex?: boolean
}): Promise<DocumentSource[]> {
  const documents: DocumentSource[] = []
  for (const file of input.files) {
    input.signal?.throwIfAborted()
    let text = file.outputs?.text
      ? await input.sessionStore.readParsedText(input.sessionId, file.outputs.text)
      : null
    input.signal?.throwIfAborted()
    const pageIndexText = file.outputs?.parse ? await input.sessionStore.readParsedText(input.sessionId, file.outputs.parse) : null
    const pageIndex = pageIndexText ? pdfPageIndexSchema.safeParse(JSON.parse(pageIndexText)) : undefined
    let pages = pageIndex?.success ? pageIndex.data.pages : undefined
    let image: ModelImage | undefined
    if (input.parserLauncher && input.sourceRoot && (text === null || input.requirePageIndex && path.extname(file.name).toLowerCase() === '.pdf' && !pages)) {
      const target = path.join(input.sourceRoot, file.name)
      if (!isSafePathSegment(file.name) || !resolveExistingPathInside(input.sourceRoot, target)) throw new Error('Admitted document original is not contained')
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtime.toISOString() !== file.uploadedAt) throw new Error('Admitted document original revision changed')
      const parsedCopy = await parseDocumentCopy({ name: file.name, contents: await fs.readFile(target), launcher: input.parserLauncher, ...(input.signal ? { signal: input.signal } : {}) })
      text = parsedCopy.text
      pages = parsedCopy.pages
      image = parsedCopy.image
    }
    const revision = createHash('sha256').update(JSON.stringify({ text: text ?? `${file.name}\0${file.uploadedAt}`, pages, image })).digest('hex')
    const identity = createHash('sha256').update(`${input.sessionId}\0${file.name}\0${file.uploadedAt}\0${revision}`).digest('hex')
    documents.push(documentSourceSchema.parse({ id: `doc_${identity}`, name: file.name, revision, text, uploadedAt: file.uploadedAt, ...(pages ? { pages } : {}), ...(image ? { image } : {}) }))
  }
  return documents
}

export function renderDocumentManifest(documents: readonly DocumentSource[]): string {
  if (documents.length === 0) return ''
  const manifest = documents.map((document) => ({
    id: document.id, name: document.name, revision: document.revision,
    characters: document.text?.length ?? 0,
    status: document.image ? 'image available; use document_read to view it' : document.text === null ? 'content unavailable' : 'full parsed source available',
    review: 'coverage unknown',
    pages: document.pages?.length ?? 'unknown',
  }))
  const selected: typeof manifest = []
  const render = () => [
    `Admitted documents: ${documents.length}. Use document_list with cursor=${selected.length} for references beyond this bounded manifest; use document_search or document_read to reach content beyond excerpts. Reading an excerpt or searching is not whole-document review.`,
    '<document_manifest trust="untrusted_user_metadata">',
    escapeFileContext(JSON.stringify(selected)),
    '</document_manifest>',
  ].join('\n')
  for (const entry of manifest) {
    selected.push(entry)
    if (estimateContextTokens(render()) > 2_000) { selected.pop(); break }
  }
  return render()
}
