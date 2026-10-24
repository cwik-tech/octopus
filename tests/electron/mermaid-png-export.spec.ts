import { _electron as electron, expect, test, type TestInfo } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { buildChatMessage } from '../../services/session-service.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const portraitDiagram = `
\`\`\`mermaid
flowchart TD
  A[Create Agent] --> B{Configuration valid?}
  B -->|Yes| C[Save package]
  B -->|No| D[Show validation]
  C --> E[Register agent]
  E --> F[Assign tools]
  F --> G[Test agent]
  G --> H{Passes?}
  H -->|Yes| I[Ready]
  H -->|No| D
  D --> A
\`\`\`
`

const punctuationRichQuadrantDiagram = `
\`\`\`mermaid
quadrantChart
    title DemoCo Robustness Across Futures
    x-axis Low Prefab Adoption --> High Prefab Adoption
    y-axis Lenient Regs --> Strict Regs
    quadrant-1 High Growth, Lenient: Strong uptake, 40% margins possible (optimal)
    quadrant-2 High Growth, Strict: Demand exists but formulation/R&D costs erode margins (struggles)
    quadrant-3 Low Growth, Lenient: Market too small, breakeven at 8 units unreachable (fails)
    quadrant-4 Low Growth, Strict: Regulatory + volume headwinds; near-certain failure
\`\`\`
`

async function openPersistedMermaidSession(
  testInfo: TestInfo,
  title: string,
  content: string,
) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRootPath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title })
  await sessionStore.appendChatMessage(
    session.id,
    buildChatMessage('assistant', content),
  )
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  const page = await app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`^${title}\\b`) }).first().click()
  return { app, page }
}

test('Mermaid PNG download preserves high-resolution chart dimensions', async ({}, testInfo) => {
  const { app, page } = await openPersistedMermaidSession(
    testInfo,
    'Mermaid PNG export',
    portraitDiagram,
  )

  try {
    const chart = page.locator('[data-streamdown="mermaid"]')
    await expect(chart).toBeVisible()
    const viewBox = await chart.locator('svg.flowchart').getAttribute('viewBox')
    const [, , logicalWidth, logicalHeight] = (viewBox ?? '')
      .trim()
      .split(/[ ,]+/)
      .map(Number)
    expect(logicalWidth).toBeGreaterThan(0)
    expect(logicalHeight).toBeGreaterThan(0)
    // Reached only when both expectations above passed, which they cannot do
    // for undefined, so this never throws; it tells the compiler what they did.
    if (logicalWidth === undefined || logicalHeight === undefined) {
      throw new Error('The chart viewBox has no width and height.')
    }

    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __mermaidPngBlob?: Blob
        __mermaidPngUrl?: string
      }
      const createObjectUrl = URL.createObjectURL
      URL.createObjectURL = (object) => {
        if (object instanceof Blob && object.type === 'image/png') {
          state.__mermaidPngBlob = object
        }
        return createObjectUrl(object)
      }
      const anchorClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function click() {
        if (this.download === 'diagram.png') {
          state.__mermaidPngUrl = this.href
          return
        }
        anchorClick.call(this)
      }
      URL.revokeObjectURL = () => undefined
    })

    await page.getByRole('button', { name: 'Download diagram', exact: true }).click()
    await page.getByRole('button', { name: 'PNG', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as typeof globalThis & { __mermaidPngUrl?: string })
            .__mermaidPngUrl,
        ),
      )
      .toMatch(/^blob:/)

    const pngBytes = await page.evaluate(async () => {
      const blob = (
        globalThis as typeof globalThis & { __mermaidPngBlob?: Blob }
      ).__mermaidPngBlob
      if (!blob) throw new Error('Mermaid PNG blob was not captured')
      const buffer = await blob.arrayBuffer()
      return [...new Uint8Array(buffer)]
    })
    const dimensions = readPngDimensions(Buffer.from(pngBytes))
    expect(dimensions.width).toBeGreaterThanOrEqual(Math.floor(logicalWidth * 4))
    expect(dimensions.height).toBeGreaterThanOrEqual(Math.floor(logicalHeight * 4))
  } finally {
    await app.close()
  }
})

test('persisted Mermaid quadrant labels with punctuation render as a chart', async ({}, testInfo) => {
  const { app, page } = await openPersistedMermaidSession(
    testInfo,
    'Mermaid quadrant recovery',
    punctuationRichQuadrantDiagram,
  )

  try {
    const chart = page.locator('[data-streamdown="mermaid"]')
    await expect(chart).toBeVisible()
    await expect(
      chart.locator('svg[aria-roledescription="quadrantChart"]'),
    ).toBeVisible()
    await expect(chart).toContainText('High Growth, Lenient: Strong uptake')
    await expect(chart).toContainText('near-certain failure')
  } finally {
    await app.close()
  }
})

function readPngDimensions(data: Buffer): { width: number; height: number } {
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(data.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  }
}
