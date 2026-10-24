import mermaid from 'mermaid'
import { describe, expect, it } from 'vitest'

import { normalizeChatMermaidSource } from '@/lib/utils/mermaid-source'

const punctuationRichQuadrantChart = `quadrantChart
    title DemoCo Robustness Across Futures
    x-axis Low Prefab Adoption --> High Prefab Adoption
    y-axis Lenient Regs --> Strict Regs
    quadrant-1 High Growth, Lenient: Strong uptake, 40% margins possible (optimal)
    quadrant-2 High Growth, Strict: Demand exists but formulation/R&D costs erode margins (struggles)
    quadrant-3 Low Growth, Lenient: Market too small, breakeven at 8 units unreachable (fails)
    quadrant-4 Low Growth, Strict: Regulatory + volume headwinds; near-certain failure`

describe('normalizeChatMermaidSource', () => {
  it('makes generated punctuation-rich quadrant labels valid Mermaid', async () => {
    const normalized = normalizeChatMermaidSource(punctuationRichQuadrantChart)

    expect(normalized).toContain(
      'quadrant-1 "High Growth, Lenient: Strong uptake, 40% margins possible (optimal)"',
    )
    expect(normalized).toContain(
      'quadrant-4 "Low Growth, Strict: Regulatory + volume headwinds; near-certain failure"',
    )
    await expect(mermaid.parse(normalized)).resolves.toBeDefined()
  })

  it('leaves non-quadrant diagrams and already quoted labels unchanged', () => {
    const flowchart = 'flowchart LR\n  A[Start] --> B[Finish]'
    const quotedQuadrant = 'quadrantChart\n  quadrant-1 "Safe: quoted label"'

    expect(normalizeChatMermaidSource(flowchart)).toBe(flowchart)
    expect(normalizeChatMermaidSource(quotedQuadrant)).toBe(quotedQuadrant)
  })
})
