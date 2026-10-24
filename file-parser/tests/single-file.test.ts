/**
 * Single-file mode: `index.ts --file <absolute file> --output <absolute dir> [--local-only]`.
 *
 * Folder indexing parses one document from a user's folder into an output folder the app owns.
 * These tests run the real CLI as a child process and check what it leaves on disk: the parsed
 * document and its manifest in the output folder, and nothing at all in the user's folder.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import PDFDocument from 'pdfkit'
import { MIXED_OCR_FIXTURE } from './mixed-ocr-expectations.js'

const PARSER_DIR = path.resolve(import.meta.dirname, '..')
const PARSER_ENTRY = path.join(PARSER_DIR, 'index.ts')
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const MIXED_FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', MIXED_OCR_FIXTURE.fileName)

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

/** Run the parser CLI to completion and report how it exited. */
function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, PARSER_ENTRY, ...args], {
      cwd: options.cwd ?? PARSER_DIR,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function assertExitedCleanly(run: CliRun): void {
  assert.equal(run.code, 0, `parser exited ${String(run.code)}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ManifestEntry {
  source: string
  status: string
  outputs: Record<string, string>
  metadata: Record<string, unknown>
}

function toManifestEntry(value: unknown): ManifestEntry {
  if (!isRecord(value)) throw new Error('A manifest entry is not an object')
  const { source, status, outputs, metadata } = value
  if (typeof source !== 'string' || typeof status !== 'string') {
    throw new Error('A manifest entry has no source or status')
  }
  if (!isRecord(outputs) || !isRecord(metadata)) {
    throw new Error('A manifest entry has no outputs or metadata')
  }
  const outputPaths: Record<string, string> = {}
  for (const [key, output] of Object.entries(outputs)) {
    if (typeof output === 'string') outputPaths[key] = output
  }
  return { source, status, outputs: outputPaths, metadata }
}

function readManifestEntries(outputDir: string): ManifestEntry[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(outputDir, '_manifest.json'), 'utf-8'))
  if (!isRecord(raw) || !Array.isArray(raw['files'])) {
    throw new Error('The manifest has no file list')
  }
  return raw['files'].map((entry: unknown) => toManifestEntry(entry))
}

function onlyEntry(outputDir: string): ManifestEntry {
  const entries = readManifestEntries(outputDir)
  assert.equal(entries.length, 1, 'The manifest describes exactly one file')
  const entry = entries[0]
  assert.ok(entry)
  return entry
}

function readTextOutput(outputDir: string, entry: ManifestEntry): string {
  const textOutput = entry.outputs['text']
  assert.ok(textOutput, `${entry.source} has a text output`)
  return fs.readFileSync(path.join(outputDir, textOutput), 'utf-8')
}

/**
 * Every entry under `root`, with its size and modification time. A directory's modification time
 * changes when anything is created in it, even briefly, so equal snapshots mean nothing was
 * written there at all.
 */
function snapshotTree(root: string): string[] {
  const rows = [`.|dir|${fs.statSync(root).mtimeMs}`]
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const fullPath = path.join(entry.parentPath, entry.name)
    const stat = fs.lstatSync(fullPath)
    const kind = stat.isDirectory() ? 'dir' : String(stat.size)
    rows.push(`${path.relative(root, fullPath)}|${kind}|${stat.mtimeMs}`)
  }
  return rows.sort()
}

function makeTempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-parser-single-')))
}

/** A short one-page PDF whose only text is `line`. */
function writeOneLinePdf(filePath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 })
    const stream = fs.createWriteStream(filePath)
    doc.pipe(stream)
    doc.fontSize(20).text(line)
    stream.on('close', resolve)
    stream.on('error', reject)
    doc.on('error', reject)
    doc.end()
  })
}

interface Sentinel {
  baseUrl: string
  requestCount(): number
  close(): Promise<void>
}

/** A loopback endpoint that counts every request reaching it and answers with an error. */
async function startSentinel(): Promise<Sentinel> {
  let requests = 0
  const server = http.createServer((request, response) => {
    requests += 1
    request.resume()
    request.on('end', () => {
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('enrichment sentinel')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('The sentinel did not get a loopback port.')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestCount: () => requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => (error ? reject(error) : resolve()))
    }),
  }
}

function enrichmentSwitchedOn(baseUrl: string): Record<string, string> {
  return {
    FILE_PARSER_LLM_ENABLED: '1',
    FILE_PARSER_LM_ENABLED: '1',
    FILE_PARSER_LLM_PROVIDER: 'openai',
    FILE_PARSER_LLM_MODEL: 'sentinel-model',
    FILE_PARSER_OPENAI_API_KEY: 'sentinel-key',
    FILE_PARSER_OPENAI_BASE_URL: baseUrl,
  }
}

test('single-file mode writes only into its output folder and leaves the document folder unchanged', async () => {
  const root = makeTempRoot()
  try {
    const sharedFolder = path.join(root, 'shared', 'Reports')
    fs.mkdirSync(sharedFolder, { recursive: true })
    const document = path.join(sharedFolder, MIXED_OCR_FIXTURE.fileName)
    fs.copyFileSync(MIXED_FIXTURE_PATH, document)
    fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'notes.txt'), path.join(sharedFolder, 'notes.txt'))
    const outputDir = path.join(root, 'cache', 'document-1')
    const sharedBefore = snapshotTree(path.join(root, 'shared'))

    const run = await runCli(['--file', document, '--output', outputDir])

    assertExitedCleanly(run)
    assert.deepEqual(snapshotTree(path.join(root, 'shared')), sharedBefore, 'Nothing was written in the user folder')
    assert.deepEqual(fs.readdirSync(root).sort(), ['cache', 'shared'], 'Nothing was written beside it either')
    const entry = onlyEntry(outputDir)
    assert.equal(entry.source, MIXED_OCR_FIXTURE.fileName, 'Only the named file was parsed')
    assert.equal(entry.status, 'success')
    for (const output of Object.values(entry.outputs)) {
      assert.ok(fs.existsSync(path.join(outputDir, output)), `${output} is in the output folder`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('two documents with the same name in different folders each keep their own text in their own output folder', async () => {
  const root = makeTempRoot()
  try {
    const acmeText = 'Acme Holdings master agreement renewal 2031'
    const globexText = 'Globex Corporation master agreement renewal 2034'
    const acmeDocument = path.join(root, 'shared', 'Clients', 'Acme', 'MSA.pdf')
    const globexDocument = path.join(root, 'shared', 'Clients', 'Globex', 'MSA.pdf')
    fs.mkdirSync(path.dirname(acmeDocument), { recursive: true })
    fs.mkdirSync(path.dirname(globexDocument), { recursive: true })
    await writeOneLinePdf(acmeDocument, acmeText)
    await writeOneLinePdf(globexDocument, globexText)
    const acmeOutput = path.join(root, 'cache', 'acme-msa')
    const globexOutput = path.join(root, 'cache', 'globex-msa')

    const runs = await Promise.all([
      runCli(['--file', acmeDocument, '--output', acmeOutput]),
      runCli(['--file', globexDocument, '--output', globexOutput]),
    ])

    for (const run of runs) assertExitedCleanly(run)
    const acmeParsed = readTextOutput(acmeOutput, onlyEntry(acmeOutput))
    const globexParsed = readTextOutput(globexOutput, onlyEntry(globexOutput))
    assert.ok(acmeParsed.includes(acmeText), `Acme's MSA.pdf keeps its text, got: ${acmeParsed.slice(0, 300)}`)
    assert.ok(!acmeParsed.includes(globexText), "Acme's output holds none of Globex's text")
    assert.ok(globexParsed.includes(globexText), `Globex's MSA.pdf keeps its text, got: ${globexParsed.slice(0, 300)}`)
    assert.ok(!globexParsed.includes(acmeText), "Globex's output holds none of Acme's text")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('--local-only contacts no model even when the environment switches enrichment on', async () => {
  const sentinel = await startSentinel()
  const root = makeTempRoot()
  try {
    const document = path.join(root, MIXED_OCR_FIXTURE.fileName)
    fs.copyFileSync(MIXED_FIXTURE_PATH, document)
    const outputDir = path.join(root, 'output')

    const run = await runCli(
      ['--file', document, '--output', outputDir, '--local-only'],
      { env: enrichmentSwitchedOn(sentinel.baseUrl) },
    )

    assertExitedCleanly(run)
    assert.equal(sentinel.requestCount(), 0, 'No request reached the enrichment endpoint')
    const entry = onlyEntry(outputDir)
    assert.equal(entry.status, 'success')
    assert.equal(entry.metadata['enrichment_error'], undefined, 'Enrichment was never attempted')
    assert.ok(
      readTextOutput(outputDir, entry).includes(MIXED_OCR_FIXTURE.page10.title),
      'Local OCR still read the page that exists only as pixels',
    )
  } finally {
    await sentinel.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('without --local-only, single-file mode enriches when the environment says so', async () => {
  const sentinel = await startSentinel()
  const root = makeTempRoot()
  try {
    const document = path.join(root, MIXED_OCR_FIXTURE.fileName)
    fs.copyFileSync(MIXED_FIXTURE_PATH, document)
    const outputDir = path.join(root, 'output')

    const run = await runCli(
      ['--file', document, '--output', outputDir],
      { env: enrichmentSwitchedOn(sentinel.baseUrl) },
    )

    assertExitedCleanly(run)
    assert.ok(sentinel.requestCount() > 0, 'This document and environment request enrichment')
  } finally {
    await sentinel.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('single-file mode refuses a relative path and writes nothing', async () => {
  const root = makeTempRoot()
  try {
    fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'notes.txt'), path.join(root, 'notes.txt'))
    const before = snapshotTree(root)

    const run = await runCli(['--file', 'notes.txt', '--output', 'output'], { cwd: root })

    assert.notEqual(run.code, 0)
    assert.match(run.stderr, /--file must be an absolute path/)
    assert.deepEqual(snapshotTree(root), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
