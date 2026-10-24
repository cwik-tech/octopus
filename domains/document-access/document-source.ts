import { createHash } from 'node:crypto'
import { documentSourceSchema, type DocumentSource } from '../../contracts/document-reference.js'

export function createDocumentSource(input: { owner: string; name: string; text: string | null; revisionKey?: string; pages?: DocumentSource['pages']; uploadedAt?: string }): DocumentSource {
  const revision = createHash('sha256').update(JSON.stringify({ text: input.text, pages: input.pages, revisionKey: input.revisionKey })).digest('hex')
  const id = `doc_${createHash('sha256').update(`${input.owner}\0${input.name}\0${revision}`).digest('hex')}`
  return documentSourceSchema.parse({ id, name: input.name, revision, text: input.text, ...(input.pages ? { pages: input.pages } : {}), ...(input.uploadedAt ? { uploadedAt: input.uploadedAt } : {}) })
}
