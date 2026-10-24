/**
 * Image Parser
 *
 * Extracts metadata with sharp, creates a resized thumbnail.
 * Flags the image as requiring LLM for content understanding.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import sharp from 'sharp'
import type { ParseResult } from '../types.js'
import { parseFailureResult } from '../utils/parse-failure.js'

const MAX_THUMBNAIL_EDGE = 1200

export async function parseImage(
  filePath: string,
  outputDir: string,
): Promise<ParseResult> {
  const fileName = path.basename(filePath)

  try {
    const sizeBytes = fs.statSync(filePath).size
    const image = sharp(filePath)
    const meta = await image.metadata()

    const metadata: Record<string, unknown> = {
      type: 'image',
      format: meta.format,
      width: meta.width,
      height: meta.height,
      channels: meta.channels,
      space: meta.space,
      has_alpha: meta.hasAlpha,
    }

    // Extract EXIF if available
    if (meta.exif) {
      try {
        // sharp returns raw EXIF buffer — store basic info
        metadata["has_exif"] = true
        if (meta.density) metadata["dpi"] = meta.density
      } catch {
        // EXIF parsing is best-effort
      }
    }

    if (meta.orientation) metadata["orientation"] = meta.orientation

    const outputs: Record<string, string> = {}

    // Write metadata JSON
    const metaJsonPath = path.join(outputDir, `${fileName}.json`)
    const metaJson = {
      source: fileName,
      ...metadata,
      requires_llm: true,
      note: 'Image content not analyzed. Metadata only. LLM required for content description.',
    }
    fs.writeFileSync(metaJsonPath, JSON.stringify(metaJson, null, 2))
    outputs["metadata"] = `${fileName}.json`

    // Create thumbnail
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width > 0 && height > 0) {
      const longestEdge = Math.max(width, height)
      const thumbPath = path.join(outputDir, `${fileName}.thumb.jpg`)

      if (longestEdge > MAX_THUMBNAIL_EDGE) {
        await image
          .resize({
            width: width >= height ? MAX_THUMBNAIL_EDGE : undefined,
            height: height > width ? MAX_THUMBNAIL_EDGE : undefined,
            fit: 'inside',
          })
          .jpeg({ quality: 80 })
          .toFile(thumbPath)
      } else {
        // Already small enough — just convert to JPEG
        await image
          .jpeg({ quality: 85 })
          .toFile(thumbPath)
      }
      outputs["thumbnail"] = `${fileName}.thumb.jpg`
    }

    return {
      source: fileName,
      type: 'image',
      sizeBytes,
      outputs,
      metadata,
      status: 'success',
      requiresLlm: true,
      note: 'Image content not analyzed (LLM required)',
    }
  } catch (err) {
    return parseFailureResult({ fileName, type: 'image', cause: err })
  }
}
