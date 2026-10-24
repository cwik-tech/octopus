/**
 * Generic / Fallback Parser
 *
 * Handles plain text files directly, uses officeparser for
 * office formats not covered by specialized parsers (ODT, RTF, etc.).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import officeparser from 'officeparser'
import type { ParseResult } from '../types.js'
import { parseFailureResult } from '../utils/parse-failure.js'
import { wrapDocument } from '../utils/markdown.js'

/** Extensions that can be read directly as utf-8 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.csv',
  '.log', '.ini', '.toml', '.env', '.sh', '.bash', '.zsh',
])

export async function parseGeneric(
  filePath: string,
  outputDir: string,
): Promise<ParseResult> {
  const fileName = path.basename(filePath)
  const ext = path.extname(filePath).toLowerCase()

  try {
    const sizeBytes = fs.statSync(filePath).size
    let text: string

    if (TEXT_EXTENSIONS.has(ext)) {
      // Read directly as text
      text = fs.readFileSync(filePath, 'utf-8')
    } else {
      // Try officeparser for other formats (ODT, RTF, etc.)
      const result = await officeparser.parseOffice(filePath)
      text = typeof result === 'string' ? result : (result as { toText(): string }).toText()
    }

    const metadata: Record<string, unknown> = {
      type: 'generic',
      original_format: ext.replace('.', '') || 'unknown',
      total_chars: text.length,
    }

    const mdContent = wrapDocument(
      fileName,
      text.trim() || '_No content extracted._',
      metadata,
    )
    const mdPath = path.join(outputDir, `${fileName}.md`)
    fs.writeFileSync(mdPath, mdContent)

    return {
      source: fileName,
      type: 'generic',
      sizeBytes,
      outputs: { text: `${fileName}.md` },
      metadata,
      status: 'success',
    }
  } catch (err) {
    return parseFailureResult({ fileName, type: 'generic', cause: err })
  }
}
