import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractPagesMarkdown, processPdf } from '@firecrawl/pdf-inspector'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.resolve(scriptDirectory, '../tests/fixtures/visual-deck.pdf')
const buffer = fs.readFileSync(fixturePath)
const documentResult = processPdf(buffer)
const pageResult = extractPagesMarkdown(buffer)

assert.match(documentResult.markdown ?? '', /ExampleCo has No Competition/)
assert.ok(documentResult.pagesWithTables.includes(6))
assert.ok(pageResult.pagesNeedingOcr.includes(8))

console.log(`pdf-inspector native smoke passed on ${process.platform}-${process.arch}`)
