import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from 'docx'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { isPathInside } from '../../core/path-safety.js'
import { stripArtifactFrontmatter } from '../runtime/artifacts.js'
import { readWordImageDimensions } from './image-dimensions.js'
import { renderMermaidPng } from './mermaid-renderer.js'
import type {
  GenerateWordOptions,
  GenerateWordResult,
  WordGenerationProfile,
} from './generate-word-types.js'
import { loadWordProfile } from './word-profiles.js'
import { normalizeGeneratedWordBorders } from './normalize-word-ooxml.js'

const MAX_IMAGE_BYTES = 20 * 1_024 * 1_024

type MdNode = {
  type: string
  value?: string
  url?: string
  alt?: string
  lang?: string
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  children?: MdNode[]
}

interface InlineStyle {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
}

interface RenderContext {
  readonly profile: WordGenerationProfile
  readonly sourceDirectory: string
  readonly renderMermaid: boolean
  readonly mermaidFailure: 'error' | 'keep-code'
  readonly browserExecutablePath?: string
  readonly signal?: AbortSignal
  readonly warnings: string[]
}

/**
 * Convert Markdown to a Word document with profile-driven styles and native
 * Word structures. Local images and Mermaid diagrams are embedded in the DOCX.
 */
export async function generateWordBuffer(
  markdown: string,
  options: GenerateWordOptions = {},
): Promise<GenerateWordResult> {
  if (options.signal?.aborted) throw abortError()
  const profile = loadWordProfile(options.profile, options.profilePath)
  const cleanMarkdown = stripArtifactFrontmatter(markdown).trim()
  if (!cleanMarkdown) throw new Error('Generate Word received an empty Markdown document.')
  const root = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(cleanMarkdown) as MdNode
  const inferredTitle = firstHeadingText(root) || options.title || 'Untitled Document'
  const warnings: string[] = []
  const renderer = new MarkdownWordRenderer({
    profile,
    sourceDirectory: path.resolve(options.sourceDirectory ?? process.cwd()),
    renderMermaid: options.renderMermaid ?? profile.mermaid.enabled,
    mermaidFailure: options.mermaidFailure ?? 'error',
    ...whenDefined(options.browserExecutablePath, (definedValue) => ({ browserExecutablePath: definedValue })),
    ...whenDefined(options.signal, (definedValue) => ({ signal: definedValue })),
    warnings,
  })
  const children = await renderer.render(root)
  const tableOfContents =
    options.tableOfContents ?? profile.tableOfContents.enabled
  if (tableOfContents && hasDocumentHeadings(root)) {
    const insertionIndex = renderer.renderedTitle ? 1 : 0
    children.splice(
      insertionIndex,
      0,
      new Paragraph({
        style: 'GeneratedWordTocTitle',
        children: [new TextRun(profile.tableOfContents.heading)],
      }),
      new TableOfContents('Table of Contents', {
        hyperlink: true,
        headingStyleRange: `1-${profile.tableOfContents.depth}`,
        beginDirty: true,
        cachedEntries: tableOfContentsEntries(
          root,
          profile.tableOfContents.depth,
        ),
      }),
    )
  }

  const document = new Document({
    title: options.title ?? inferredTitle,
    creator: options.creator ?? 'Pipeline',
    description: `${profile.displayName} generated from Markdown.`,
    features: { updateFields: true },
    styles: buildStyles(profile),
    numbering: {
      config: [
        {
          reference: 'generated-word-bullets',
          levels: numberingLevels('bullet', profile),
        },
        {
          reference: 'generated-word-decimals',
          levels: numberingLevels('decimal', profile),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: profile.page.widthDxa,
              height: profile.page.heightDxa,
            },
            margin: {
              top: profile.page.marginDxa,
              right: profile.page.marginDxa,
              bottom: profile.page.marginDxa,
              left: profile.page.marginDxa,
              header: profile.page.headerFooterDxa,
              footer: profile.page.headerFooterDxa,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: options.headerText ?? profile.headerText,
                    font: profile.typography.bodyFont,
                    size: profile.typography.footerSize,
                    color: profile.colors.muted,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { before: 0, after: 0 },
                children: [
                  new TextRun({
                    children: ['Page ', PageNumber.CURRENT],
                    font: profile.typography.bodyFont,
                    size: profile.typography.footerSize,
                    color: profile.colors.muted,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })

  return {
    buffer: await normalizeGeneratedWordBorders(await Packer.toBuffer(document), options.signal),
    profile,
    warnings,
  }
}

class MarkdownWordRenderer {
  renderedTitle = false
  private listInstance = 0
  private readonly mermaidCache = new Map<string, Buffer>()

  constructor(private readonly context: RenderContext) {}

  async render(root: MdNode): Promise<Array<Paragraph | Table | TableOfContents>> {
    const output: Array<Paragraph | Table | TableOfContents> = []
    for (const node of root.children ?? []) {
      output.push(...await this.renderBlock(node, 0))
    }
    if (output.length === 0) output.push(new Paragraph({ text: '' }))
    return output
  }

  private async renderBlock(
    node: MdNode,
    listDepth: number,
  ): Promise<Array<Paragraph | Table>> {
    this.throwIfAborted()
    switch (node.type) {
      case 'heading':
        return [await this.renderHeading(node)]
      case 'paragraph': {
        const standaloneImage =
          node.children?.length === 1 &&
          node.children[0]?.type === 'image'
        return [new Paragraph({
          ...whenDefined(standaloneImage ? AlignmentType.CENTER : undefined, (definedValue) => ({ alignment: definedValue })),
          ...whenDefined(standaloneImage
            ? {
                before: this.context.profile.layout.imageBefore,
                after: this.context.profile.layout.imageAfter,
              }
            : undefined, (definedValue) => ({ spacing: definedValue })),
          children: await renderInline(node.children ?? [], {}, this.context),
        })]
      }
      case 'list':
        return this.renderList(node, listDepth)
      case 'blockquote': {
        const output: Paragraph[] = []
        for (const child of node.children ?? []) {
          output.push(new Paragraph({
            style: 'GeneratedWordQuote',
            children: await renderInline(
              child.type === 'paragraph'
                ? child.children ?? []
                : [{ type: 'text', value: nodeText(child) }],
              {},
              this.context,
            ),
          }))
        }
        return output
      }
      case 'code':
        if (
          node.lang?.trim().toLowerCase() === 'mermaid' &&
          this.context.renderMermaid
        ) {
          try {
            return [await this.renderMermaid(node.value ?? '')]
          } catch (error) {
            if (this.context.mermaidFailure === 'error') throw error
            this.context.warnings.push(
              `Mermaid diagram was kept as code: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        }
        return [this.renderCode(node.value ?? '')]
      case 'thematicBreak':
        return [new Paragraph({
          spacing: {
            before: this.context.profile.layout.dividerBefore,
            after: this.context.profile.layout.dividerAfter,
          },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              color: this.context.profile.colors.border,
              size: this.context.profile.layout.dividerSize,
            },
          },
          children: [new TextRun({ text: '' })],
        })]
      case 'table':
        return [await renderTable(node, this.context)]
      case 'html':
        return node.value?.trim()
          ? [new Paragraph({ children: [new TextRun(node.value.trim())] })]
          : []
      case 'definition':
      case 'yaml':
        return []
      default: {
        const text = nodeText(node).trim()
        return text ? [new Paragraph({ text })] : []
      }
    }
  }

  private async renderHeading(node: MdNode): Promise<Paragraph> {
    const children = await renderInline(node.children ?? [], {}, this.context)
    if (node.depth === 1 && !this.renderedTitle) {
      this.renderedTitle = true
      return new Paragraph({ style: 'GeneratedWordTitle', children })
    }
    return new Paragraph({
      heading: headingLevel(Math.max(1, Math.min(6, node.depth ?? 1))),
      children,
    })
  }

  private async renderList(node: MdNode, listDepth: number): Promise<Array<Paragraph | Table>> {
    const output: Array<Paragraph | Table> = []
    const reference = node.ordered
      ? 'generated-word-decimals'
      : 'generated-word-bullets'
    const instance = this.listInstance++
    const level = Math.min(listDepth, 4)
    for (const item of node.children ?? []) {
      let numberedParagraphWritten = false
      for (const child of item.children ?? []) {
        if (child.type === 'paragraph') {
          const inlineChildren = await renderInline(
            child.children ?? [],
            {},
            this.context,
          )
          if (!numberedParagraphWritten && typeof item.checked === 'boolean') {
            inlineChildren.unshift(new TextRun(item.checked ? '☒ ' : '☐ '))
          }
          output.push(new Paragraph({
            style: 'ListParagraph',
            ...whenDefined(numberedParagraphWritten
              ? undefined
              : { reference, level, instance }, (definedValue) => ({ numbering: definedValue })),
            ...whenDefined(numberedParagraphWritten
              ? {
                  left:
                    this.context.profile.layout.listIndentPerLevel *
                    (level + 1),
                }
              : undefined, (definedValue) => ({ indent: definedValue })),
            children: inlineChildren,
          }))
          numberedParagraphWritten = true
        } else if (child.type === 'list') {
          output.push(...await this.renderList(child, listDepth + 1))
        } else {
          output.push(...await this.renderBlock(child, listDepth + 1))
        }
      }
    }
    return output
  }

  private renderCode(value: string): Paragraph {
    return new Paragraph({
      style: 'GeneratedWordCodeBlock',
      children: codeRuns(value, this.context.profile),
    })
  }

  private async renderMermaid(source: string): Promise<Paragraph> {
    const cacheKey = [
      this.context.profile.mermaid.theme,
      this.context.profile.mermaid.backgroundColor,
      source,
    ].join('\0')
    let image = this.mermaidCache.get(cacheKey)
    if (!image) {
      image = await renderMermaidPng({
        source,
        theme: this.context.profile.mermaid.theme,
        backgroundColor: this.context.profile.mermaid.backgroundColor,
        paddingPx: this.context.profile.mermaid.paddingPx,
        ...whenDefined(this.context.browserExecutablePath, (definedValue) => ({ executablePath: definedValue })),
        ...whenDefined(this.context.signal, (definedValue) => ({ signal: definedValue })),
      })
      this.mermaidCache.set(cacheKey, image)
    }
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: {
        before: this.context.profile.layout.imageBefore,
        after: this.context.profile.layout.imageAfter,
      },
      children: [
        imageRun(
          image,
          'png',
          'Mermaid diagram',
          this.context.profile,
        ),
      ],
    })
  }

  private throwIfAborted(): void {
    if (this.context.signal?.aborted) throw abortError()
  }
}

function requiredProfileValue(
  values: readonly number[],
  index: number,
  label: string,
): number {
  const value = values[index]
  if (value === undefined) throw new Error(`Word profile is missing ${label} ${index + 1}.`)
  return value
}

function buildStyles(profile: WordGenerationProfile) {
  const heading = (index: number) => ({
    run: {
      font: profile.typography.headingFont,
      size: requiredProfileValue(profile.typography.headingSizes, index, 'heading size'),
      bold: true,
      color: index === 0
        ? profile.colors.heading
        : profile.colors.headingDark,
    },
    paragraph: {
      spacing: {
        before: requiredProfileValue(profile.layout.headingBefore, index, 'heading spacing before'),
        after: requiredProfileValue(profile.layout.headingAfter, index, 'heading spacing after'),
      },
      keepNext: true,
    },
  })
  return {
    default: {
      document: {
        run: {
          font: profile.typography.bodyFont,
          size: profile.typography.bodySize,
          color: profile.colors.ink,
        },
        paragraph: {
          spacing: {
            before: 0,
            after: profile.typography.paragraphAfter,
            line: profile.typography.lineSpacing,
          },
        },
      },
      heading1: heading(0),
      heading2: heading(1),
      heading3: heading(2),
      heading4: heading(3),
      heading5: heading(4),
      heading6: heading(5),
      listParagraph: {
        run: {
          font: profile.typography.bodyFont,
          size: profile.typography.bodySize,
          color: profile.colors.ink,
        },
        paragraph: {
          spacing: {
            before: 0,
            after: profile.layout.listAfter,
            line: profile.typography.lineSpacing,
          },
        },
      },
      hyperlink: {
        run: {
          color: profile.colors.link,
          underline: {
            type: UnderlineType.SINGLE,
            color: profile.colors.link,
          },
        },
      },
    },
    paragraphStyles: [
      {
        id: 'GeneratedWordTitle',
        name: 'Generated Word Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: {
          font: profile.typography.headingFont,
          size: profile.typography.titleSize,
          bold: true,
          color: profile.colors.ink,
        },
        paragraph: {
          spacing: { before: 0, after: profile.layout.titleAfter },
          keepNext: true,
        },
      },
      {
        id: 'GeneratedWordTocTitle',
        name: 'Generated Word TOC Title',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: {
          font: profile.typography.headingFont,
          size: requiredProfileValue(profile.typography.headingSizes, 1, 'TOC heading size'),
          bold: true,
          color: profile.colors.headingDark,
        },
        paragraph: {
          spacing: {
            before: profile.layout.tocTitleBefore,
            after: profile.layout.tocTitleAfter,
          },
          keepNext: true,
        },
      },
      {
        id: 'GeneratedWordQuote',
        name: 'Generated Word Quote',
        basedOn: 'Normal',
        run: { color: profile.colors.muted, italics: true },
        paragraph: {
          indent: {
            left: profile.layout.quoteIndentLeft,
            right: profile.layout.quoteIndentRight,
          },
          spacing: {
            before: profile.layout.quoteBefore,
            after: profile.layout.quoteAfter,
            line: profile.typography.lineSpacing,
          },
          border: {
            left: {
              style: BorderStyle.SINGLE,
              color: profile.colors.heading,
              size: profile.layout.quoteBorderSize,
              space: profile.layout.quoteBorderSpace,
            },
          },
        },
      },
      {
        id: 'GeneratedWordCodeBlock',
        name: 'Generated Word Code Block',
        basedOn: 'Normal',
        run: {
          font: profile.typography.codeFont,
          size: profile.typography.codeBlockSize,
          color: profile.colors.ink,
        },
        paragraph: {
          spacing: {
            before: profile.layout.codeBefore,
            after: profile.layout.codeAfter,
            line: profile.layout.codeLineSpacing,
          },
          indent: {
            left: profile.layout.codeIndent,
            right: profile.layout.codeIndent,
          },
          shading: { type: ShadingType.CLEAR, fill: profile.colors.code },
          border: boxBorder(
            profile.colors.border,
            profile.layout.codeBorderSize,
          ),
        },
      },
      {
        id: 'GeneratedWordTableText',
        name: 'Generated Word Table Text',
        basedOn: 'Normal',
        run: {
          font: profile.typography.bodyFont,
          size: profile.typography.tableSize,
          color: profile.colors.ink,
        },
        paragraph: {
          spacing: {
            before: 0,
            after: profile.layout.tableParagraphAfter,
            line: profile.layout.tableLineSpacing,
          },
        },
      },
    ],
  }
}

function numberingLevels(
  kind: 'bullet' | 'decimal',
  profile: WordGenerationProfile,
) {
  const bullets = ['•', '◦', '▪', '▫', '–']
  return bullets.map((bullet, level) => ({
    level,
    format: kind === 'bullet' ? LevelFormat.BULLET : LevelFormat.DECIMAL,
    text: kind === 'bullet' ? bullet : `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: {
      paragraph: {
        indent: {
          left: profile.layout.listIndentPerLevel * (level + 1),
          hanging: profile.layout.listHanging,
        },
        spacing: {
          before: 0,
          after: profile.layout.listAfter,
          line: profile.typography.lineSpacing,
        },
      },
      run: {
        font: profile.typography.bodyFont,
        size: profile.typography.bodySize,
        color: profile.colors.ink,
      },
    },
  }))
}

async function renderInline(
  nodes: MdNode[],
  style: InlineStyle,
  context: RenderContext,
): Promise<ParagraphChild[]> {
  const children: ParagraphChild[] = []
  for (const node of nodes) {
    if (context.signal?.aborted) throw abortError()
    switch (node.type) {
      case 'text':
        children.push(textRun(node.value ?? '', style, context.profile))
        break
      case 'strong':
        children.push(...await renderInline(
          node.children ?? [],
          { ...style, bold: true },
          context,
        ))
        break
      case 'emphasis':
        children.push(...await renderInline(
          node.children ?? [],
          { ...style, italics: true },
          context,
        ))
        break
      case 'delete':
        children.push(...await renderInline(
          node.children ?? [],
          { ...style, strike: true },
          context,
        ))
        break
      case 'inlineCode':
        children.push(textRun(
          node.value ?? '',
          { ...style, code: true },
          context.profile,
        ))
        break
      case 'link': {
        const label = nodeText(node) || node.url || ''
        const externalUrl = allowedExternalUrl(node.url)
        children.push(externalUrl
          ? new ExternalHyperlink({
              link: externalUrl,
              children: [new TextRun({
                text: label,
                ...whenDefined(style.bold, (definedValue) => ({ bold: definedValue })),
                ...whenDefined(style.italics, (definedValue) => ({ italics: definedValue })),
                ...whenDefined(style.strike, (definedValue) => ({ strike: definedValue })),
                color: context.profile.colors.link,
                underline: {
                  type: UnderlineType.SINGLE,
                  color: context.profile.colors.link,
                },
              })],
            })
          : textRun(label, style, context.profile))
        break
      }
      case 'image':
        children.push(await renderImage(node, context))
        break
      case 'break':
        children.push(new TextRun({ break: 1 }))
        break
      case 'footnoteReference':
        children.push(new TextRun({
          text: `[${node.value ?? '?'}]`,
          superScript: true,
        }))
        break
      case 'html':
        if (node.value) {
          children.push(textRun(node.value, style, context.profile))
        }
        break
      default:
        if (node.children) {
          children.push(...await renderInline(node.children, style, context))
        } else if (node.value) {
          children.push(textRun(node.value, style, context.profile))
        }
    }
  }
  return children
}

async function renderImage(
  node: MdNode,
  context: RenderContext,
): Promise<ParagraphChild> {
  const label = node.alt || node.url || 'Image'
  const externalUrl = allowedExternalUrl(node.url)
  if (externalUrl) {
    return new ExternalHyperlink({
      link: externalUrl,
      children: [new TextRun({
        text: `[Image: ${label}]`,
        color: context.profile.colors.link,
        italics: true,
        underline: {
          type: UnderlineType.SINGLE,
          color: context.profile.colors.link,
        },
      })],
    })
  }
  try {
    const loaded = await loadLocalImage(node.url, context.sourceDirectory)
    return imageRun(loaded.data, loaded.type, label, context.profile)
  } catch (error) {
    context.warnings.push(
      `Image '${label}' was not embedded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return new TextRun({ text: `[Image: ${label}]`, italics: true })
  }
}

async function loadLocalImage(
  value: string | undefined,
  sourceDirectory: string,
): Promise<{
  readonly data: Buffer
  readonly type: 'jpg' | 'png' | 'gif' | 'bmp'
}> {
  if (!value) throw new Error('image URL is missing')
  const dataUri = /^data:image\/(png|jpeg|jpg|gif|bmp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  if (dataUri) {
    const [, imageFormat, encoded] = dataUri
    if (imageFormat === undefined || encoded === undefined) {
      throw new Error('image data URI matched without its format and payload')
    }
    const data = Buffer.from(encoded.replace(/\s/g, ''), 'base64')
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('image data is empty or exceeds 20 MB')
    }
    return {
      data,
      type: imageFormat.toLowerCase() === 'jpeg'
        ? 'jpg'
        : imageFormat.toLowerCase() as 'jpg' | 'png' | 'gif' | 'bmp',
    }
  }
  if (path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('image path must be relative to the Markdown file')
  }
  const sourceRoot = await fs.realpath(sourceDirectory)
  const requestedPath = path.resolve(sourceRoot, decodeURIComponent(value))
  const realPath = await fs.realpath(requestedPath)
  if (!isPathInside(sourceRoot, realPath) && sourceRoot !== realPath) {
    throw new Error('image path leaves the Markdown source directory')
  }
  const stat = await fs.lstat(realPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) {
    throw new Error('image is not a regular file or exceeds 20 MB')
  }
  const type = imageType(path.extname(realPath))
  if (!type) throw new Error('only PNG, JPEG, GIF, and BMP images are supported')
  return { data: await fs.readFile(realPath), type }
}

function imageRun(
  data: Buffer,
  type: 'jpg' | 'png' | 'gif' | 'bmp',
  label: string,
  profile: WordGenerationProfile,
): ImageRun {
  const dimensions = readWordImageDimensions(data, type)
  const scale = Math.min(
    1,
    profile.image.maxWidthPx / dimensions.width,
    profile.image.maxHeightPx / dimensions.height,
  )
  return new ImageRun({
    type,
    data,
    transformation: {
      width: Math.max(1, Math.round(dimensions.width * scale)),
      height: Math.max(1, Math.round(dimensions.height * scale)),
    },
    altText: {
      name: label.slice(0, 255),
      title: label.slice(0, 255),
      description: label.slice(0, 1000),
    },
  })
}

async function renderTable(
  node: MdNode,
  context: RenderContext,
): Promise<Table> {
  const rows = node.children ?? []
  const columnCount = Math.max(
    1,
    ...rows.map((row) => row.children?.length ?? 0),
  )
  const contentWidth =
    context.profile.page.widthDxa - (2 * context.profile.page.marginDxa)
  const columnWidths = tableColumnWidths(rows, columnCount, contentWidth)
  const border = {
    style: BorderStyle.SINGLE,
    color: context.profile.colors.border,
    size: context.profile.layout.tableBorderSize,
  }
  const renderedRows: TableRow[] = []
  for (const [rowIndex, row] of rows.entries()) {
    const cells: TableCell[] = []
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cell = row.children?.[columnIndex]
      const columnWidth = columnWidths[columnIndex]
      if (columnWidth === undefined) {
        throw new Error(`Table column ${columnIndex} has no computed width`)
      }
      cells.push(new TableCell({
        width: {
          size: columnWidth,
          type: WidthType.DXA,
        },
        ...whenDefined(rowIndex === 0
          ? {
              type: ShadingType.CLEAR,
              fill: context.profile.colors.tableHeader,
            }
          : undefined, (definedValue) => ({ shading: definedValue })),
        margins: {
          top: context.profile.layout.tableCellMarginVertical,
          bottom: context.profile.layout.tableCellMarginVertical,
          left: context.profile.layout.tableCellMargin,
          right: context.profile.layout.tableCellMargin,
          marginUnitType: WidthType.DXA,
        },
        children: [new Paragraph({
          style: 'GeneratedWordTableText',
          children: await renderInline(cell?.children ?? [], {}, context),
        })],
      }))
    }
    renderedRows.push(new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: true,
      children: cells,
    }))
  }
  return new Table({
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    indent: {
      size: context.profile.layout.tableIndent,
      type: WidthType.DXA,
    },
    margins: {
      top: context.profile.layout.tableCellMarginVertical,
      bottom: context.profile.layout.tableCellMarginVertical,
      left: context.profile.layout.tableCellMargin,
      right: context.profile.layout.tableCellMargin,
      marginUnitType: WidthType.DXA,
    },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: renderedRows,
  })
}

function tableColumnWidths(
  rows: MdNode[],
  columnCount: number,
  contentWidth: number,
): number[] {
  const weights = Array.from({ length: columnCount }, (_, columnIndex) => {
    const maxLength = Math.max(
      8,
      ...rows.map(
        (row) => nodeText(row.children?.[columnIndex]).trim().length,
      ),
    )
    return Math.min(40, maxLength)
  })
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const widths = weights.map(
    (weight) => Math.floor(contentWidth * weight / totalWeight),
  )
  widths[widths.length - 1] =
    contentWidth -
    widths.slice(0, -1).reduce((sum, width) => sum + width, 0)
  return widths
}

function headingLevel(depth: number) {
  const level = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ][depth - 1]
  if (level === undefined) {
    throw new Error(`Heading depth ${depth} is outside 1-6`)
  }
  return level
}

function textRun(
  text: string,
  style: InlineStyle,
  profile: WordGenerationProfile,
): TextRun {
  return new TextRun({
    text,
    ...whenDefined(style.bold, (definedValue) => ({ bold: definedValue })),
    ...whenDefined(style.italics, (definedValue) => ({ italics: definedValue })),
    ...whenDefined(style.strike, (definedValue) => ({ strike: definedValue })),
    ...whenDefined(style.code ? profile.typography.codeFont : undefined, (definedValue) => ({ font: definedValue })),
    ...whenDefined(style.code ? profile.typography.inlineCodeSize : undefined, (definedValue) => ({ size: definedValue })),
    ...whenDefined(style.code
      ? { type: ShadingType.CLEAR, fill: profile.colors.code }
      : undefined, (definedValue) => ({ shading: definedValue })),
  })
}

function codeRuns(
  value: string,
  profile: WordGenerationProfile,
): TextRun[] {
  return value.split('\n').map((line, index) => new TextRun({
    text: line || ' ',
    ...whenDefined(index === 0 ? undefined : 1, (definedValue) => ({ break: definedValue })),
    font: profile.typography.codeFont,
    size: profile.typography.codeBlockSize,
  }))
}

function boxBorder(color: string, size: number) {
  const border = {
    style: BorderStyle.SINGLE,
    color,
    size,
  }
  return {
    top: border,
    bottom: border,
    left: border,
    right: border,
  }
}

function imageType(
  extension: string,
): 'jpg' | 'png' | 'gif' | 'bmp' | undefined {
  switch (extension.toLowerCase()) {
    case '.jpeg':
    case '.jpg':
      return 'jpg'
    case '.png':
      return 'png'
    case '.gif':
      return 'gif'
    case '.bmp':
      return 'bmp'
    default:
      return undefined
  }
}

function allowedExternalUrl(value: string | undefined): string | undefined {
  if (
    !value ||
    value !== value.trim() ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) return undefined
  try {
    const protocol = new URL(value).protocol.toLowerCase()
    return ['https:', 'http:', 'mailto:'].includes(protocol)
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function nodeText(node: MdNode | undefined): string {
  if (!node) return ''
  if (node.value) return node.value
  if (node.alt) return node.alt
  return (node.children ?? []).map(nodeText).join('')
}

function firstHeadingText(root: MdNode): string | undefined {
  const heading = (root.children ?? []).find(
    (node) => node.type === 'heading',
  )
  const text = nodeText(heading).trim()
  return text || undefined
}

function hasDocumentHeadings(root: MdNode): boolean {
  let firstHeadingSkipped = false
  for (const node of root.children ?? []) {
    if (node.type !== 'heading') continue
    if (node.depth === 1 && !firstHeadingSkipped) {
      firstHeadingSkipped = true
      continue
    }
    return true
  }
  return false
}

function tableOfContentsEntries(
  root: MdNode,
  maximumDepth: number,
): Array<{ readonly title: string; readonly level: number }> {
  const entries: Array<{ title: string; level: number }> = []
  let firstTitleSkipped = false
  for (const node of root.children ?? []) {
    if (node.type !== 'heading') continue
    if (node.depth === 1 && !firstTitleSkipped) {
      firstTitleSkipped = true
      continue
    }
    const depth = Math.max(1, Math.min(6, node.depth ?? 1))
    const title = nodeText(node).trim()
    if (depth <= maximumDepth && title) {
      entries.push({ title, level: depth })
    }
  }
  return entries
}

function abortError(): Error {
  return new DOMException('Generate Word was cancelled.', 'AbortError')
}
