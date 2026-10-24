/**
 * Input file loading utility.
 *
 * Reads text content from an input directory, preferring parsed/
 * subdirectory output from file-parser when available. Never reads
 * binary files (PDF, images, Office docs) as UTF-8.
 */

import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FileParserLauncher } from '../core/file-parser-launcher.js'

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.xml', '.html'])
const ENRICHED_SUFFIX = '.enriched.md'
const PAGE_MAP_SUFFIX = '.pages.md'
const STRUCTURED_SUFFIX = '.structure.md'

function getPreferredParsedMarkdownFiles(parsedDir: string): string[] {
  const files = fs.readdirSync(parsedDir).filter((f) => {
    const full = path.join(parsedDir, f)
    return fs.statSync(full).isFile() && !f.startsWith('.') && f.endsWith('.md')
  })

  const outputsByBase = new Map<string, {
    text?: string
    structure?: string
    pageMap?: string
    enriched?: string
  }>()
  for (const file of files.sort()) {
    const base = file.endsWith(ENRICHED_SUFFIX)
      ? file.slice(0, -ENRICHED_SUFFIX.length)
      : file.endsWith(PAGE_MAP_SUFFIX)
        ? file.slice(0, -PAGE_MAP_SUFFIX.length)
      : file.endsWith(STRUCTURED_SUFFIX)
        ? file.slice(0, -STRUCTURED_SUFFIX.length)
      : file.endsWith('.md')
        ? file.slice(0, -3)
        : file
    const outputs = outputsByBase.get(base) ?? {}
    if (file.endsWith(ENRICHED_SUFFIX)) {
      outputs.enriched = file
    } else if (file.endsWith(PAGE_MAP_SUFFIX)) {
      outputs.pageMap = file
    } else if (file.endsWith(STRUCTURED_SUFFIX)) {
      outputs.structure = file
    } else {
      outputs.text = file
    }
    outputsByBase.set(base, outputs)
  }

  return [...outputsByBase.values()]
    .flatMap((outputs) => [outputs.text ?? outputs.structure, outputs.pageMap, outputs.enriched])
    .filter((file): file is string => Boolean(file))
}

export function getPreferredParsedMarkdownPaths(inputDir: string): string[] {
  const parsedDir = path.join(inputDir, 'parsed')
  if (!fs.existsSync(parsedDir) || !fs.statSync(parsedDir).isDirectory()) return []
  return getPreferredParsedMarkdownFiles(parsedDir).map((file) => path.join(parsedDir, file))
}

/**
 * Auto-trigger file-parser if binary files exist in inputDir.
 *
 * Logic:
 * 1. If inputDir doesn't exist → skip.
 * 2. If no binary files (non-text-extension files, excluding parsed/ subdir) → skip.
 * 3. Otherwise invoke the configured launcher and wait for it to finish.
 *
 * The parser owns manifest/mtime freshness checks. Existing Markdown output
 * cannot prove that every source is current.
 */
export async function ensureParsed(
  inputDir: string,
  launcher: FileParserLauncher,
  signal?: AbortSignal,
): Promise<void> {
  if (!fs.existsSync(inputDir)) return

  // Check for binary files (files with extensions NOT in TEXT_EXTENSIONS, excluding parsed/ subdir)
  const entries = fs.readdirSync(inputDir).filter((f) => !f.startsWith('.') && f !== 'parsed')
  const binaryFiles = entries.filter((f) => {
    const full = path.join(inputDir, f)
    if (!fs.statSync(full).isFile()) return false
    const ext = path.extname(f).toLowerCase()
    return !TEXT_EXTENSIONS.has(ext)
  })

  if (binaryFiles.length === 0) return

  try {
    await launcher.parseDirectory(inputDir, { ...whenDefined(signal, (definedValue) => ({ signal: definedValue })) })
  } catch (error) {
    console.error('[ensureParsed] File parser failed:', error)
  }
}

/**
 * Load text content from an input directory.
 *
 * Priority:
 * 1. If `<inputDir>/parsed/` exists and has `.md` files, read those only.
 * 2. Otherwise, read text-safe extensions from the root inputDir.
 * 3. Return '' if directory is empty / missing.
 */
export function loadInputFiles(inputDir: string): string {
  if (!fs.existsSync(inputDir)) return ''

  // Check if there are any non-hidden entries at all (including subdirs)
  const allEntries = fs.readdirSync(inputDir).filter((f) => !f.startsWith('.'))
  if (allEntries.length === 0) return ''

  // Prefer parsed/ subdirectory: file-parser writes extracted text here as .md files
  const parsedDir = path.join(inputDir, 'parsed')
  if (fs.existsSync(parsedDir) && fs.statSync(parsedDir).isDirectory()) {
    const mdFiles = getPreferredParsedMarkdownFiles(parsedDir)
    if (mdFiles.length > 0) {
      const sections: string[] = []
      for (const file of mdFiles) {
        const content = fs.readFileSync(path.join(parsedDir, file), 'utf-8')
        sections.push(`## ${file}\n\n${content}`)
      }
      return sections.join('\n\n---\n\n')
    }
  }

  // Fallback: read only text-safe extensions from the root inputDir (never binary files)
  const textFiles = fs.readdirSync(inputDir).filter((f) => {
    const full = path.join(inputDir, f)
    if (!fs.statSync(full).isFile()) return false
    if (f.startsWith('.')) return false
    return TEXT_EXTENSIONS.has(path.extname(f).toLowerCase())
  })

  if (textFiles.length === 0) return ''

  const sections: string[] = []
  for (const file of textFiles) {
    const content = fs.readFileSync(path.join(inputDir, file), 'utf-8')
    sections.push(`## ${file}\n\n${content}`)
  }

  return sections.join('\n\n---\n\n')
}
