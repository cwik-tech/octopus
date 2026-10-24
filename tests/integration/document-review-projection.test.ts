import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { projectDocumentReviews } from '../../services/document-review-projection.js'

test('file status projects only review receipts for the same admitted original revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'document-review-projection-'))
  const file = { name: 'source.pdf', size: 10, uploadedAt: '2026-10-09T00:00:00Z', parseStatus: 'parsed' as const }
  try {
    const receipt = { document: `doc_${'a'.repeat(64)}`, name: file.name, revision: 'b'.repeat(64), uploadedAt: file.uploadedAt, state: 'partial', pageCoverage: 'known', reviewedPages: [1], unresolvedPages: [2], reviewedCharacters: 10, totalCharacters: 20 }
    await fs.writeFile(path.join(root, `${receipt.document}.coverage.json`), JSON.stringify(receipt))
    const projected = await projectDocumentReviews({ files: [file], cacheDirs: [root] })
    assert.equal(projected[0]?.documentReview?.state, 'partial')
    const replaced = await projectDocumentReviews({ files: [{ ...file, uploadedAt: '2026-10-10T00:00:00Z' }], cacheDirs: [root] })
    assert.equal(replaced[0]?.documentReview, undefined)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
