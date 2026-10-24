import { expect, test as base, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { generateWordBuffer } from '../../domains/word-generation/generate-word.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { launchDesktop } from './support/desktop-launch.js'
import ExcelJS from 'exceljs'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'

async function openOfficeCanvas(info: TestInfo, supplied?: { name: string; bytes: Buffer; openLabel: string }) {
  const workspacePath = info.outputPath('workspace')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Office preview' })
  const original = supplied?.bytes ?? (await generateWordBuffer('# Quarterly report\n\nRevenue increased to 42 million.', { renderMermaid: false })).buffer
  const name = supplied?.name ?? 'report.docx'
  const artifactPath = path.join(workspacePath, 'assignments', 'office-run', 'files', name)
  await fs.mkdir(path.dirname(artifactPath), { recursive: true })
  await fs.writeFile(artifactPath, original)
  const source = { runId: 'office-run', path: `files/${name.replace(/\.(docx|xlsx)$/i, '.md')}`, title: 'Internal Markdown source', role: 'secondary' as const }
  await sessionStore.appendChatMessage(session.id, {
    id: 'office-delivery', role: 'assistant', text: 'Report ready.', createdAt: '2026-10-19T00:00:00.000Z',
    delivery: { taskId: 'office-task', artifacts: [{ runId: 'office-run', path: `files/${name}`, role: 'final', digest: createHash('sha256').update(original).digest('hex') }, ...(/\.(docx|xlsx)$/i.test(name) ? [source] : [])] },
  })
  const app = await launchDesktop({ userDataPath: info.outputPath('user'), workspacePath })
  try {
    const page = await app.firstWindow()
    await page.locator(`[data-session-id="${session.id}"]`).getByRole('button').first().click()
    await page.getByRole('region', { name: 'Run chat', exact: true }).getByRole('button', { name: supplied?.openLabel ?? 'Open in Canvas', exact: true }).click()
    return { app, page, original, artifactPath, sessionId: session.id }
  } catch (error) { await app.close(); throw error }
}

const test = base.extend<{ journey: Awaited<ReturnType<typeof openOfficeCanvas>> }>({
  journey: [async ({}, use, info) => {
    const journey = await openOfficeCanvas(info)
    try { await use(journey) } finally { await journey.app.close() }
  }, { timeout: 60_000 }],
})

base('a workbook preview retains values while navigating between sheets', async ({}, info) => {
  base.setTimeout(60_000)
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Revenue').getCell('A1').value = 'Quarterly revenue'
  workbook.addWorksheet('Costs').getCell('A1').value = 'Operating costs'
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const journey = await openOfficeCanvas(info, { name: 'budget.xlsx', bytes, openLabel: 'Open full view' })
  try {
    const canvas = journey.page.getByRole('region', { name: 'Canvas workspace', exact: true })
    const preview = canvas.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
    await expect(preview.getByText('Quarterly revenue', { exact: true })).toBeVisible()
    await preview.getByRole('tab', { name: 'Costs', exact: true }).click()
    await expect(preview.getByText('Operating costs', { exact: true })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Create working copy', exact: true })).toHaveCount(0)
    await expect(canvas.getByRole('tab', { name: 'Source', exact: true })).toHaveCount(0)
    await expect(journey.page.getByText('Internal Markdown source', { exact: true })).toHaveCount(0)
    await expect(canvas.getByRole('tab', { name: 'budget.md', exact: true })).toHaveCount(0)
    expect(await fs.readFile(journey.artifactPath)).toEqual(bytes)
  } finally { await journey.app.close() }
})

test('a delivered Word document opens in Canvas without changing its original bytes', async ({ journey }, info) => {
    const { page, original, artifactPath } = journey
    const canvas = page.getByRole('region', { name: 'Canvas workspace', exact: true })
    const preview = canvas.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')

    await expect(preview.getByText('Quarterly report', { exact: true })).toBeVisible()
    await expect(preview.getByText('Revenue increased to 42 million.', { exact: true })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Create working copy', exact: true })).toHaveCount(0)
    await expect(canvas.getByRole('tab', { name: 'Source', exact: true })).toHaveCount(0)
    await expect(canvas.getByRole('textbox', { name: 'Revision instruction', exact: true })).toHaveCount(0)
    await expect(page.getByText('Internal Markdown source', { exact: true })).toHaveCount(0)
    await expect(canvas.getByRole('tab', { name: 'report.md', exact: true })).toHaveCount(0)
    const download = canvas.getByLabel('Download report.docx', { exact: true })
    await expect(download).toBeVisible()
    const response = await page.request.get(await download.getAttribute('href') ?? '')
    expect(response.ok()).toBe(true)
    expect(await response.body()).toEqual(original)
    expect(await fs.readFile(artifactPath)).toEqual(original)
    await page.screenshot({ path: info.outputPath('office-word-preview.png') })
    await fs.writeFile(artifactPath, Buffer.from('Invalid Office archive'))
    await canvas.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(canvas.getByRole('alert')).toContainText('Showing the last loaded preview.')
    await expect(preview.getByText('Quarterly report', { exact: true })).toBeVisible()
    await expect(preview.getByText('Revenue increased to 42 million.', { exact: true })).toBeVisible()
})

base('a saved Markdown revision produces a Word snapshot and a later save marks it out of date', async ({}, info) => {
  base.setTimeout(60_000)
  const bytes = Buffer.from('# Markdown snapshot\n\nSaved source text.')
  const journey = await openOfficeCanvas(info, { name: 'report.md', bytes, openLabel: 'Open full view' })
  try {
    const canvas = journey.page.getByRole('region', { name: 'Canvas workspace', exact: true })
    await canvas.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
    await canvas.getByRole('button', { name: 'Generate Word snapshot', exact: true }).click()
    const download = canvas.getByLabel('Download Word snapshot', { exact: true })
    await expect(download).toBeVisible()
    const response = await journey.page.request.get(await download.getAttribute('href') ?? '')
    expect(await (await JSZip.loadAsync(await response.body())).file('word/document.xml')?.async('string')).toContain('Markdown snapshot')
    await canvas.getByRole('button', { name: 'Preview Word snapshot', exact: true }).click()
    await expect(canvas.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]').getByText('Markdown snapshot', { exact: true })).toBeVisible()
    await canvas.getByRole('textbox', { name: 'Markdown document', exact: true }).fill('# Changed saved source')
    await canvas.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(canvas.getByText('Word snapshot is out of date.', { exact: true })).toBeVisible()
  } finally { await journey.app.close() }
})

base('slide navigation survives detaching Canvas and follows the selected app theme', async ({}, info) => {
  base.setTimeout(60_000)
  const { resolveOfficeBinary } = await import('../../services/officecli-binary-resolver.js')
  const { runOfficeProcess } = await import('../../services/officecli-process.js')
  const directory = info.outputPath('slide-source')
  await fs.mkdir(directory, { recursive: true })
  const signal = AbortSignal.timeout(15000)
  const executable = await resolveOfficeBinary(process.cwd(), signal)
  if (!executable) throw new Error('Stage the pinned OfficeCLI payload before running Office desktop tests')
  const file = path.join(directory, 'slides.pptx')
  expect((await runOfficeProcess({ executable, directory, signal, args: ['create', file, '--json'] })).ok).toBe(true)
  expect((await runOfficeProcess({ executable, directory, signal, args: ['add', file, '/', '--type', 'slide', '--prop', 'title=First slide', '--json'] })).ok).toBe(true)
  expect((await runOfficeProcess({ executable, directory, signal, args: ['add', file, '/', '--type', 'slide', '--prop', 'title=Second slide', '--json'] })).ok).toBe(true)
  const journey = await openOfficeCanvas(info, { name: 'slides.pptx', bytes: await fs.readFile(file), openLabel: 'Open full view' })
  try {
    const canvas = journey.page.getByRole('region', { name: 'Canvas workspace', exact: true })
    await journey.page.getByRole('button', { name: 'Use dark mode', exact: true }).click()
    const opening = journey.app.waitForEvent('window')
    await canvas.getByRole('button', { name: 'Open Canvas in new window', exact: true }).click()
    const detached = await opening
    await expect(detached.locator('html')).toHaveAttribute('data-theme', 'dark')
    const preview = detached.frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
    await expect(preview.locator('.slide-container[data-slide="1"]').getByText('First slide', { exact: true })).toBeVisible()
    // The pinned renderer hides thumbnails when navigator.webdriver is true.
    // Its normal keyboard navigation remains available inside the isolated frame.
    await preview.locator('.slide-container[data-slide="1"]').getByText('First slide', { exact: true }).click()
    await detached.keyboard.press('ArrowRight')
    await expect(preview.locator('.page-counter')).toHaveText('2 / 2')
    await expect(preview.locator('.slide-container[data-slide="2"]')).toBeInViewport()
    await journey.page.getByRole('button', { name: 'Use light mode', exact: true }).click()
    await expect(detached.locator('html')).toHaveAttribute('data-theme', 'light')
    await detached.screenshot({ path: info.outputPath('office-slides-detached.png') })
    await detached.close()
    await expect(canvas.getByRole('button', { name: 'Open Canvas in new window', exact: true })).toBeVisible()
  } finally { await journey.app.close() }
})
