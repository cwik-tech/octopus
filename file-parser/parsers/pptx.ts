/**
 * PPTX Parser
 *
 * Parses PowerPoint files using officeparser's AST output,
 * converts to markdown with one section per slide.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import officeparser from 'officeparser'
import type { ParseResult } from '../types.js'
import { parseFailureResult } from '../utils/parse-failure.js'
import { wrapDocument } from '../utils/markdown.js'

export async function parsePptx(
  filePath: string,
  outputDir: string,
): Promise<ParseResult> {
  const fileName = path.basename(filePath)

  try {
    const sizeBytes = fs.statSync(filePath).size
    // officeparser v6+ returns structured AST with toText() method
    const result = await officeparser.parseOffice(filePath)
    const text = typeof result === 'string' ? result : (result as { toText(): string }).toText()

    // officeparser.parseOffice returns plain text for older API
    // Split by common slide separators or double newlines
    const slides = text.split(/\n{3,}/).filter(s => s.trim().length > 0)

    const mdSections: string[] = []
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i]
      if (slide) mdSections.push(`## Slide ${i + 1}\n\n${slide.trim()}`)
    }

    const metadata: Record<string, unknown> = {
      type: 'pptx',
      slides: slides.length,
      total_chars: text.length,
    }

    const mdContent = wrapDocument(
      fileName,
      mdSections.length > 0 ? mdSections.join('\n\n---\n\n') : '_No content extracted._',
      metadata,
    )
    const mdPath = path.join(outputDir, `${fileName}.md`)
    fs.writeFileSync(mdPath, mdContent)

    return {
      source: fileName,
      type: 'pptx',
      sizeBytes,
      outputs: { text: `${fileName}.md` },
      metadata,
      status: 'success',
    }
  } catch (err) {
    return parseFailureResult({ fileName, type: 'pptx', cause: err })
  }
}
