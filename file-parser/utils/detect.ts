/**
 * File type detection by extension
 */

import * as path from 'node:path'
import type { ParserType, UnsupportedFormat } from '../types.js'

/**
 * Formats nothing in this dependency set can read, and what a person should do instead.
 *
 * `.doc`, `.xls` and `.ppt` are OLE compound files from 1997, not ZIPs: mammoth and
 * read-excel-file read OOXML only, and officeparser routes by extension and declines them. Sent to
 * any of those readers they raise a library exception — "invalid signature: 0xe011cfd0" and the
 * like — which is not something a person can act on. Detection names them instead, and the refusal
 * carries the remedy.
 */
export const LEGACY_BINARY_OFFICE_FORMATS: Record<string, UnsupportedFormat> = {
  '.doc': {
    reason: 'legacy_binary_office',
    extension: '.doc',
    format: 'Word 97-2003 (.doc)',
    remedy: 'open it in Word or LibreOffice, save it as .docx, and upload it again',
  },
  '.xls': {
    reason: 'legacy_binary_office',
    extension: '.xls',
    format: 'Excel 97-2003 (.xls)',
    remedy: 'open it in Excel or LibreOffice, save it as .xlsx, and upload it again',
  },
  '.ppt': {
    reason: 'legacy_binary_office',
    extension: '.ppt',
    format: 'PowerPoint 97-2003 (.ppt)',
    remedy: 'open it in PowerPoint or LibreOffice, save it as .pptx, and upload it again',
  },
}

/**
 * Image formats routed at sharp that this build of sharp cannot open.
 *
 * libvips reads BMP only through its ImageMagick loader, and `sharp.format.magick.input.file` is
 * `false` in the build shipped here — verified, not assumed. A .bmp sent to the image parser came
 * back with sharp's own `Input file contains unsupported image format`, which names neither the
 * file nor anything to do about it. Refused by name instead, with the remedy, exactly as the
 * legacy Office formats are.
 *
 * The other ten image extensions stay routed: sharp reports file input support for jpeg, png,
 * webp, tiff, gif, svg and heif, which covers every one of them.
 */
export const UNREADABLE_IMAGE_FORMATS: Record<string, UnsupportedFormat> = {
  '.bmp': {
    reason: 'unreadable_image_codec',
    extension: '.bmp',
    format: 'Windows Bitmap (.bmp)',
    remedy: 'open it in Preview or any image editor, save it as .png or .jpg, and upload it again',
  },
}

/** Every format detection refuses outright, whatever the reason. */
export const REFUSED_FORMATS: Record<string, UnsupportedFormat> = {
  ...LEGACY_BINARY_OFFICE_FORMATS,
  ...UNREADABLE_IMAGE_FORMATS,
}

/**
 * Every extension this package routes, and what it routes it at.
 *
 * Exported so the picker can be checked in both directions: nothing offered may route to
 * `unsupported`, and nothing routed at a reader may be missing from the picker. Only the `image`
 * entries are allowed to be absent from the picker, and `contracts/uploadable-formats.ts` says why.
 */
export const EXTENSION_MAP: Record<string, ParserType> = {
  // PDF
  '.pdf': 'pdf',

  // Word
  '.docx': 'docx',
  '.doc': 'unsupported',

  // Excel / Spreadsheet
  '.xlsx': 'xlsx',
  '.xls': 'unsupported',
  // CSV is plain text, not OOXML — the generic parser reads it.
  '.csv': 'generic',
  // OpenDocument is not OOXML either; officeparser reads it and the generic parser calls it.
  '.ods': 'generic',

  // Images
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.heic': 'image',
  '.heif': 'image',
  '.tiff': 'image',
  '.tif': 'image',
  // .bmp is refused: this sharp build has no magick delegate. See UNREADABLE_IMAGE_FORMATS.
  '.bmp': 'unsupported',
  '.svg': 'image',

  // PowerPoint
  '.pptx': 'pptx',
  '.ppt': 'unsupported',
  // The pptx parser is officeparser-backed, and officeparser reads .odp.
  '.odp': 'pptx',

  // Plain text (handled by generic)
  '.txt': 'generic',
  '.md': 'generic',
  '.json': 'generic',
  '.yaml': 'generic',
  '.yml': 'generic',
  '.xml': 'generic',
  '.html': 'generic',
  '.htm': 'generic',
  '.rtf': 'generic',
  '.odt': 'generic',
}

/** The refusal for an extension detection routed to `unsupported`, or null if it did not. */
export function unsupportedFormat(filename: string): UnsupportedFormat | null {
  const ext = path.extname(filename).toLowerCase()
  return REFUSED_FORMATS[ext] ?? null
}

/** Detect parser type from file extension. Returns 'generic' for unknown types. */
export function detectType(filename: string): ParserType {
  const ext = path.extname(filename).toLowerCase()
  return EXTENSION_MAP[ext] ?? 'generic'
}

/** Check if a file should be skipped (hidden files, parsed output, etc.) */
export function shouldSkip(filename: string): boolean {
  if (filename.startsWith('.')) return true
  if (filename === '_manifest.json') return true
  return false
}
