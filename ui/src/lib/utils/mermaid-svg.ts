const STREAMDOWN_PNG_SCALE = 5
const MAX_PNG_EDGE = 16_000
const MAX_PNG_PIXELS = 16_000_000

// Match only the root SVG opening tag so Mermaid's nested HTML/SVG stays byte-for-byte intact.
const svgOpeningTagPattern = /<svg\b[^>]*>/i

function readAttribute(tag: string, name: string): string | null {
  // SVG attributes may be double-quoted, single-quoted, or unquoted.
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  )
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function setAttribute(tag: string, name: string, value: string): string {
  // Replace one whole root attribute without matching names such as data-width.
  const pattern = new RegExp(
    `\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
    'i',
  )
  if (pattern.test(tag)) {
    return tag.replace(pattern, ` ${name}="${value}"`)
  }
  return tag.replace(/>$/, ` ${name}="${value}">`)
}

function rasterDimensions(width: number, height: number) {
  const edgeScale = Math.min(
    MAX_PNG_EDGE / (width * STREAMDOWN_PNG_SCALE),
    MAX_PNG_EDGE / (height * STREAMDOWN_PNG_SCALE),
  )
  const areaScale = Math.sqrt(
    MAX_PNG_PIXELS /
      (width * height * STREAMDOWN_PNG_SCALE * STREAMDOWN_PNG_SCALE),
  )
  const scale = Math.min(1, edgeScale, areaScale)

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

function responsiveStyle(style: string | null, logicalWidth: number): string {
  const preserved = (style ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    // Mermaid's responsive layout values are rebuilt below around explicit intrinsic dimensions.
    .filter((declaration) => !/^(?:height|max-width|width)\s*:/i.test(declaration))

  return [
    ...preserved,
    'width: 100%',
    `max-width: ${logicalWidth}px`,
    'height: auto',
  ].join('; ')
}

export function addMermaidSvgIntrinsicDimensions(svg: string): string {
  const openingTag = svg.match(svgOpeningTagPattern)?.[0]
  if (!openingTag) return svg

  const viewBox = readAttribute(openingTag, 'viewBox')
  if (!viewBox) return svg
  const values = viewBox.trim().split(/[\s,]+/).map(Number)
  if (values.length !== 4) return svg

  const logicalWidth = values[2]
  const logicalHeight = values[3]
  if (
    logicalWidth === undefined ||
    logicalHeight === undefined ||
    !Number.isFinite(logicalWidth) ||
    !Number.isFinite(logicalHeight) ||
    logicalWidth <= 0 ||
    logicalHeight <= 0
  ) {
    return svg
  }

  const dimensions = rasterDimensions(logicalWidth, logicalHeight)
  let normalizedTag = setAttribute(openingTag, 'width', String(dimensions.width))
  normalizedTag = setAttribute(normalizedTag, 'height', String(dimensions.height))
  normalizedTag = setAttribute(
    normalizedTag,
    'style',
    responsiveStyle(readAttribute(normalizedTag, 'style'), logicalWidth),
  )

  return svg.replace(openingTag, normalizedTag)
}
