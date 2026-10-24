/**
 * DOCX Parser
 *
 * Converts DOCX to HTML via mammoth, then to Markdown via turndown.
 * Extracts embedded images to the output directory.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { tables } from '@truto/turndown-plugin-gfm'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import type { ParseResult } from '../types.js'
import { parseFailureResult } from '../utils/parse-failure.js'
import { wrapDocument } from '../utils/markdown.js'

function createDocxMarkdownConverter(): TurndownService {
  const converter = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  })
  converter.use(tables)
  return converter
}

export async function parseDocx(
  filePath: string,
  outputDir: string,
): Promise<ParseResult> {
  const fileName = path.basename(filePath)

  try {
    const sizeBytes = fs.statSync(filePath).size
    // Track extracted images
    const imageOutputs: string[] = []
    let imageIndex = 0

    const result = await mammoth.convertToHtml(
      { path: filePath },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          imageIndex++
          const ext = image.contentType?.split('/')[1] || 'png'
          const imgName = `${fileName}.img-${String(imageIndex).padStart(2, '0')}.${ext}`
          const imgPath = path.join(outputDir, imgName)

          const buffer = await image.read()
          fs.writeFileSync(imgPath, buffer)
          imageOutputs.push(imgName)

          // Return relative path for the markdown
          return { src: imgName }
        }),
      },
    )

    // Convert HTML to Markdown
    const markdown = createDocxMarkdownConverter().turndown(result.value)

    const metadata: Record<string, unknown> = {
      type: 'docx',
      images_extracted: imageOutputs.length,
    }
    if (result.messages.length > 0) {
      metadata["warnings"] = result.messages.map(m => m.message)
    }

    const mdContent = wrapDocument(fileName, markdown, metadata)
    const mdPath = path.join(outputDir, `${fileName}.md`)
    fs.writeFileSync(mdPath, mdContent)

    const outputs: Record<string, string> = {
      text: `${fileName}.md`,
    }
    if (imageOutputs.length > 0) {
      outputs["images"] = imageOutputs.join(', ')
    }

    return {
      source: fileName,
      type: 'docx',
      sizeBytes,
      outputs,
      metadata,
      status: 'success',
    }
  } catch (err) {
    return parseFailureResult({ fileName, type: 'docx', cause: err })
  }
}
