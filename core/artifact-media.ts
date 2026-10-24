import * as path from 'node:path'

/** Unknown formats remain bytes; only explicit text formats may be decoded. */
export function isTextArtifactExtension(extension: string): boolean {
  return /^\.(?:md|markdown|txt|json|csv|tsv|yaml|yml|xml|html|htm|css|js|ts|py|sh|sql|log|ini|toml|svg|tex|rst)$/i.test(path.extname(extension) || extension)
}

/**
 * Canonical artifact extension → media type map shared by the run store's
 * buffered and streaming artifact readers and the workflow artifact contract.
 * Text-ish types gain their `charset` parameter at the read boundary that
 * serves them; this map stays transport-neutral.
 */
export function artifactMediaTypeForExtension(extension: string): string | undefined {
  switch (path.extname(extension).toLowerCase() || extension.toLowerCase()) {
    case '.md':
      return 'text/markdown'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.pdf':
      return 'application/pdf'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.json':
      return 'application/json'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    default:
      return undefined
  }
}
