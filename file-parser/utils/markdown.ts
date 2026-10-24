/**
 * Markdown generation helpers
 */

/** Generate a markdown table from headers and rows */
export function markdownTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return ''

  const separator = headers.map(() => '---')
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell => escapeCell(cell)).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/** Escape pipe characters and newlines inside table cells */
function escapeCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim()
}

/** Generate a metadata frontmatter block */
export function frontmatter(data: Record<string, unknown>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/** Wrap content with a source header and metadata */
export function wrapDocument(
  sourceFile: string,
  content: string,
  metadata?: Record<string, unknown>,
): string {
  const parts: string[] = []

  if (metadata) {
    parts.push(frontmatter({ source: sourceFile, ...metadata }))
    parts.push('')
  }

  parts.push(`# ${sourceFile}`)
  parts.push('')
  parts.push(content)

  return parts.join('\n')
}
