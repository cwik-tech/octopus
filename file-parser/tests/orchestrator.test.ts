import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import PDFDocument from 'pdfkit'
import type { Manifest } from '../types.js'
import { BITMAP_FIXTURE } from './bitmap-fixture.js'
import { RICH_TEXT_FIXTURE } from './rich-text-fixture.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

/** Copy select fixtures to a temp input dir, run the orchestrator, return results */
async function runOrchestrator(
  files: string[],
  flags: string[] = [],
  env: Record<string, string> = {},
): Promise<{ manifest: Manifest; outputDir: string; tempDir: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-orch-'))
  const inputDir = path.join(tempDir, 'input')
  fs.mkdirSync(inputDir)

  // Copy fixture files to temp input dir
  try {
    for (const file of files) {
      if (file === 'generated-text-heavy.pdf') {
        await createTextHeavyPdf(path.join(inputDir, file))
        continue
      }
      const src = path.join(FIXTURES, file)
      // Copying only when present would make a test whose fixture is missing pass vacuously: the
      // orchestrator would run over an empty directory and every assertion about that file would be
      // skipped along with it. A fixture a test names must be on disk.
      if (!fs.existsSync(src)) {
        throw new Error(`Fixture not on disk: ${src}. Run \`npm run fixtures\` in file-parser/.`)
      }
      fs.copyFileSync(src, path.join(inputDir, file))
    }
  } catch (error) {
    // The caller never receives `tempDir`, so it has no way to clean up after a refused fixture.
    cleanup(tempDir)
    throw error
  }

  // Run the CLI via an async subprocess so in-process mock servers can respond.
  await runOrchestratorCli(inputDir, flags, env)

  const outputDir = path.join(inputDir, 'parsed')
  const manifestPath = path.join(outputDir, '_manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest

  return { manifest, outputDir, tempDir }
}

/** Run the orchestrator CLI against an existing input dir and return its stdout. */
async function runOrchestratorCli(
  inputDir: string,
  flags: string[] = [],
  env: Record<string, string> = {},
): Promise<string> {
  const { spawn } = await import('node:child_process')
  return new Promise<string>((resolve, reject) => {
    const child = spawn('npx', ['tsx', path.resolve(import.meta.dirname, '../index.ts'), inputDir, ...flags], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`orchestrator timed out after 60000ms\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`orchestrator exited with code ${code ?? 'null'} signal ${signal ?? 'null'}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

async function createMockResponsesServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/responses') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const pageDescriptor = JSON.stringify(body).includes('page')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        output_text: JSON.stringify({
          document_summary: 'Generic workflow-level enriched summary.',
          document_kind: 'slide-deck',
          key_entities: ['Entity Alpha'],
          key_metrics: [{ label: 'Test metric', value: '42', page: 1 }],
          page_summaries: pageDescriptor
            ? [{
              page: 1,
              title: 'Page 1',
              summary: 'Mocked generic workflow page summary.',
              visual_elements: ['chart'],
              table_like: false,
            }]
            : [],
          recommended_pages: [1],
          confidence: 'medium',
        }),
      }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve mock server address.')
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

function createTextHeavyPdf(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)

    doc.fontSize(18).text('Operational Review', { underline: true })
    doc.moveDown()

    const paragraphs = [
      'This dummy report exists to validate text-heavy PDF parsing under the file parser test suite.',
      'It contains multiple long paragraphs with punctuation, headings, and narrative continuity so the parser can recover reading order and line joins.',
      'The farm automation program reduced harvest delays, stabilized labor planning, and improved packing throughput across the first pilot cohort.',
      'Management expects the next implementation wave to focus on margin expansion, service logistics, and reliability metrics tracked weekly by the operations team.',
      'This document should classify as text-heavy and should not require LM enrichment for basic downstream usage.',
    ]

    for (let i = 0; i < 6; i++) {
      for (const paragraph of paragraphs) {
        doc.fontSize(11).text(paragraph)
        doc.moveDown(0.5)
      }
    }

    stream.on('close', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.end()
  })
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

// ── Orchestrator Tests ──

test('orchestrator: parses mixed file types and writes manifest', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator([
    'generated-text-heavy.pdf',
    'test-photo.jpg',
    'financials.xlsx',
    'notes.txt',
  ])

  try {
    assert.equal(manifest.parser_version, '0.1.0')
    assert.equal(manifest.files.length, 4)

    // Check each file was parsed
    const bySource = new Map(manifest.files.map(f => [f.source, f]))

    const pdf = bySource.get('generated-text-heavy.pdf')
    assert.ok(pdf)
    assert.equal(pdf.status, 'success', pdf.error)
    assert.equal(pdf.type, 'pdf')
    assert.equal(pdf.classification, 'text-heavy')
    assert.ok(pdf.outputs.text)
    assert.ok(pdf.outputs.structure)
    assert.ok(pdf.outputs.parse)

    const img = bySource.get('test-photo.jpg')
    assert.ok(img)
    assert.equal(img.status, 'success')
    assert.equal(img.type, 'image')
    assert.equal(img.requiresLlm, true)

    const xlsx = bySource.get('financials.xlsx')
    assert.ok(xlsx)
    assert.equal(xlsx.status, 'success')
    assert.equal(xlsx.type, 'xlsx')

    const txt = bySource.get('notes.txt')
    assert.ok(txt)
    assert.equal(txt.status, 'success')
    assert.equal(txt.type, 'generic')

    // Check output files exist
    for (const file of manifest.files) {
      for (const outputFile of Object.values(file.outputs)) {
        if (outputFile.endsWith('/')) continue // skip directory outputs
        assert.ok(
          fs.existsSync(path.join(outputDir, outputFile)),
          `Output file should exist: ${outputFile}`,
        )
      }
    }

    const parseJsonPath = path.join(outputDir, pdf!.outputs.parse)
    const parseJson = JSON.parse(fs.readFileSync(parseJsonPath, 'utf-8')) as Record<string, unknown>
    assert.equal(parseJson.parse_quality, 'high')
    assert.equal(parseJson.lm_scope, 'none')
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: a CSV upload is routed to a parser that can read it', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator(['yield-data.csv'])

  try {
    const csv = manifest.files.find(file => file.source === 'yield-data.csv')
    assert.ok(csv)
    assert.equal(csv.status, 'success', csv.error)
    assert.ok(csv.outputs.text, 'A readable CSV produces markdown output')

    const md = fs.readFileSync(path.join(outputDir, csv.outputs.text), 'utf-8')
    assert.ok(md.includes('Farm Beta'), 'The markdown carries the CSV row content')
    assert.ok(md.includes('Soybeans'), 'The markdown carries the CSV row content')
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: skips hidden files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-orch-'))
  const inputDir = path.join(tempDir, 'input')
  fs.mkdirSync(inputDir)

  fs.copyFileSync(path.join(FIXTURES, 'notes.txt'), path.join(inputDir, 'notes.txt'))
  fs.writeFileSync(path.join(inputDir, '.hidden'), 'secret')

  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('npx', ['tsx', path.resolve(import.meta.dirname, '../index.ts'), inputDir], {
      cwd: path.resolve(import.meta.dirname, '..'),
      timeout: 30000,
    })

    const manifestPath = path.join(inputDir, 'parsed', '_manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest

    assert.equal(manifest.files.length, 1, 'Should only parse notes.txt, not .hidden')
    assert.equal(manifest.files[0].source, 'notes.txt')
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: incremental mode skips already-parsed files', async () => {
  const { manifest: first, outputDir, tempDir } = await runOrchestrator([
    'notes.txt',
    'test-photo.jpg',
  ])

  try {
    assert.equal(first.files.length, 2)

    // Get modification time of an output file
    const txtOutput = path.join(outputDir, first.files.find(f => f.source === 'notes.txt')!.outputs.text)
    const firstMtime = fs.statSync(txtOutput).mtimeMs

    // Wait a bit so mtime would differ
    await new Promise(resolve => setTimeout(resolve, 100))

    // Run again without --force
    const { execFileSync } = await import('node:child_process')
    const result = execFileSync(
      'npx',
      ['tsx', path.resolve(import.meta.dirname, '../index.ts'), path.join(tempDir, 'input')],
      { cwd: path.resolve(import.meta.dirname, '..'), timeout: 30000, encoding: 'utf-8' },
    )

    assert.ok(result.includes('SKIP'), 'Should skip already-parsed files')
    assert.ok(result.includes('0 parsed'), 'Should report 0 files parsed')

    // Output file should not have been modified
    const secondMtime = fs.statSync(txtOutput).mtimeMs
    assert.equal(firstMtime, secondMtime, 'Output file should not be re-written')

    // Adding another binary after parsed Markdown exists must still update the
    // authoritative manifest while retaining prior results.
    fs.copyFileSync(
      path.join(FIXTURES, 'financials.xlsx'),
      path.join(tempDir, 'input', 'financials.xlsx'),
    )
    execFileSync(
      'npx',
      ['tsx', path.resolve(import.meta.dirname, '../index.ts'), path.join(tempDir, 'input')],
      { cwd: path.resolve(import.meta.dirname, '..'), timeout: 30000, encoding: 'utf-8' },
    )
    const updatedManifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, '_manifest.json'), 'utf8'),
    ) as Manifest
    assert.deepEqual(
      updatedManifest.files.map(file => file.source).sort(),
      ['financials.xlsx', 'notes.txt', 'test-photo.jpg'],
    )
    assert.equal(fs.statSync(txtOutput).mtimeMs, firstMtime)
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: --force re-parses everything', async () => {
  // First run
  const { tempDir } = await runOrchestrator(['notes.txt'])
  const inputDir = path.join(tempDir, 'input')

  try {
    // Second run with --force
    const { execFileSync } = await import('node:child_process')
    const result = execFileSync(
      'npx',
      ['tsx', path.resolve(import.meta.dirname, '../index.ts'), inputDir, '--force'],
      { cwd: path.resolve(import.meta.dirname, '..'), timeout: 30000, encoding: 'utf-8' },
    )

    assert.ok(result.includes('PARSE'), 'Should re-parse with --force')
    assert.ok(result.includes('1 parsed'), 'Should report 1 file parsed')
    assert.ok(!result.includes('SKIP'), 'Should not skip any files')
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: handles empty input directory', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-orch-'))
  const inputDir = path.join(tempDir, 'input')
  fs.mkdirSync(inputDir)

  try {
    const { execFileSync } = await import('node:child_process')
    const result = execFileSync(
      'npx',
      ['tsx', path.resolve(import.meta.dirname, '../index.ts'), inputDir],
      { cwd: path.resolve(import.meta.dirname, '..'), timeout: 30000, encoding: 'utf-8' },
    )

    assert.ok(result.includes('No files found'), 'Should report no files')
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: applies LM enrichment end-to-end when enabled', async () => {
  const visualFixture = path.join(FIXTURES, 'visual-deck.pdf')
  if (!fs.existsSync(visualFixture)) return

  const { server, baseUrl } = await createMockResponsesServer()
  try {
    const { manifest, outputDir, tempDir } = await runOrchestrator(
      ['visual-deck.pdf'],
      [],
      {
        FILE_PARSER_LM_ENABLED: '1',
        FILE_PARSER_LLM_PROVIDER: 'openai',
        FILE_PARSER_OPENAI_API_KEY: 'test-key',
        FILE_PARSER_OPENAI_BASE_URL: baseUrl,
        FILE_PARSER_LLM_MODEL: 'gpt-test',
        FILE_PARSER_LLM_ENABLED: '1',
        FILE_PARSER_MAX_RENDERED_PAGES: '1',
      },
    )

    try {
      assert.equal(manifest.files.length, 1)
      const pdf = manifest.files[0]
      assert.equal(pdf.status, 'success')
      assert.equal(pdf.enrichmentApplied, true)
      assert.equal(pdf.enrichmentProvider, 'openai')
      assert.equal(pdf.metadata.rendered_page_limit, 1)
      assert.equal((pdf.metadata.rendered_page_numbers as number[]).length, 1)
      assert.ok(pdf.outputs.enriched)
      assert.ok(pdf.outputs.enrichment)
      assert.ok(fs.existsSync(path.join(outputDir, pdf.outputs.enriched)))
      assert.ok(fs.existsSync(path.join(outputDir, pdf.outputs.enrichment)))
    } finally {
      cleanup(tempDir)
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
})

test('orchestrator: a result recorded under another OCR contract is regenerated', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator(['markpdf-mixed-ocr.pdf'])
  try {
    const first = manifest.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.ok(first?.ocr, 'The first parse records the OCR contract it ran under')

    // Rewrite the manifest as an older contract would have left it, and make the source look
    // older than the output so mtime alone cannot force a reparse.
    const manifestPath = path.join(outputDir, '_manifest.json')
    const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
    for (const file of stored.files) {
      if (file.ocr) file.ocr.contractIdentity = 'v0:tesseract.js:eng:LSTM_ONLY:default:144dpi:spaces=1'
    }
    fs.writeFileSync(manifestPath, JSON.stringify(stored, null, 2))
    const markerPath = path.join(outputDir, 'markpdf-mixed-ocr.pdf.md')
    const marker = 'REGENERATION MARKER'
    fs.writeFileSync(markerPath, marker)

    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'npx',
        ['tsx', path.resolve(import.meta.dirname, '../index.ts'), path.join(tempDir, 'input')],
        { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'ignore'] },
      )
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code ?? 'null'}`))))
    })

    assert.notEqual(
      fs.readFileSync(markerPath, 'utf-8'),
      marker,
      'A later contract change must regenerate the affected result',
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('orchestrator: a PDF manifest recorded before local OCR is reparsed exactly once', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator(['markpdf-mixed-ocr.pdf'])
  try {
    const first = manifest.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.ok(first?.ocr, 'The first parse records the OCR contract it ran under')

    // Rewrite the manifest the way a pre-OCR parser left it: no `ocr` key and no contract
    // identity in metadata — no marker of the recognition contract at all.
    const manifestPath = path.join(outputDir, '_manifest.json')
    const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
    for (const file of stored.files) {
      delete file.ocr
      delete file.metadata.ocr_contract_identity
      delete file.metadata.ocr_contract_version
    }
    fs.writeFileSync(manifestPath, JSON.stringify(stored, null, 2))

    const markerPath = path.join(outputDir, 'markpdf-mixed-ocr.pdf.md')
    const marker = 'REGENERATION MARKER'
    fs.writeFileSync(markerPath, marker)

    const inputDir = path.join(tempDir, 'input')
    const second = await runOrchestratorCli(inputDir)
    assert.ok(second.includes('PARSE'), 'A pre-OCR manifest entry must be reparsed once')
    assert.notEqual(
      fs.readFileSync(markerPath, 'utf-8'),
      marker,
      'The reparse rewrites the output under the current contract',
    )
    const reparsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
    assert.ok(
      reparsed.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')?.ocr,
      'The reparse records the current OCR contract',
    )

    fs.writeFileSync(markerPath, marker)
    const third = await runOrchestratorCli(inputDir)
    assert.ok(third.includes('SKIP'), 'Once reparsed, the result is reused normally')
    assert.ok(third.includes('0 parsed'), 'No second reparse happens')
    assert.equal(
      fs.readFileSync(markerPath, 'utf-8'),
      marker,
      'A current-contract result is not reparsed again',
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('orchestrator: a fallback-engine result with no OCR summary is finished, not reparsed forever', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator(['malformed-trailer.pdf'])
  try {
    const first = manifest.files.find((file) => file.source === 'malformed-trailer.pdf')
    assert.equal(first?.status, 'success', first?.error)
    assert.equal(
      first?.metadata.pdf_engine,
      'pdf-parse',
      'The inspector declined the malformed file and the compatibility engine parsed it',
    )
    assert.equal(first?.ocr, undefined, 'The fallback engine legitimately produces no OCR summary')

    const markerPath = path.join(outputDir, 'malformed-trailer.pdf.md')
    const marker = 'FALLBACK RESULT MARKER'
    fs.writeFileSync(markerPath, marker)

    const inputDir = path.join(tempDir, 'input')
    const second = await runOrchestratorCli(inputDir)
    assert.ok(
      second.includes('SKIP'),
      'A result the current parser finished without OCR must be reused, not reparsed on every run',
    )
    assert.ok(second.includes('0 parsed'), 'The fallback result converges after its first parse')
    assert.equal(fs.readFileSync(markerPath, 'utf-8'), marker, 'The fallback result is reused')

    const stored = JSON.parse(
      fs.readFileSync(path.join(outputDir, '_manifest.json'), 'utf-8'),
    ) as Manifest
    const reused = stored.files.find((file) => file.source === 'malformed-trailer.pdf')
    assert.equal(
      typeof reused?.metadata.ocr_contract_identity,
      'string',
      'The current parser names the contract it ran under even when no recognition ran',
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('orchestrator: a malformed OCR record fails closed — reparsed, then reused once well-formed', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator(['markpdf-mixed-ocr.pdf'])
  try {
    const manifestPath = path.join(outputDir, '_manifest.json')
    const entry = manifest.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.ok(entry?.ocr, 'The first parse records the OCR contract it ran under')

    const markerPath = path.join(outputDir, 'markpdf-mixed-ocr.pdf.md')
    const marker = 'MALFORMED OCR RECORD'
    const inputDir = path.join(tempDir, 'input')

    // Each hand-edited corruption claims more than the record proves. None of them is
    // well-formed enough to trust, so each must be reparsed rather than reused.
    const corruptions: Array<[string, (ocr: Record<string, unknown>) => void]> = [
      ['completion claimed without its unresolvedPages list', (ocr) => delete ocr.unresolvedPages],
      ['unresolvedPages that is not a page list', (ocr) => { ocr.unresolvedPages = 'none' }],
      ['a negative page among the read pages', (ocr) => { ocr.readPages = [-2] }],
      ['a status outside the declared union', (ocr) => { ocr.status = 'done' }],
    ]
    for (const [label, corrupt] of corruptions) {
      const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
      const storedEntry = stored.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
      assert.ok(storedEntry?.ocr, 'The previous reparse wrote a well-formed record')
      corrupt(storedEntry.ocr as unknown as Record<string, unknown>)
      fs.writeFileSync(manifestPath, JSON.stringify(stored, null, 2))
      fs.writeFileSync(markerPath, marker)

      const output = await runOrchestratorCli(inputDir)
      assert.ok(output.includes('PARSE'), `A malformed record must be reparsed, not trusted: ${label}`)
      assert.notEqual(
        fs.readFileSync(markerPath, 'utf-8'),
        marker,
        `The reparse replaces the malformed record's outputs: ${label}`,
      )
    }

    const reparsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
    const repaired = reparsed.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.equal(repaired?.ocr?.status, 'complete')
    assert.deepEqual(repaired?.ocr?.unresolvedPages, [], 'The reparse writes a well-formed record')

    fs.writeFileSync(markerPath, marker)
    const third = await runOrchestratorCli(inputDir)
    assert.ok(third.includes('SKIP'), 'The well-formed reparse converges to normal reuse')
    assert.equal(fs.readFileSync(markerPath, 'utf-8'), marker)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('orchestrator: a partial OCR result from a missing asset is retried once the asset is restored', async () => {
  const emptyAssetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-no-tessdata-'))
  const { manifest, outputDir, tempDir } = await runOrchestrator(
    ['markpdf-mixed-ocr.pdf'],
    [],
    { FILE_PARSER_OCR_DATA_DIR: emptyAssetDir },
  )
  try {
    const failed = manifest.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.equal(failed?.status, 'success', 'A missing OCR asset is not a failed document')
    assert.equal(failed?.ocr?.status, 'partial')
    assert.ok(
      (failed?.ocr?.unresolvedPages.length ?? 0) > 0,
      'The cached result records the pages the broken environment left unread',
    )

    const markerPath = path.join(outputDir, 'markpdf-mixed-ocr.pdf.md')
    const marker = 'STALE PARTIAL RESULT'
    fs.writeFileSync(markerPath, marker)

    // The environment is repaired: the trained-data override is gone.
    const inputDir = path.join(tempDir, 'input')
    const second = await runOrchestratorCli(inputDir)
    assert.ok(
      second.includes('PARSE'),
      'A partial result from a transient environment failure must not be reused forever',
    )
    assert.notEqual(fs.readFileSync(markerPath, 'utf-8'), marker)

    const recovered = JSON.parse(
      fs.readFileSync(path.join(outputDir, '_manifest.json'), 'utf-8'),
    ) as Manifest
    const repaired = recovered.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.equal(repaired?.ocr?.status, 'complete', 'The repaired environment gets a fresh attempt')
    assert.deepEqual(repaired?.ocr?.unresolvedPages, [])

    fs.writeFileSync(markerPath, marker)
    const third = await runOrchestratorCli(inputDir)
    assert.ok(third.includes('SKIP'), 'A complete result resumes normal reuse')
    assert.equal(fs.readFileSync(markerPath, 'utf-8'), marker)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.rmSync(emptyAssetDir, { recursive: true, force: true })
  }
})

test('orchestrator: complete PDF results and non-PDF files keep incremental reuse', async () => {
  const { manifest, outputDir, tempDir } = await runOrchestrator([
    'markpdf-mixed-ocr.pdf',
    'notes.txt',
  ])
  try {
    const pdf = manifest.files.find((file) => file.source === 'markpdf-mixed-ocr.pdf')
    assert.equal(pdf?.ocr?.status, 'complete')
    assert.deepEqual(pdf?.ocr?.unresolvedPages, [])

    const marker = 'REUSE MARKER'
    const pdfMarkerPath = path.join(outputDir, pdf!.outputs.text)
    const txtMarkerPath = path.join(
      outputDir,
      manifest.files.find((file) => file.source === 'notes.txt')!.outputs.text,
    )
    fs.writeFileSync(pdfMarkerPath, marker)
    fs.writeFileSync(txtMarkerPath, marker)

    const second = await runOrchestratorCli(path.join(tempDir, 'input'))
    assert.ok(second.includes('0 parsed'), 'Nothing is reparsed')
    assert.equal(fs.readFileSync(pdfMarkerPath, 'utf-8'), marker, 'A complete PDF result is reused')
    assert.equal(fs.readFileSync(txtMarkerPath, 'utf-8'), marker, 'A non-PDF result is reused')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

// ── Every uploadable format either parses, or refuses with a remedy ──

test('orchestrator: OpenDocument and Rich Text uploads route to a parser that reads them', async () => {
  const expectations: Array<{ source: string; content: string }> = [
    { source: 'field-notes.odt', content: 'Membrane Rollout Notes' },
    { source: 'yield-data.ods', content: 'Farm Gamma' },
    { source: 'pilot-review.odp', content: 'Pilot Cohort Review' },
    { source: RICH_TEXT_FIXTURE.fileName, content: RICH_TEXT_FIXTURE.heading },
  ]
  const { manifest, outputDir, tempDir } = await runOrchestrator(
    expectations.map((expectation) => expectation.source),
  )

  try {
    assert.equal(
      manifest.files.length,
      expectations.length,
      'Every OpenDocument and Rich Text fixture reached the orchestrator',
    )
    for (const { source, content } of expectations) {
      const entry = manifest.files.find((file) => file.source === source)
      assert.ok(entry, `${source} is in the manifest`)
      assert.equal(entry.status, 'success', `${source} parsed: ${entry.error ?? ''}`)
      const output = entry.outputs.text
      assert.ok(output, `${source} produced markdown`)
      const markdown = fs.readFileSync(path.join(outputDir, output), 'utf-8')
      assert.ok(
        markdown.includes(content),
        `${source} markdown carries its content, got: ${markdown.slice(0, 400)}`,
      )
    }
  } finally {
    cleanup(tempDir)
  }
})

test('orchestrator: a format no reader here opens refuses with a remedy, not a library error', async () => {
  const expectations: Array<{ source: string; format: string; saveAs: string }> = [
    { source: 'legacy-report.doc', format: '.doc', saveAs: '.docx' },
    { source: 'legacy-book.xls', format: '.xls', saveAs: '.xlsx' },
    { source: 'legacy-deck.ppt', format: '.ppt', saveAs: '.pptx' },
    // Not legacy Office, but refused the same way and for the same reason: no reader in this
    // dependency set opens it, so detection says so rather than letting sharp raise.
    { source: BITMAP_FIXTURE.fileName, format: '.bmp', saveAs: '.png' },
  ]
  const { manifest, tempDir } = await runOrchestrator(
    expectations.map((expectation) => expectation.source),
  )

  try {
    assert.equal(
      manifest.files.length,
      expectations.length,
      'Every refused fixture reached the orchestrator',
    )
    for (const { source, format, saveAs } of expectations) {
      const entry = manifest.files.find((file) => file.source === source)
      assert.ok(entry, `${source} is in the manifest`)
      assert.equal(entry.status, 'error', `${source} refuses rather than claiming success`)
      assert.equal(entry.type, 'unsupported', `${source} is detected as unsupported, not routed`)

      const message = entry.error ?? ''
      assert.ok(
        message.includes(format),
        `${source} names the format it refused, got: ${message}`,
      )
      assert.ok(
        message.includes(saveAs),
        `${source} names the format to save as, got: ${message}`,
      )
      assert.ok(
        /invalid signature|central directory|end of central|ENOENT|EXTENSION_UNSUPPORTED|Input file contains|0x[0-9a-f]{4,}/i.test(message) === false,
        `${source} refusal is written for a person, not raised by a library: ${message}`,
      )

      assert.ok(
        entry.unsupported?.reason === 'legacy_binary_office' ||
          entry.unsupported?.reason === 'unreadable_image_codec',
        `${source} records why it was refused in the manifest`,
      )
      assert.equal(entry.unsupported?.extension, format)
      assert.ok(
        entry.unsupported?.remedy.includes(saveAs),
        `${source} carries the remedy alongside the message`,
      )
      assert.deepEqual(entry.outputs, {}, `${source} produces no parsed output`)
    }
  } finally {
    cleanup(tempDir)
  }
})

// ── The harness that keeps every test above honest ──

/**
 * `runOrchestrator` throws when a fixture a test names is not on disk. That guard was added
 * unprotected: reverting it to the `existsSync` branch it replaced — copy the fixture if present,
 * skip it otherwise — turned nothing red, because the orchestrator would then run over an empty
 * directory and every assertion about that file would be skipped along with it.
 *
 * This is the test for the guard. Under the old branch it fails: the run reaches the CLI, no
 * manifest is written, and the rejection is a `JSON.parse`/ENOENT rather than the named fixture.
 */
test('the orchestrator harness refuses to run a test whose fixture is missing', async () => {
  await assert.rejects(
    () => runOrchestrator(['no-such-fixture.docx']),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Fixture not on disk/)
      assert.match(error.message, /no-such-fixture\.docx/)
      assert.match(error.message, /npm run fixtures/)
      return true
    },
  )
})

test('the orchestrator harness runs normally when the fixture it names is present', async () => {
  const { manifest, tempDir } = await runOrchestrator(['notes.txt'])
  try {
    assert.deepEqual(
      manifest.files.map((file) => file.source),
      ['notes.txt'],
      'the guard admits a fixture that is on disk',
    )
  } finally {
    cleanup(tempDir)
  }
})
