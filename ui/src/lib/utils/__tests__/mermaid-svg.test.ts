import { describe, expect, it } from 'vitest'

import { addMermaidSvgIntrinsicDimensions } from '@/lib/utils/mermaid-svg'

function parseSvg(svg: string): SVGSVGElement {
  return new DOMParser().parseFromString(svg, 'image/svg+xml')
    .documentElement as unknown as SVGSVGElement
}

describe('addMermaidSvgIntrinsicDimensions', () => {
  it('uses the Mermaid viewBox for a high-resolution responsive PNG source', () => {
    const normalized = addMermaidSvgIntrinsicDimensions(
      '<svg width="100%" style="max-width: 387.72px; color: red;" viewBox="0 0 387.72 1038.75"><text>Chart</text></svg>',
    )
    const root = parseSvg(normalized)
    const style = root.getAttribute('style')

    expect(root.getAttribute('width')).toBe('387')
    expect(root.getAttribute('height')).toBe('1038')
    expect(style).toContain('width: 100%')
    expect(style).toContain('max-width: 387.72px')
    expect(style).toContain('height: auto')
    expect(style).toContain('color: red')
  })

  it('bounds the raster size of exceptionally large diagrams', () => {
    const normalized = addMermaidSvgIntrinsicDimensions(
      '<svg width="100%" viewBox="0 0 10000 10000"></svg>',
    )
    const root = parseSvg(normalized)
    const width = Number(root.getAttribute('width'))
    const height = Number(root.getAttribute('height'))

    expect(width * 5).toBeLessThanOrEqual(16_000)
    expect(height * 5).toBeLessThanOrEqual(16_000)
    expect(width * height * 25).toBeLessThanOrEqual(16_000_000)
  })

  it('leaves SVG without a valid viewBox unchanged', () => {
    const svg = '<svg width="100%"><text>Chart</text></svg>'

    expect(addMermaidSvgIntrinsicDimensions(svg)).toBe(svg)
  })
})
