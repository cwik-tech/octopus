import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDocumentRequestBudget, DocumentRequestBudgetError } from '../../domains/document-access/document-request-budget.js'

test('document request budgeting treats visual payloads as images while retaining the text limit', () => {
  const image = { mimeType: 'image/jpeg', data: Buffer.alloc(170_000, 127).toString('base64') }
  assert.doesNotThrow(() => assertDocumentRequestBudget({ provider: 'openai', model: 'gpt-4.1', request: {
    messages: [{ role: 'tool', content: 'First image', images: [image] }, { role: 'tool', content: 'Second image', images: [image] }],
  } }))
  assert.throws(() => assertDocumentRequestBudget({ provider: 'openai', model: 'gpt-4.1', request: {
    messages: [{ role: 'user', content: image.data.repeat(2) }],
  } }), DocumentRequestBudgetError)
})

test('many visual inputs still consume the document request budget', () => {
  const image = { mimeType: 'image/jpeg', data: '/9j/2Q==' }
  assert.throws(() => assertDocumentRequestBudget({ provider: 'openai', model: 'gpt-4.1', request: {
    messages: [{ role: 'user', content: 'Describe these.', images: Array.from({ length: 16 }, () => image) }],
  } }), DocumentRequestBudgetError)
})
