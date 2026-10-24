import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as z from 'zod/v4'
import { documentSourceSchema, pdfPageIndexSchema, type DocumentSource } from '../contracts/document-reference.js'
import { isSafePathSegment, resolveExistingPathInside } from '../core/path-safety.js'
import type { FileParserLauncher } from '../core/file-parser-launcher.js'
import { parseDocumentCopy } from '../domains/document-access/copied-document-parser.js'

const snapshotSchema = z.object({ files: z.array(z.object({ path: z.string(), kind: z.enum(['input', 'parsed']), sha256: z.string().regex(/^[a-f0-9]{64}$/), uploadedAt: z.string().optional() })), projectContext: z.object({ path: z.literal('project-context/manifest.json'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() })
const parserManifestSchema = z.object({ files: z.array(z.object({ source: z.string(), status: z.string(), outputs: z.object({ text: z.string().optional(), parse: z.string().optional() }).optional() })) })
const projectSchema = z.object({ brief: z.object({ relativePath: z.string(), sha256: z.string() }).optional(), files: z.array(z.object({ name: z.string(), relativePath: z.string(), sha256: z.string() })) })
const textExtensions = new Set(['.md', '.txt', '.csv', '.json'])

/** The caller supplies a run root already resolved by the existing worker authority. */
export async function readSnapshotDocuments(input: { readonly runPath: string; readonly runId: string; readonly signal?: AbortSignal; readonly parserLauncher?: FileParserLauncher; readonly requirePageIndex?: boolean }): Promise<DocumentSource[]> {
  const root = path.join(input.runPath, 'input-snapshot')
  try { await fs.access(path.join(root, 'manifest.json')) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const readBytes = async (relative: string, expectedHash?: string): Promise<Buffer> => {
    input.signal?.throwIfAborted()
    const target = path.resolve(root, relative)
    if (!target.startsWith(`${root}${path.sep}`) || !resolveExistingPathInside(root, target)) throw new Error('Document snapshot path is not contained')
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Document snapshot is not a regular file')
    const bytes = await fs.readFile(target)
    input.signal?.throwIfAborted()
    if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('Document snapshot revision does not match its seal')
    return bytes
  }
  const read = async (relative: string, hash?: string) => (await readBytes(relative, hash)).toString('utf8')
  const snapshot = snapshotSchema.parse(JSON.parse(await read('manifest.json')))
  const byPath = new Map(snapshot.files.map((entry) => [entry.path, entry]))
  const manifestEntry = byPath.get('parsed/_manifest.json')
  const parser = manifestEntry ? parserManifestSchema.parse(JSON.parse(await read(manifestEntry.path, manifestEntry.sha256))) : { files: [] }
  const documents: DocumentSource[] = []
  const append = (name: string, text: string | null, sourceHash: string, group: string, pages?: DocumentSource['pages'], uploadedAt?: string) => {
    const revision = createHash('sha256').update(JSON.stringify({ text: text ?? sourceHash, pages })).digest('hex')
    const id = `doc_${createHash('sha256').update(`${input.runId}\0${group}\0${name}\0${sourceHash}\0${revision}`).digest('hex')}`
    documents.push(documentSourceSchema.parse({ id, name, revision, text, ...(pages ? { pages } : {}), ...(uploadedAt ? { uploadedAt } : {}) }))
  }
  for (const entry of snapshot.files.filter((entry) => entry.kind === 'input')) {
    const name = entry.path.slice('files/'.length)
    if (!entry.path.startsWith('files/') || !isSafePathSegment(name) || name.startsWith('.')) continue
    const parsed = parser.files.find((file) => file.source === name && file.status === 'success')
    const output = parsed?.outputs?.text
    const derivative = output && isSafePathSegment(output) ? byPath.get(`parsed/${output}`) : undefined
    let text = derivative ? await read(derivative.path, derivative.sha256) : textExtensions.has(path.extname(name).toLowerCase()) ? await read(entry.path, entry.sha256) : null
    const parseName = parsed?.outputs?.parse
    const parseEntry = parseName && isSafePathSegment(parseName) ? byPath.get(`parsed/${parseName}`) : undefined
    const pageIndex = parseEntry ? pdfPageIndexSchema.safeParse(JSON.parse(await read(parseEntry.path, parseEntry.sha256))) : undefined
    let pages = pageIndex?.success ? pageIndex.data.pages : undefined
    if (input.parserLauncher && (text === null || input.requirePageIndex && path.extname(name).toLowerCase() === '.pdf' && !pages)) {
      const parsedCopy = await parseDocumentCopy({ name, contents: await readBytes(entry.path, entry.sha256), launcher: input.parserLauncher, ...(input.signal ? { signal: input.signal } : {}) })
      text = parsedCopy.text
      pages = parsedCopy.pages
    }
    append(name, text, entry.sha256, 'uploads', pages, entry.uploadedAt)
  }
  const projectManifest = path.join(root, 'project-context', 'manifest.json')
  try {
    await fs.access(projectManifest)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return documents
    throw error
  }
  const project = projectSchema.parse(JSON.parse(await read('project-context/manifest.json', snapshot.projectContext?.sha256)))
  if (project.brief) append('Project brief', await read(`project-context/${project.brief.relativePath}`, project.brief.sha256), project.brief.sha256, 'project')
  for (const file of project.files) {
    const bytes = await readBytes(`project-context/${file.relativePath}`, file.sha256)
    const parsedCopy = !textExtensions.has(path.extname(file.name).toLowerCase()) && input.parserLauncher ? await parseDocumentCopy({ name: file.name, contents: bytes, launcher: input.parserLauncher, ...(input.signal ? { signal: input.signal } : {}) }) : undefined
    const text = textExtensions.has(path.extname(file.name).toLowerCase()) ? bytes.toString('utf8') : parsedCopy?.text ?? null
    append(file.name, text, file.sha256, 'project', parsedCopy?.pages)
  }
  return documents
}
