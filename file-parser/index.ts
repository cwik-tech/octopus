#!/usr/bin/env npx tsx
/**
 * File Parser Toolkit — Orchestrator
 *
 * Scans an input directory, detects file types, routes to the
 * appropriate parser, and writes results to a `parsed/` subfolder
 * with a `_manifest.json` index.
 *
 * Usage:
 *   npx tsx index.ts <input-dir> [--force]
 *   npx tsx index.ts ../input-files
 *   npx tsx index.ts ../input-files --force
 *   npx tsx index.ts --file <absolute file> --output <absolute dir> [--local-only]
 */

// First on purpose: it applies --local-only before any other parser module loads.
import { LOCAL_ONLY_ENV, LOCAL_ONLY_FLAG } from './local-only.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileInfo, Manifest, ParseResult, ParseOptions } from './types.js'
import { detectType, shouldSkip } from './utils/detect.js'
import { parsePdf } from './parsers/pdf.js'
import { parseDocx } from './parsers/docx.js'
import { parseXlsx } from './parsers/xlsx.js'
import { parseImage } from './parsers/image.js'
import { parsePptx } from './parsers/pptx.js'
import { parseGeneric } from './parsers/generic.js'
import { parseUnsupported } from './parsers/unsupported.js'
import { ocrContractIdentity, parsePdfOcrSummary, parsedResultMatchesOcrContract } from './ocr/contract.js'

const PARSER_VERSION = '0.1.0'
const MANIFEST_FILE = '_manifest.json'
const PARSED_DIR = 'parsed'

/** Scan input directory and return file info for each parseable file */
function scanInputDir(inputDir: string): FileInfo[] {
  const entries = fs.readdirSync(inputDir, { withFileTypes: true })
  const files: FileInfo[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (shouldSkip(entry.name)) continue

    const fullPath = path.join(inputDir, entry.name)
    const stat = fs.statSync(fullPath)

    files.push({
      name: entry.name,
      path: fullPath,
      sizeBytes: stat.size,
      type: detectType(entry.name),
    })
  }

  return files.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load existing manifest to check what's already parsed */
function loadManifest(outputDir: string): Manifest | null {
  const manifestPath = path.join(outputDir, MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) return null

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    return JSON.parse(raw) as Manifest
  } catch {
    return null
  }
}

/** Check if a file needs re-parsing (source newer than parsed output) */
function needsParsing(
  file: FileInfo,
  outputDir: string,
  existingManifest: Manifest | null,
  force: boolean,
): boolean {
  if (force) return true
  if (!existingManifest) return true

  const existing = existingManifest.files.find(f => f.source === file.name)
  if (!existing) return true
  if (existing.status === 'error') return true
  // Reuse identity includes the OCR contract: a result produced under different recognition
  // settings is not the result those settings describe.
  if (!parsedResultMatchesOcrContract(existing)) return true
  // A PDF result whose local recognition never finished records an environment that failed at
  // parse time; reusing it would make that failure permanent.
  if (pdfOcrResultIsUnfinished(existing)) return true

  // Check if any output file exists
  const firstOutput = Object.values(existing.outputs)[0]
  if (!firstOutput) return true

  const outputPath = path.join(outputDir, firstOutput)
  if (!fs.existsSync(outputPath)) return true

  // Check if source is newer than output
  const sourceStat = fs.statSync(file.path)
  const outputStat = fs.statSync(outputPath)
  return sourceStat.mtimeMs > outputStat.mtimeMs
}

/**
 * Whether a stored PDF result's local recognition still needs a fresh attempt.
 *
 * The manifest is external input, so this reads it defensively. A result with no `ocr` key is
 * one of two things, told apart by the contract identity the current parser writes into
 * metadata: no identity at all means the manifest predates local recognition and is reparsed
 * once under the current contract, while the current identity means the compatibility engine
 * legitimately produced no recognition and the result is finished. A result whose recognition
 * is partial, cancelled, or left pages unresolved reflects a parse-time environment failure,
 * and treating it as stale lets a repaired environment retry. Well-formedness is decided by the
 * contract's own validator (`parsePdfOcrSummary`), which fails closed: a record that only
 * resembles what this package writes — including one claiming completion without a valid page
 * list — is distrusted, and the reparse it triggers writes a well-formed one. Non-PDF entries
 * and complete PDF results keep normal incremental reuse.
 */
function pdfOcrResultIsUnfinished(entry: ParseResult): boolean {
  if (entry.type !== 'pdf') return false
  const ocr: unknown = entry.ocr
  if (ocr === undefined || ocr === null) {
    const metadata = entry.metadata
    const identity =
      typeof metadata === 'object' && metadata !== null
        ? metadata["ocr_contract_identity"]
        : undefined
    return identity !== ocrContractIdentity()
  }
  const summary = parsePdfOcrSummary(ocr)
  if (summary === null) return true
  return summary.status !== 'complete' || summary.unresolvedPages.length > 0
}

/** Route a file to the appropriate parser */
async function parseFile(file: FileInfo, outputDir: string): Promise<ParseResult> {
  switch (file.type) {
    case 'pdf': return parsePdf(file.path, outputDir)
    case 'docx': return parseDocx(file.path, outputDir)
    case 'xlsx': return parseXlsx(file.path, outputDir)
    case 'image': return parseImage(file.path, outputDir)
    case 'pptx': return parsePptx(file.path, outputDir)
    case 'generic': return parseGeneric(file.path, outputDir)
    case 'unsupported': return parseUnsupported(file.path)
  }
}

/** Main orchestrator */
async function run(options: ParseOptions): Promise<void> {
  const { inputDir, force } = options
  const absInputDir = path.resolve(inputDir)

  if (!fs.existsSync(absInputDir)) {
    console.error(`Input directory not found: ${absInputDir}`)
    process.exit(1)
  }

  const outputDir = path.join(absInputDir, PARSED_DIR)
  fs.mkdirSync(outputDir, { recursive: true })

  console.log(`\nFile Parser v${PARSER_VERSION}`)
  console.log(`Input:  ${absInputDir}`)
  console.log(`Output: ${outputDir}`)
  if (force) console.log(`Mode:   --force (re-parse all)`)
  console.log('')

  // Scan files
  const files = scanInputDir(absInputDir)
  if (files.length === 0) {
    console.log('No files found to parse.')
    return
  }

  console.log(`Found ${files.length} file(s):\n`)

  // Load existing manifest
  const existingManifest = loadManifest(outputDir)

  // Process each file
  const results: ParseResult[] = []
  let parsed = 0
  let skipped = 0
  let errors = 0

  for (const file of files) {
    const needs = needsParsing(file, outputDir, existingManifest, force)

    if (!needs) {
      // Keep existing result from manifest
      const existing = existingManifest?.files.find(f => f.source === file.name)
      if (existing) results.push(existing)
      console.log(`  SKIP  ${file.name} (already parsed)`)
      skipped++
      continue
    }

    const sizeKb = (file.sizeBytes / 1024).toFixed(0)
    console.log(`  PARSE ${file.name} (${file.type}, ${sizeKb}KB)`)

    const result = await parseFile(file, outputDir)
    results.push(result)

    if (result.status === 'error') {
      console.log(`        ERROR: ${result.error}`)
      errors++
    } else {
      const outputs = Object.values(result.outputs).join(', ')
      const extra: string[] = []
      if (result.classification) extra.push(result.classification)
      if (result.requiresLlm) extra.push('needs-llm')
      if (result.enrichmentApplied) extra.push('enriched')
      const tag = extra.length > 0 ? ` [${extra.join(', ')}]` : ''
      console.log(`        -> ${outputs}${tag}`)
      parsed++
    }
  }

  // Write manifest
  const manifest: Manifest = {
    generated_at: new Date().toISOString(),
    parser_version: PARSER_VERSION,
    input_dir: absInputDir,
    files: results,
  }
  const manifestPath = path.join(outputDir, MANIFEST_FILE)
  writeManifestAtomic(manifestPath, manifest)

  // Summary
  console.log(`\nDone: ${parsed} parsed, ${skipped} skipped, ${errors} errors`)
  console.log(`Manifest: ${manifestPath}`)
}

function writeManifestAtomic(manifestPath: string, manifest: Manifest): void {
  const outputDir = path.dirname(manifestPath)
  const temporaryPath = path.join(
    outputDir,
    `.${path.basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let fileDescriptor: number | undefined
  try {
    fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fileDescriptor)
    fs.closeSync(fileDescriptor)
    fileDescriptor = undefined
    fs.renameSync(temporaryPath, manifestPath)

    let directoryDescriptor: number | undefined
    try {
      directoryDescriptor = fs.openSync(outputDir, 'r')
      fs.fsyncSync(directoryDescriptor)
    } catch {
      // Directory fsync is not supported on every platform.
    } finally {
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
    }
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor)
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // The temporary file was renamed or never created.
    }
  }
}

/** A command-line mistake: reported as its message alone, without a stack. */
class CliUsageError extends Error {}

interface SingleFileOptions {
  filePath: string
  outputDir: string
}

/**
 * Parse exactly one file into `outputDir`, with a manifest describing only that file.
 *
 * Nothing is written next to the file: folder indexing points this at documents in a user's own
 * folder, and the output folder belongs to the app. There is no incremental reuse; the caller
 * decides when a file needs parsing.
 */
async function runSingleFile(options: SingleFileOptions): Promise<void> {
  const { filePath, outputDir } = options
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new CliUsageError(`Input file not found: ${filePath}`)
  }
  if (!stat.isFile()) throw new CliUsageError(`Input is not a file: ${filePath}`)

  fs.mkdirSync(outputDir, { recursive: true })
  const name = path.basename(filePath)
  const file: FileInfo = { name, path: filePath, sizeBytes: stat.size, type: detectType(name) }

  console.log(`\nFile Parser v${PARSER_VERSION}`)
  console.log(`File:   ${filePath}`)
  console.log(`Output: ${outputDir}`)
  if (process.env[LOCAL_ONLY_ENV] === '1') console.log('Mode:   --local-only (no outside model)')
  console.log(`  PARSE ${name} (${file.type}, ${(file.sizeBytes / 1024).toFixed(0)}KB)`)

  const result = await parseFile(file, outputDir)
  if (result.status === 'error') console.log(`        ERROR: ${result.error}`)

  const manifestPath = path.join(outputDir, MANIFEST_FILE)
  writeManifestAtomic(manifestPath, {
    generated_at: new Date().toISOString(),
    parser_version: PARSER_VERSION,
    input_dir: path.dirname(filePath),
    files: [result],
  })
  console.log(`Manifest: ${manifestPath}`)
}

// ── CLI ──

/** Read `--file <absolute file> --output <absolute dir> [--local-only]`, refusing anything else. */
function readSingleFileArgs(args: readonly string[]): SingleFileOptions {
  let filePath: string | undefined
  let outputDir: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === LOCAL_ONLY_FLAG) continue
    if (arg !== '--file' && arg !== '--output') {
      throw new CliUsageError(`Unexpected argument in single-file mode: ${String(arg)}`)
    }
    const value = args[index + 1]
    index++
    if (value === undefined || value.startsWith('--')) throw new CliUsageError(`${arg} needs a path`)
    if (!path.isAbsolute(value)) throw new CliUsageError(`${arg} must be an absolute path`)
    if (arg === '--file') filePath = path.normalize(value)
    else outputDir = path.normalize(value)
  }
  if (filePath === undefined) throw new CliUsageError('--file is required with --output')
  if (outputDir === undefined) throw new CliUsageError('--output is required with --file')
  return { filePath, outputDir }
}

function printUsage(): void {
  console.log('Usage: npx tsx index.ts <input-dir> [--force]')
  console.log('       npx tsx index.ts --file <absolute file> --output <absolute dir> [--local-only]')
  console.log('')
  console.log('Parses files in <input-dir> and writes output to <input-dir>/parsed/,')
  console.log('or parses one file into <absolute dir> and writes nothing next to it.')
  console.log('')
  console.log('Options:')
  console.log('  --force       Re-parse all files even if already parsed')
  console.log('  --local-only  Never send content to an outside model, whatever the environment says')
}

/** The run the arguments ask for, or null when they ask for none. */
function startCli(args: readonly string[]): Promise<void> | null {
  if (args.includes('--file') || args.includes('--output')) {
    return Promise.resolve().then(() => runSingleFile(readSingleFileArgs(args)))
  }
  const inputDir = args.find(a => !a.startsWith('-'))
  if (!inputDir) return null
  return run({ inputDir, force: args.includes('--force') })
}

const job = startCli(process.argv.slice(2))

if (!job) {
  printUsage()
  process.exit(0)
}

job
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    if (err instanceof CliUsageError) {
      console.error(err.message)
    } else {
      console.error('Fatal error:', err)
    }
    process.exit(1)
  })
