import { expect, test as base, type TestInfo } from '@playwright/test'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { launchDesktop } from './support/desktop-launch.js'
import { FIXTURE_PROVIDER, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

async function openCanvasChat(info: TestInfo) {
  // Only the paid/nondeterministic provider HTTP boundary is replaced.
  // File creation, publication, chat, API, persistence and windows are real.
  const provider = await startOpenAiToolLoopFixture(process.cwd(), 'openai-tool-loop-server.mjs', {
    env: { PROVIDER_FANOUT_SCRIPT: JSON.stringify({ calls: [
      { id: 'canvas-alpha', name: 'create_file', arguments: { filename: 'alpha.md', content: '# Alpha document\n\nFirst saved output.' } },
      { id: 'canvas-beta', name: 'create_file', arguments: { filename: 'beta.md', content: '# Beta document\n\nSecond saved output.' } },
    ], finalText: 'Both Canvas documents are ready.' }) },
  })
  const userDataPath = info.outputPath('user')
  const workspacePath = info.outputPath('workspace')
  const projectRoot = info.outputPath('project')
  try {
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: { id: 'fixture/fanout', name: 'Canvas files' }, models: [{ id: 'fixture/fanout', name: 'Canvas files' }] })
    await writeAgentPersona(projectRoot, { name: 'general-agent', description: 'Canvas fixture', marker: 'Create the requested files.', tier: 'orchestration', provider: FIXTURE_PROVIDER, model: 'fixture/fanout' })
    const app = await launchDesktop({ userDataPath, workspacePath, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
    try {
      const page = await app.firstWindow()
      const chat = page.getByRole('region', { name: 'Run chat', exact: true })
      const savedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname))
      await chat.getByRole('textbox').fill('Create alpha.md and beta.md as separate Markdown files.')
      await chat.getByRole('textbox').press('Enter')
      await expect(chat.getByText('Both Canvas documents are ready.', { exact: true })).toBeVisible()
      const sessionId = new URL((await savedResponse).url()).pathname.split('/sessions/')[1]?.split('/')[0] ?? ''
      expect(sessionId).toMatch(/^[a-f0-9-]{36}$/)
      return { app, page, chat, sessionId, provider }
    } catch (error) {
      await app.close()
      throw error
    }
  } catch (error) {
    await provider.close()
    throw error
  }
}

// Startup and real agent file generation arrange the delivered-file starting
// condition. Keep their bounded fixture budget separate from Canvas's 30s flow.
const test = base.extend<{ journey: Awaited<ReturnType<typeof openCanvasChat>> }>({
  journey: [async ({}, use, info) => {
    const journey = await openCanvasChat(info)
    try { await use(journey) }
    finally { await journey.app.close(); await journey.provider.close() }
  }, { timeout: 60_000 }],
})

test('J1 a chat keeps document tabs across closing, reopening and reload', async ({ journey }, info) => {
  const { page, chat, sessionId } = journey
    await chat.getByRole('button', { name: 'Open full view', exact: true }).nth(0).click()
    const canvas = page.getByRole('region', { name: 'Canvas workspace', exact: true })
    await expect(canvas.getByRole('tab', { name: 'alpha.md', exact: true })).toBeVisible()
    await chat.getByRole('button', { name: 'Open full view', exact: true }).nth(1).click()
    await expect(canvas.getByRole('tab', { name: 'beta.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await canvas.getByRole('tab', { name: 'alpha.md', exact: true }).click()
    await expect(canvas.getByRole('heading', { name: 'Alpha document', exact: true })).toBeVisible()
    await canvas.getByRole('button', { name: 'Close alpha.md', exact: true }).click()
    await expect(canvas.getByRole('tab', { name: 'alpha.md', exact: true })).toHaveCount(0)
    await chat.getByRole('button', { name: 'Open full view', exact: true }).nth(0).click()
    await expect(canvas.getByRole('tab')).toHaveCount(2)
    await page.reload()
    await page.locator(`[data-session-id="${sessionId}"]`).getByRole('button').first().click()
    await expect(canvas.getByRole('tab')).toHaveCount(2)
    await expect(canvas.getByRole('tab', { name: 'alpha.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(canvas.getByRole('heading', { name: 'Alpha document', exact: true })).toBeVisible()
    await canvas.getByRole('button', { name: 'Expand Canvas', exact: true }).click({ trial: true })
    await page.screenshot({ path: info.outputPath('canvas-docked.png') })
})

test('J2 Canvas expands and detaches without losing tabs and native close restores the docked workspace', async ({ journey }, info) => {
  const { app, page, chat, sessionId } = journey
    await chat.getByRole('button', { name: 'Open full view', exact: true }).nth(0).click()
    await chat.getByRole('button', { name: 'Open full view', exact: true }).nth(1).click()
    const source = page.getByRole('region', { name: 'Canvas workspace', exact: true })
    await expect(source.getByRole('tab', { name: 'beta.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await source.getByRole('button', { name: 'Expand Canvas', exact: true }).click()
    await expect(source.getByRole('heading', { name: 'Beta document', exact: true })).toBeVisible()
    const header = page.locator('header.desktop-titlebar')
    const headerBox = await header.boundingBox()
    const canvasBox = await source.boundingBox()
    expect(headerBox).not.toBeNull()
    expect(canvasBox).not.toBeNull()
    expect(canvasBox?.y).toBeGreaterThanOrEqual((headerBox?.y ?? 0) + (headerBox?.height ?? 0))
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.screenshot({ path: info.outputPath('canvas-expanded.png') })
    await source.getByRole('button', { name: 'Dock Canvas', exact: true }).click()
    await expect(source.getByRole('button', { name: 'Open Canvas in new window', exact: true })).toBeVisible()
    const opening = app.waitForEvent('window')
    await source.getByRole('button', { name: 'Open Canvas in new window', exact: true }).click()
    const detached = await opening
    const canvas = detached.getByRole('region', { name: 'Canvas workspace', exact: true })
    await expect(canvas.getByRole('tab')).toHaveCount(2)
    await expect(canvas.getByRole('heading', { name: 'Beta document', exact: true })).toBeVisible()
    await expect(detached.getByRole('region', { name: 'Run chat', exact: true })).toHaveCount(0)
    await expect(source).not.toBeVisible()
    await page.getByRole('group', { name: 'Right window actions' }).getByRole('button', { name: 'Show inspector', exact: true }).click()
    expect(app.windows()).toHaveLength(2)
    await canvas.getByRole('tab', { name: 'alpha.md', exact: true }).click()
    await expect(canvas.getByRole('heading', { name: 'Alpha document', exact: true })).toBeVisible()
    await detached.screenshot({ path: info.outputPath('canvas-detached.png') })
    await detached.close()
    await expect(source.getByRole('tab', { name: 'alpha.md', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(source.getByRole('button', { name: 'Expand Canvas', exact: true })).toBeVisible()
    const reopening = app.waitForEvent('window')
    await source.getByRole('button', { name: 'Open Canvas in new window', exact: true }).click()
    const second = await reopening
    await expect(second.getByRole('tab', { name: 'alpha.md', exact: true })).toBeVisible()
    await page.getByRole('group', { name: 'Left window actions' }).getByRole('button', { name: 'New chat', exact: true }).click()
    await second.close()
    await expect(page.getByRole('region', { name: 'Run chat', exact: true }).getByRole('textbox')).toHaveValue('')
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
    await page.locator(`[data-session-id="${sessionId}"]`).getByRole('button').first().click()
    await expect(source.getByRole('tab')).toHaveCount(2)
    await expect(source.getByRole('button', { name: 'Expand Canvas', exact: true })).toBeVisible()
})


test('J3 new deliveries open automatically in the sidebar and the existing detached window', async ({ journey }) => {
  const { app, page, chat } = journey
  const source = page.getByRole('region', { name: 'Canvas workspace', exact: true })
  await expect(source.getByRole('tab', { name: 'beta.md', exact: true })).toBeVisible()
  await expect(source.getByRole('tab', { name: 'beta.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  const sidebar = page.getByRole('complementary', { name: 'Context sidebar', exact: true })
  await expect(sidebar.getByRole('region', { name: 'Canvas workspace', exact: true })).toBeVisible()
  await expect(page.getByRole('separator', { name: 'Resize right sidebar', exact: true })).toBeVisible()
  await page.getByRole('group', { name: 'Right window actions' }).getByRole('button', { name: 'Hide inspector', exact: true }).click()
  await expect(source).not.toBeVisible()
  await page.getByRole('group', { name: 'Right window actions' }).getByRole('button', { name: 'Show inspector', exact: true }).click()
  await expect(source).toBeVisible()
  const openChatWidth = (await chat.boundingBox())?.width ?? 0
  await source.getByRole('button', { name: 'Hide Canvas', exact: true }).click()
  await expect(source).toHaveCount(0)
  await expect(page.locator('aside[aria-label="Context sidebar"]')).toHaveAttribute('aria-hidden', 'true')
  await expect.poll(async () => (await chat.boundingBox())?.width ?? 0).toBeGreaterThan(openChatWidth)
  await chat.getByRole('textbox').fill('Create another pair of documents.')
  await chat.getByRole('textbox').press('Enter')
  await expect(chat.getByText('Both Canvas documents are ready.', { exact: true })).toHaveCount(2)
  await expect(source.getByRole('tab')).toHaveCount(4)
  const opening = app.waitForEvent('window')
  await source.getByRole('button', { name: 'Open Canvas in new window', exact: true }).click()
  const detached = await opening
  await expect(detached.getByRole('tab')).toHaveCount(4)
  await chat.getByRole('textbox').fill('Create a third pair of documents.')
  await chat.getByRole('textbox').press('Enter')
  await expect(chat.getByText('Both Canvas documents are ready.', { exact: true })).toHaveCount(3)
  await expect(detached.getByRole('tab')).toHaveCount(6)
  await expect(detached.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
  await expect(source).not.toBeVisible()
  expect(app.windows()).toHaveLength(2)
  await detached.close()
  await expect(source.getByRole('tab')).toHaveCount(6)
})
