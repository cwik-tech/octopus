import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { NodeHtmlMarkdown } from 'node-html-markdown'

const CSS_STYLESHEET_PARSE_DIAGNOSTIC = 'Could not parse CSS stylesheet'
const MAX_STRUCTURED_BYTES = 2 * 1_024 * 1_024
const MAX_NORMALIZED_BYTES = 10 * 1_024 * 1_024
const MAX_JSON_LD_BLOCKS = 50
const MAX_TABLES = 20
const MAX_TABLE_ROWS = 100
const MAX_TABLE_COLUMNS = 30
const MAX_MICRODATA_ITEMS = 50

const sourceRepresentationVirtualConsole = createSourceRepresentationVirtualConsole()

function createSourceRepresentationVirtualConsole(): VirtualConsole {
  const virtualConsole = new VirtualConsole()
  virtualConsole.sendTo(console, { omitJSDOMErrors: true })
  virtualConsole.on('jsdomError', (error) => {
    if (error.message === CSS_STYLESHEET_PARSE_DIAGNOSTIC) return
    console.error(error)
  })
  return virtualConsole
}

export type SourceRepresentationKind =
  | 'metadata'
  | 'json'
  | 'json-ld'
  | 'application-state'
  | 'table'
  | 'microdata'

export interface SourceStructuredRepresentation {
  readonly id: string
  readonly kind: SourceRepresentationKind
  readonly mediaType: 'application/json'
  readonly data: unknown
}

export interface SourceRepresentationDraft {
  readonly sourceMediaType: string
  readonly normalizedMediaType: 'text/markdown'
  readonly markdown: string
  readonly title?: string
  readonly canonicalUrl?: string
  readonly structured: readonly SourceStructuredRepresentation[]
  readonly warnings: readonly string[]
  readonly clientRenderedShell: boolean
}

export interface SourceRepresentationManifest {
  readonly schemaVersion: 1
  readonly sourceMediaType: string
  readonly normalizedMediaType: 'text/markdown'
  readonly contentRelativePath: string
  readonly contentSha256: string
  readonly contentBytes: number
  readonly representations: readonly SourceStructuredRepresentation[]
  readonly warnings: readonly string[]
}

export function buildSourceRepresentations(
  body: string,
  mediaType: string,
  url: string,
): SourceRepresentationDraft {
  if (mediaType.includes('json')) return jsonRepresentations(body, mediaType)
  if (!mediaType.includes('html') && !mediaType.includes('xml')) {
    const warnings: string[] = []
    return {
      sourceMediaType: mediaType,
      normalizedMediaType: 'text/markdown',
      markdown: boundMarkdown(normalizeMarkdown(body), warnings),
      structured: [],
      warnings,
      clientRenderedShell: false,
    }
  }

  const dom = new JSDOM(body, {
    url,
    contentType: mediaType.includes('html') ? 'text/html' : 'text/xml',
    virtualConsole: sourceRepresentationVirtualConsole,
  })
  try {
    const document = dom.window.document
    const canonicalUrl =
      document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href
    const metadata = extractMetadata(document)
    const title =
      stringValue(metadata.title) ||
      document.title?.trim() ||
      undefined
    const structured: SourceStructuredRepresentation[] = []
    if (Object.keys(metadata).length > 0) {
      structured.push(jsonRepresentation('metadata', 'metadata', metadata))
    }
    const warnings: string[] = []
    if (mediaType.includes('html')) {
      extractJsonLd(document, structured, warnings)
      extractApplicationState(document, structured, warnings)
      extractTables(document, structured)
      extractMicrodata(document, structured)
    } else {
      const text = normalizeMarkdown(
        document.documentElement.textContent?.replace(/\s+/gu, ' ') ?? '',
      )
      const markdown = boundMarkdown(
        title ? `# ${title}\n\n${text}` : text,
        warnings,
      )
      return {
        sourceMediaType: mediaType,
        normalizedMediaType: 'text/markdown',
        markdown,
        ...(title ? { title } : {}),
        ...(canonicalUrl ? { canonicalUrl } : {}),
        structured: boundStructured(structured, warnings),
        warnings,
        clientRenderedShell: false,
      }
    }

    const readableDocument = document.cloneNode(true) as Document
    readableDocument
      .querySelectorAll('script,style,noscript,template')
      .forEach((node) => node.remove())
    const readable = new Readability(readableDocument.cloneNode(true) as Document, {
      charThreshold: 120,
    }).parse()
    const cleanBodyText =
      readableDocument.body?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
    const clientRenderedShell =
      mediaType.includes('html') &&
      Boolean(document.querySelector('#root, #app, [data-reactroot]')) &&
      document.querySelectorAll('script').length > 0 &&
      cleanBodyText.length < 160
    const readableHtml = (
      cleanBodyText
        ? readable?.content || readableDocument.body?.innerHTML || ''
        : readableDocument.body?.innerHTML || ''
    ).replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/giu, '')
    let markdown = normalizeMarkdown(NodeHtmlMarkdown.translate(readableHtml, {
      bulletMarker: '-',
      codeBlockStyle: 'fenced',
      keepDataImages: false,
      useLinkReferenceDefinitions: false,
    }))
    if (!markdown) {
      markdown = normalizeMarkdown(
        readableDocument.body?.textContent?.replace(/\s+/gu, ' ') ?? '',
      )
    }
    const effectiveTitle = readable?.title?.trim() || title
    if (
      effectiveTitle &&
      !markdown.toLocaleLowerCase().startsWith(`# ${effectiveTitle}`.toLocaleLowerCase())
    ) {
      markdown = `# ${effectiveTitle}\n\n${markdown}`.trim()
    }
    markdown = boundMarkdown(markdown, warnings)
    return {
      sourceMediaType: mediaType,
      normalizedMediaType: 'text/markdown',
      markdown,
      ...(effectiveTitle ? { title: effectiveTitle } : {}),
      ...(canonicalUrl ? { canonicalUrl } : {}),
      structured: boundStructured(structured, warnings),
      warnings,
      clientRenderedShell,
    }
  } finally {
    dom.window.close()
  }
}

export function markdownRepresentation(
  markdown: string,
  sourceMediaType: string,
  options: {
    readonly title?: string
    readonly structured?: readonly SourceStructuredRepresentation[]
    readonly warnings?: readonly string[]
  } = {},
): SourceRepresentationDraft {
  const warnings = [...(options.warnings ?? [])]
  return {
    sourceMediaType,
    normalizedMediaType: 'text/markdown',
    markdown: boundMarkdown(normalizeMarkdown(markdown), warnings),
    ...(options.title ? { title: options.title } : {}),
    structured: options.structured ?? [],
    warnings,
    clientRenderedShell: false,
  }
}

function jsonRepresentations(
  body: string,
  mediaType: string,
): SourceRepresentationDraft {
  const warnings: string[] = []
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    warnings.push('The JSON response could not be parsed; only its raw text was retained.')
    return {
      sourceMediaType: mediaType,
      normalizedMediaType: 'text/markdown',
      markdown: boundMarkdown([
        '# JSON source',
        '',
        '```json',
        body.trim(),
        '```',
      ].join('\n'), warnings),
      structured: [],
      warnings,
      clientRenderedShell: false,
    }
  }
  const pretty = JSON.stringify(data, null, 2)
  return {
    sourceMediaType: mediaType,
    normalizedMediaType: 'text/markdown',
    markdown: boundMarkdown(
      ['# JSON source', '', '```json', pretty, '```'].join('\n'),
      warnings,
    ),
    structured: [jsonRepresentation('source-json', 'json', data)],
    warnings,
    clientRenderedShell: false,
  }
}

function extractMetadata(document: Document): Record<string, unknown> {
  const meta = (selector: string): string | undefined =>
    document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || undefined
  const result: Record<string, unknown> = {}
  const entries = {
    title: meta('meta[property="og:title"]') || document.title.trim() || undefined,
    description:
      meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    author: meta('meta[name="author"]') || meta('meta[property="article:author"]'),
    publishedAt:
      meta('meta[property="article:published_time"]') ||
      meta('meta[name="date"]') ||
      document.querySelector<HTMLTimeElement>('time[datetime]')?.dateTime,
    modifiedAt: meta('meta[property="article:modified_time"]'),
    canonicalUrl:
      document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href,
    language: document.documentElement.lang || undefined,
    image: meta('meta[property="og:image"]'),
    siteName: meta('meta[property="og:site_name"]'),
    type: meta('meta[property="og:type"]'),
  }
  for (const [key, value] of Object.entries(entries)) {
    if (value) result[key] = value
  }
  return result
}

function extractJsonLd(
  document: Document,
  output: SourceStructuredRepresentation[],
  warnings: string[],
): void {
  const scripts = [...document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  )].slice(0, MAX_JSON_LD_BLOCKS)
  for (const [index, script] of scripts.entries()) {
    const text = script.textContent?.trim()
    if (!text) continue
    try {
      output.push(jsonRepresentation(`json-ld-${index + 1}`, 'json-ld', JSON.parse(text)))
    } catch {
      warnings.push(`JSON-LD block ${index + 1} was malformed and was retained only in raw HTML.`)
    }
  }
}

function extractApplicationState(
  document: Document,
  output: SourceStructuredRepresentation[],
  warnings: string[],
): void {
  const candidates = [
    ['next-data', document.querySelector<HTMLScriptElement>('script#__NEXT_DATA__')],
    ['nuxt-data', document.querySelector<HTMLScriptElement>('script#__NUXT_DATA__')],
  ] as const
  for (const [id, script] of candidates) {
    const text = script?.textContent?.trim()
    if (!text) continue
    try {
      output.push(jsonRepresentation(id, 'application-state', JSON.parse(text)))
    } catch {
      warnings.push(`${id} was malformed and was retained only in raw HTML.`)
    }
  }
}

function extractTables(
  document: Document,
  output: SourceStructuredRepresentation[],
): void {
  for (const [tableIndex, table] of [...document.querySelectorAll('table')]
    .slice(0, MAX_TABLES)
    .entries()) {
    const firstRow = table.querySelector('tr')
    const hasHeader = Boolean(firstRow?.querySelector('th'))
    const rows = [...table.querySelectorAll('tr')]
      .slice(0, MAX_TABLE_ROWS)
      .map((row) =>
        [...row.querySelectorAll('th,td')]
          .slice(0, MAX_TABLE_COLUMNS)
          .map((cell) => cell.textContent?.replace(/\s+/gu, ' ').trim() ?? ''),
      )
      .filter((row) => row.some(Boolean))
    if (rows.length > 0) {
      const headers = hasHeader ? rows[0] ?? [] : []
      const dataRows = hasHeader ? rows.slice(1) : rows
      const records = headers.length > 0
        ? dataRows.map((row) =>
            Object.fromEntries(
              headers.flatMap((header, index) =>
                header && row[index] !== undefined
                  ? [[header, row[index]]]
                  : []),
            ))
          .filter((record) => Object.keys(record).length > 0)
        : []
      const properties: Record<string, unknown> = {}
      for (const row of dataRows) {
        const key = row[0]
        const value = row[1]
        if (!key || value === undefined) continue
        const current = properties[key]
        properties[key] = current === undefined
          ? value
          : Array.isArray(current)
            ? [...current, value]
            : [current, value]
      }
      output.push(jsonRepresentation(
        `table-${tableIndex + 1}`,
        'table',
        {
          caption: table.querySelector('caption')?.textContent?.trim(),
          rows,
          ...(records.length > 0 ? { records } : {}),
          ...(Object.keys(properties).length > 0 ? { properties } : {}),
        },
      ))
    }
  }
}

function extractMicrodata(
  document: Document,
  output: SourceStructuredRepresentation[],
): void {
  const items = [...document.querySelectorAll<HTMLElement>('[itemscope]')]
    .filter((element) => !element.parentElement?.closest('[itemscope]'))
    .slice(0, MAX_MICRODATA_ITEMS)
    .map((item) => {
      const properties: Record<string, unknown> = {}
      for (const element of [...item.querySelectorAll<HTMLElement>('[itemprop]')]
        .slice(0, 100)) {
        const key = element.getAttribute('itemprop')?.trim()
        if (!key) continue
        const value =
          element.getAttribute('content') ||
          element.getAttribute('href') ||
          element.getAttribute('src') ||
          element.textContent?.replace(/\s+/gu, ' ').trim()
        if (!value) continue
        const current = properties[key]
        properties[key] = current === undefined
          ? value
          : Array.isArray(current)
            ? [...current, value]
            : [current, value]
      }
      return {
        type: item.getAttribute('itemtype') || undefined,
        properties,
      }
    })
    .filter((item) => Object.keys(item.properties).length > 0)
  if (items.length > 0) {
    output.push(jsonRepresentation('microdata', 'microdata', items))
  }
}

function jsonRepresentation(
  id: string,
  kind: SourceRepresentationKind,
  data: unknown,
): SourceStructuredRepresentation {
  return { id, kind, mediaType: 'application/json', data }
}

function boundStructured(
  candidates: readonly SourceStructuredRepresentation[],
  warnings: string[],
): SourceStructuredRepresentation[] {
  const accepted: SourceStructuredRepresentation[] = []
  let bytes = 0
  for (const candidate of candidates) {
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    if (bytes + candidateBytes > MAX_STRUCTURED_BYTES) {
      warnings.push('Structured representations were truncated at the 2 MB package limit.')
      break
    }
    accepted.push(candidate)
    bytes += candidateBytes
  }
  return accepted
}

function normalizeMarkdown(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function boundMarkdown(value: string, warnings: string[]): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= MAX_NORMALIZED_BYTES) return value
  warnings.push('Normalized Markdown was truncated at the 10 MB package limit.')
  const suffix = '\n\n<!-- normalized content truncated; see raw source -->'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  const maximumPrefixBytes = MAX_NORMALIZED_BYTES - suffixBytes
  let prefix = buffer.subarray(0, maximumPrefixBytes).toString('utf8')
  while (Buffer.byteLength(prefix, 'utf8') > maximumPrefixBytes) {
    prefix = prefix.slice(0, -1)
  }
  return `${prefix}${suffix}`
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
