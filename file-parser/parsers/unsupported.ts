/**
 * Unsupported Format Refusal
 *
 * Not a parser: the terminus for a format detection knows nothing here can read. It produces the
 * package's ordinary failure shape — `status: 'error'` with an `error` message, which is what the
 * desktop app renders next to the upload — so no caller needs a new branch to show it. That
 * message therefore has to carry everything a person needs: the format by name, and the remedy.
 *
 * The typed `unsupported` field is written beside it, but it goes no further than
 * `_manifest.json`: `FileSourceRepository` maps `error` and nothing else. It is for this package's
 * orchestrator and for anyone reading the manifest, not for app code.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ParseResult } from '../types.js'
import { unsupportedFormat } from '../utils/detect.js'

export function parseUnsupported(filePath: string): ParseResult {
  const fileName = path.basename(filePath)
  const format = unsupportedFormat(fileName)
  const sizeBytes = fs.statSync(filePath, { throwIfNoEntry: false })?.size ?? 0

  if (!format) {
    // Routing and the refusal table disagree, which is a defect in this package rather than
    // anything the person who uploaded the file can fix. Say so plainly instead of guessing.
    return {
      source: fileName,
      type: 'unsupported',
      sizeBytes,
      outputs: {},
      metadata: { type: 'unsupported' },
      status: 'error',
      error: `${fileName} was routed as an unsupported format, but no refusal is recorded for it. This is a file-parser defect; please report it.`,
    }
  }

  return {
    source: fileName,
    type: 'unsupported',
    sizeBytes,
    outputs: {},
    metadata: {
      type: 'unsupported',
      unsupported_reason: format.reason,
      original_format: format.extension.replace('.', ''),
    },
    status: 'error',
    unsupported: format,
    error: `${format.format} files cannot be read — ${format.remedy}.`,
  }
}
