import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { readFileParserOutputs } from '../../core/file-parser-output.js'

async function withParsedOutputs(
  files: Record<string, string>,
  outputs: Record<string, string>,
  run: (inputDir: string) => Promise<void>,
): Promise<void> {
  const inputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-parser-output-'))
  const parsedDir = path.join(inputDir, 'parsed')
  await fs.mkdir(parsedDir)
  await Promise.all([
    ...Object.entries(files).map(([fileName, content]) =>
      fs.writeFile(path.join(parsedDir, fileName), content)),
    fs.writeFile(path.join(parsedDir, '_manifest.json'), JSON.stringify({
      files: [{
        source: 'report.pdf',
        status: 'success',
        outputs,
      }],
    })),
  ])

  try {
    await run(inputDir)
  } finally {
    await fs.rm(inputDir, { recursive: true, force: true })
  }
}

test('file parser output uses canonical text without diagnostic artifacts', async () => {
  await withParsedOutputs({
    'report.pdf.md': '# Canonical report',
    'report.pdf.structure.md': '# Diagnostic structure',
    'report.pdf.parse.json': '{"diagnostic":true}',
  }, {
    text: 'report.pdf.md',
    structure: 'report.pdf.structure.md',
    parse: 'report.pdf.parse.json',
  }, async (inputDir) => {
    const content = await readFileParserOutputs(inputDir)

    assert.match(content, /# Canonical report/)
    assert.doesNotMatch(content, /Diagnostic structure/)
    assert.doesNotMatch(content, /diagnostic/)
  })
})

test('file parser output appends partial enrichment to canonical text', async () => {
  await withParsedOutputs({
    'report.pdf.md': 'Complete source page one\n\nComplete source page two',
    'report.pdf.enriched.md': 'Summary of flagged page two',
  }, {
    text: 'report.pdf.md',
    enriched: 'report.pdf.enriched.md',
  }, async (inputDir) => {
    const content = await readFileParserOutputs(inputDir)

    assert.match(content, /Complete source page one/)
    assert.match(content, /Complete source page two/)
    assert.match(content, /Summary of flagged page two/)
  })
})

test('file parser output appends the semantic PDF page map before enrichment', async () => {
  await withParsedOutputs({
    'report.pdf.md': 'Complete canonical source',
    'report.pdf.pages.md': '# PDF Page Locator\n\n- Page 8: Financial outlook',
    'report.pdf.enriched.md': 'Summary of flagged page eight',
  }, {
    text: 'report.pdf.md',
    pageMap: 'report.pdf.pages.md',
    enriched: 'report.pdf.enriched.md',
  }, async (inputDir) => {
    const content = await readFileParserOutputs(inputDir)

    assert.ok(content.indexOf('Complete canonical source') < content.indexOf('PDF Page Locator'))
    assert.ok(content.indexOf('PDF Page Locator') < content.indexOf('Summary of flagged page eight'))
  })
})

test('file parser output uses semantic structure only when canonical text is unavailable', async () => {
  await withParsedOutputs({
    'report.pdf.structure.md': '# Available structure',
  }, {
    text: 'missing-report.pdf.md',
    structure: 'report.pdf.structure.md',
  }, async (inputDir) => {
    const content = await readFileParserOutputs(inputDir)

    assert.match(content, /Available structure/)
  })
})

test('file parser output never substitutes diagnostics when semantic content exceeds the budget', async () => {
  await withParsedOutputs({
    'report.pdf.md': 'Canonical source content that is larger than the test budget.',
    'report.pdf.parse.json': '{"diagnostic":"must not reach model context"}',
  }, {
    text: 'report.pdf.md',
    parse: 'report.pdf.parse.json',
  }, async (inputDir) => {
    const content = await readFileParserOutputs(inputDir, 24)

    assert.match(content, /Canonical/)
    assert.doesNotMatch(content, /diagnostic/)
  })
})
