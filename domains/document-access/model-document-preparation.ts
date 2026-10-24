import type { DocumentSource } from '../../contracts/document-reference.js'
import { callModel, type ModelCallParams } from '../provider/model-client.js'
import { reviewDocuments, requestsWholeDocument, buildDocumentReviewPrompt, DOCUMENT_REVIEW_INSTRUCTION, documentReviewOutputSchema } from './document-review.js'

/** Direct/structured providers receive cited evidence prepared from complete sources. */
export async function prepareModelDocuments(input: { readonly documents: readonly DocumentSource[]; readonly question: string; readonly apiKey: string; readonly model: Pick<ModelCallParams, 'provider' | 'model' | 'thinking' | 'signal' | 'providerOptions'>; readonly cacheDir?: string }) {
  const documents = requestsWholeDocument(input.question) ? input.documents : input.documents.filter((document) => (document.text?.length ?? 0) > 12_000)
  if (documents.length === 0) return { context: '', coverage: [] }
  return reviewDocuments({ documents, question: input.question, reviewerKey: `${input.model.provider}/${input.model.model}`, ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}), ...(input.model.signal ? { signal: input.model.signal } : {}), execute: async (fragment) => {
    const response = await callModel(input.apiKey, { ...input.model, systemPrompt: DOCUMENT_REVIEW_INSTRUCTION, messages: [{ role: 'user', content: buildDocumentReviewPrompt(fragment) }], outputSchema: documentReviewOutputSchema })
    if (!response.ok) throw new Error(`Document preparation failed: ${response.reason}`)
    return response.text
  } })
}
