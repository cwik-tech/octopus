import assert from 'node:assert/strict'
import test from 'node:test'
import { documentSourceSchema } from '../../contracts/document-reference.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../contracts/mcp.js'
import { estimateContextTokens } from '../../core/context-tokens.js'
import type { McpJsonObject } from '../../domains/mcp/mcp-runtime.js'
import { createDocumentToolAdapters } from '../../services/document-tool-adapters.js'
import { assembleSpeakerPrompt } from '../../services/agent-chat-history.js'
import { renderDocumentManifest } from '../../services/document-context-service.js'

test('a large admitted document set has a bounded manifest and an explicit listing continuation', () => {
  const documents = Array.from({ length: 100 }, (_, index) => ({ id: `doc_${index.toString(16).padStart(64, '0')}`, name: '匹'.repeat(125), revision: 'b'.repeat(64), text: 'evidence' }))
  const manifest = renderDocumentManifest(documents)
  assert.ok(estimateContextTokens(manifest) <= 2_000, `Manifest cost ${estimateContextTokens(manifest)} tokens`)
  assert.match(manifest, /document_list/)
  assert.match(manifest, /100/)
})

test('a PDF search cites the canonical page rather than a heading in the source', async () => {
  const document = documentSourceSchema.parse({ ...source, text: '## Page 434\nFIRST\nFINAL_FACT=72391', pages: [{ page: 1, markdown: '## Page 434\nFIRST', status: 'read' }, { page: 2, markdown: 'FINAL_FACT=72391', status: 'read' }] })
  const adapter = createDocumentToolAdapters({ documents: [document], scope }).find((tool) => tool.name === 'document_search')
  assert.ok(adapter)
  const result = await adapter.execute({ context: { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: 'request', leaseId: 'lease', sessionId: scope.sessionId, runId: scope.runId, assignmentId: 'assignment', agentPath: 'agents/reader' }, toolCallId: 'call', input: { query: 'FINAL_FACT' } })
  assert.match(result.content, /&quot;page&quot;:2/)
})

const documentId = `doc_${'a'.repeat(64)}`
const source = { id: documentId, name: 'notes.md', revision: 'b'.repeat(64), text: 'beginning\n' + '匹'.repeat(20_000) + '\nFINAL_FACT=72391' }
const scope = { sessionId: 'owner-session', runId: 'owner-turn' }

test('reading an admitted image returns visual content only to its owning turn', async () => {
  const image = { mimeType: 'image/jpeg' as const, data: '/9j/2Q==' }
  const document = documentSourceSchema.parse({ ...source, name: 'screen.jpg', text: null, image })
  const adapter = createDocumentToolAdapters({ documents: [document], scope }).find((tool) => tool.name === 'document_read')
  assert.ok(adapter)
  const context = { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: 'request', leaseId: 'lease', sessionId: scope.sessionId, runId: scope.runId, assignmentId: 'assignment', agentPath: 'agents/reader' }
  const result = await adapter.execute({ context, toolCallId: 'visual', input: { document: documentId } })
  assert.equal(result.isError, false)
  assert.deepEqual(result.images, [image])
  assert.match(renderDocumentManifest([document]), /image available/)
  const denied = await adapter.execute({ context: { ...context, sessionId: 'unrelated-session' }, toolCallId: 'denied', input: { document: documentId } })
  assert.equal(denied.isError, true)
  assert.equal(denied.images, undefined)
})

test('admitted document identities survive trimming of the reference excerpts', () => {
  const prompt = assembleSpeakerPrompt({
    speakerName: 'Reader', latestUserText: 'Read the final section.', history: [],
    fileContext: 'Optional excerpt '.repeat(20_000), documentContext: 'DOCUMENT_ID=doc-immutable-final',
    windowTokens: 8_000, maxOutputTokens: 1_000,
  })
  assert.ok(prompt.includes('DOCUMENT_ID=doc-immutable-final'), 'The admitted document identity must survive excerpt trimming')
  assert.match(prompt, /Read the final section\./)
})

test('a turn with no admitted documents has no document tools', () => {
  assert.deepEqual(createDocumentToolAdapters({ documents: [], scope }), [])
})

async function call(name: string, input: McpJsonObject, sessionId = scope.sessionId, signal?: AbortSignal, document = source) {
  const adapter = createDocumentToolAdapters({ documents: [{ ...document }], scope }).find((tool) => tool.name === name)
  assert.ok(adapter, `The admitted turn must expose ${name}`)
  return adapter.execute({
    context: { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: 'request', leaseId: 'lease', sessionId, runId: scope.runId, assignmentId: 'assignment', agentPath: 'agents/reader' },
    toolCallId: 'call', input, ...(signal ? { signal } : {}),
  })
}

test('a document search can find cited evidence beyond the initial excerpt', async () => {
  const result = await call('document_search', { query: 'FINAL_FACT' })
  assert.equal(result.isError, false)
  assert.match(result.content, /FINAL_FACT=72391/)
  assert.match(result.content, new RegExp(documentId))
  assert.match(result.content, /revision/)
})

test('search offsets refer to the original text when case folding changes its length', async () => {
  const result = await call('document_search', { query: 'FINAL_FACT' }, scope.sessionId, undefined, {
    ...source, text: 'İ'.repeat(200) + '\nFINAL_FACT=72391',
  })
  assert.equal(result.isError, false)
  assert.match(result.content, /FINAL_FACT=72391/)
})

test('a document listing names full sources without exposing their content', async () => {
  const result = await call('document_list', {})
  assert.equal(result.isError, false)
  assert.match(result.content, /notes\.md/)
  assert.match(result.content, new RegExp(documentId))
  assert.doesNotMatch(result.content, /FINAL_FACT=72391/)
})

test('a document read can resume at the final range and identifies the end', async () => {
  const result = await call('document_read', { document: documentId, offset: source.text.indexOf('FINAL_FACT') })
  assert.equal(result.isError, false)
  assert.match(result.content, /FINAL_FACT=72391/)
  assert.doesNotMatch(result.content, /next_offset/)
})

test('a document read returns a bounded escaped range and a continuation cursor', async () => {
  const result = await call('document_read', { document: documentId, offset: 10 })
  assert.equal(result.isError, false)
  assert.ok(estimateContextTokens(result.content) <= 2_200, `Read returned ${estimateContextTokens(result.content)} estimated tokens`)
  assert.match(result.content, /next_offset/)
  assert.doesNotMatch(result.content, /FINAL_FACT=72391/)
})

test('search result metadata and its coverage notice stay inside the result budget', async () => {
  const documents = Array.from({ length: 10 }, (_, index) => ({
    id: `doc_${index.toString(16).padStart(64, '0')}`, revision: 'a'.repeat(64),
    name: '匹'.repeat(125), text: 'FIND_TOKEN=99',
  }))
  const adapter = createDocumentToolAdapters({ documents, scope }).find((tool) => tool.name === 'document_search')
  assert.ok(adapter)
  const result = await adapter.execute({
    context: { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: 'request', leaseId: 'lease', sessionId: scope.sessionId, runId: scope.runId, assignmentId: 'assignment', agentPath: 'agents/reader' },
    toolCallId: 'call', input: { query: 'FIND_TOKEN' },
  })
  assert.ok(estimateContextTokens(result.content) <= 2_000, `Search output cost ${estimateContextTokens(result.content)} tokens instead of at most 2000`)
  assert.match(result.content, /FIND_TOKEN=99/)
  assert.match(result.content, /truncated/)
})

test('document tools reject references outside the admitted document set', async () => {
  const result = await call('document_read', { document: `doc_${'c'.repeat(64)}` })
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content, /FINAL_FACT=72391/)
})

test('document tools reject another conversation even with a known document ID', async () => {
  const result = await call('document_read', { document: documentId }, 'another-session')
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content, /beginning/)
})

test('document tools reject path-like and malformed caller input', async () => {
  const result = await call('document_read', { document: '../../private/secret', offset: -1 })
  assert.equal(result.isError, true)
})

test('a cancelled document read returns no source content', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(call('document_read', { document: documentId }, scope.sessionId, controller.signal), { name: 'AbortError' })
})
test('indexed documents expose the actual last PDF page without treating a heading as a page boundary', async () => {
  const indexed = documentSourceSchema.parse({ ...source, pages: [{ page: 1, markdown: '## Page 434\nThis is still page one.', status: 'read' }, { page: 2, markdown: 'ACTUAL_TAIL=43417', status: 'read' }] })
  const tools = createDocumentToolAdapters({ documents: [indexed], scope: { sessionId: 'owner-session', runId: 'owner-turn' } })
  const reader = tools.find((tool) => tool.name === 'document_read')
  assert.ok(reader)
  const result = await reader.execute({ context: { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: 'request', leaseId: 'lease', sessionId: scope.sessionId, runId: scope.runId, assignmentId: 'assignment', agentPath: 'agents/reader' }, toolCallId: 'call', input: { document: indexed.id, page: 2 } })
  assert.equal(result.isError, false)
  assert.match(result.content, /ACTUAL_TAIL=43417/)
  assert.match(JSON.stringify(result.output), /"page":2/)
  assert.doesNotMatch(result.content, /This is still page one/)
})
