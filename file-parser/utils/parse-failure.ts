/**
 * What a person is told when a parse fails, and where the library's own words go instead.
 *
 * Every parser in this package delegates to a library, and each library raises in its own idiom.
 * A .docx that is not a ZIP produced `Can't find end of central directory : is this a zip file ? If
 * it is, see https://stuk.github.io/jszip/...`; a .xlsx holding a PDF produced `invalid signature:
 * 0x46445025`; officeparser prefixed itself in brackets; sharp named a codec; `fs` interpolated the
 * absolute path of a workspace temp directory. All of it reached the desktop app verbatim, because
 * `ui/src/components/shared/file-format.ts` renders `parserError` as `error: <text>` on the card
 * beside the upload.
 *
 * None of that is actionable, and the path is not the app's to disclose. So the message a person
 * reads is composed here from two things this package is sure of — the file's own name and the
 * format its extension claims — and the library's text is written to `metadata.library_error`,
 * which lives in `_manifest.json` and never crosses `FileSourceRepository`'s boundary into the UI.
 */

import * as path from 'node:path'
import type { ParseResult, ParserType } from '../types.js'

/**
 * How a person names the format an extension claims.
 *
 * Only formats this package routes at a reader are listed. Anything else falls back to the
 * extension in capitals, which is still a name a person recognises.
 */
const FORMAT_NAMES: Record<string, string> = {
  '.pdf': 'a PDF',
  '.docx': 'a Word .docx document',
  '.xlsx': 'an Excel .xlsx workbook',
  '.pptx': 'a PowerPoint .pptx presentation',
  '.odt': 'an OpenDocument .odt document',
  '.ods': 'an OpenDocument .ods spreadsheet',
  '.odp': 'an OpenDocument .odp presentation',
  '.rtf': 'an RTF document',
  '.jpg': 'a JPEG image',
  '.jpeg': 'a JPEG image',
  '.png': 'a PNG image',
  '.gif': 'a GIF image',
  '.webp': 'a WebP image',
  '.heic': 'a HEIF image',
  '.heif': 'a HEIF image',
  '.tif': 'a TIFF image',
  '.tiff': 'a TIFF image',
  '.svg': 'an SVG image',
}

/**
 * Extensions read as bytes rather than parsed as a container.
 *
 * A failure on one of these is almost never "these are not the bytes of that format" — the file is
 * missing, unreadable, or the output could not be written — so they get the wording that does not
 * accuse the file of lying about itself.
 */
const UNSTRUCTURED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.csv',
  '.log', '.ini', '.toml', '.env', '.sh', '.bash', '.zsh',
])

/** The format an extension claims, as a person names it, or null when it claims nothing in particular. */
export function claimedFormatName(fileName: string): string | null {
  const extension = path.extname(fileName).toLowerCase()
  if (UNSTRUCTURED_EXTENSIONS.has(extension)) return null
  const known = FORMAT_NAMES[extension]
  if (known) return known
  if (extension.length <= 1) return null
  return `a ${extension.slice(1).toUpperCase()} file`
}

/** The sentence a person reads when `fileName` could not be parsed. Never carries a path. */
export function parseFailureMessage(fileName: string): string {
  const format = claimedFormatName(fileName)
  if (!format) {
    return `${fileName} could not be read. The file may be damaged, or this app could not open it — check that it still opens where it came from, then upload it again.`
  }
  return `${fileName} could not be read as ${format}. It is either damaged or not really ${format} — open it where it came from, save it again, and upload it again.`
}

/**
 * The failure result every parser returns from its catch.
 *
 * `sizeBytes: 0` matches what each parser already reported on failure: the byte count came from a
 * `statSync` that may itself be the call that threw.
 */
export function parseFailureResult(options: {
  fileName: string
  type: ParserType
  cause: unknown
}): ParseResult {
  const { fileName, type, cause } = options
  return {
    source: fileName,
    type,
    sizeBytes: 0,
    outputs: {},
    metadata: {
      type,
      parse_failure: 'unreadable',
      // Kept, not discarded: this is the only record of what actually went wrong, and the manifest
      // is where someone diagnosing a parse looks. It never reaches the card in the UI.
      library_error: cause instanceof Error ? cause.message : String(cause),
    },
    status: 'error',
    error: parseFailureMessage(fileName),
  }
}
