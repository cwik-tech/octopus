import { expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { seedProviderSettings, APP_DEFAULT_MODEL } from './support/model-selection-fixture.js'

for (const format of ['Word', 'Excel'] as const) {
  test(`chat revisions deliver a new ${format} file while keeping internal Markdown out of the UI`, async ({}, info) => {
    test.setTimeout(90_000)
    const initial = '# Quarterly report\n\n| Metric | Value |\n| --- | ---: |\n| Revenue | 42 |'
    const revised = '# Revised quarterly report\n\n| Metric | Value |\n| --- | ---: |\n| Revenue | 84 |'
    // Only the paid/nondeterministic provider HTTP boundary is replaced.
    // Chat, tool dispatch, generation, persistence, downloads and Canvas are real.
    const provider = await startFakeChatCompletionsServer({ script: format === 'Word' ? [
      { match: (request) => request.toolCount > 0 && request.userMessage?.includes('Create a Word') === true,
        toolCalls: [{ id: 'word-initial', name: 'generate_word', arguments: { action: 'generate', markdown: initial, outputPath: 'quarterly-report.docx', renderMermaid: false } }] },
      { match: (request) => request.toolCount > 0 && request.userMessage?.includes('Revise the Word') === true,
        toolCalls: [{ id: 'word-revised', name: 'generate_word', arguments: { action: 'generate', markdown: revised, outputPath: 'revised-quarterly-report.docx', renderMermaid: false } }] },
      { content: 'Document ready.' },
    ] : [
      { match: (request) => request.userMessage?.includes('Revise the Excel') === true && !request.stream, content: revised },
      { match: (request) => request.userMessage?.includes('Revise the Excel') === true && request.stream, content: revised },
      { content: initial },
    ] })
    const projectRoot = info.outputPath('project')
    const agentDirectory = path.join(projectRoot, 'agents/general-agent')
    await fs.mkdir(agentDirectory, { recursive: true })
    await fs.copyFile(path.join(process.cwd(), 'agents/general-agent/general-agent.md'), path.join(agentDirectory, 'general-agent.md'))
    // The isolated development project needs the same approved native payload
    // that a packaged application resolves from its resources directory.
    const nativeTarget = `${process.platform}-${process.arch}`
    await fs.cp(path.join(process.cwd(), 'build/office-tools', nativeTarget), path.join(projectRoot, 'build/office-tools', nativeTarget), { recursive: true })
    const userDataPath = info.outputPath('user')
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
    const app = await launchDesktop({ userDataPath, workspacePath: info.outputPath('workspace'), env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } })
    try {
      const page = await app.firstWindow()
      const chat = page.getByRole('region', { name: 'Run chat', exact: true })
      const send = async (text: string) => {
        await chat.getByRole('textbox').fill(text)
        const completed = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/messages'))
        await chat.getByRole('button', { name: 'Send message', exact: true }).click()
        expect((await completed).status()).toBe(201)
      }
      await send(`Create a ${format} file with a Quarterly report containing Revenue 42.`)
      const storeFiles = async () => {
        const sessions = await fs.readdir(info.outputPath('workspace/sessions'))
        const sessionId = sessions.find((name) => /^[0-9a-f-]{36}$/i.test(name))
        if (!sessionId) throw new Error('Chat session was not persisted')
        const { FileSystemSessionStore } = await import('../../domains/sessions/session-store.js')
        const messages = await new FileSystemSessionStore(info.outputPath('workspace')).listChatMessages(sessionId)
        return messages.flatMap((message) => message.delivery?.artifacts ?? [])
      }
      const firstFiles = await storeFiles()
      const original = firstFiles.find((artifact) => /\.(docx|xlsx)$/i.test(artifact.path))
      expect(original).toBeDefined()
      if (!original) throw new Error('Office delivery missing')
      // Use the real download endpoint advertised by the UI.
      await chat.getByRole('button', { name: format === 'Word' ? 'Open in Canvas' : 'Open full view', exact: true }).click()
      const canvas = page.getByRole('region', { name: 'Canvas workspace', exact: true })
      const preview = canvas.getByRole('tabpanel', { name: original.path.split('/').at(-1) ?? original.path, exact: true }).frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
      await expect(preview.locator('body')).toContainText('Revenue')
      const firstDownload = canvas.getByLabel(`Download ${original.path.split('/').at(-1)}`)
      const originalHref = await firstDownload.getAttribute('href')
      if (!originalHref) throw new Error('Original download URL missing')
      const originalBytes = await (await page.request.get(originalHref)).body()
      await expect(chat.getByText(/Markdown source/)).toHaveCount(0)
      await expect(canvas.getByRole('tab', { name: /\.md$/i })).toHaveCount(0)
      await expect(canvas.getByRole('tab', { name: 'Source', exact: true })).toHaveCount(0)
      await expect(canvas.getByRole('button', { name: 'Create working copy', exact: true })).toHaveCount(0)
      await send(`Revise the ${format} file: change the heading to Revised quarterly report and Revenue to 84. Return a new ${format} file.`)
      const files = await storeFiles()
      const office = files.filter((artifact) => /\.(docx|xlsx)$/i.test(artifact.path))
      expect(office).toHaveLength(2)
      expect(files.filter((artifact) => artifact.role === 'secondary' && /\.md$/i.test(artifact.path))).toHaveLength(2)
      await expect(chat.getByText(/Markdown source/)).toHaveCount(0)
      await expect(canvas.getByRole('tab', { name: /\.md$/i })).toHaveCount(0)
      const latest = office.at(-1)
      if (!latest) throw new Error('Revised Office delivery missing')
      await expect(canvas.getByRole('tab', { name: latest.path.split('/').at(-1) ?? latest.path, exact: true })).toHaveAttribute('aria-selected', 'true')
      const revisedHref = await canvas.getByLabel(`Download ${latest.path.split('/').at(-1)}`).getAttribute('href')
      if (!revisedHref) throw new Error('Revised download URL missing')
      const revisedBytes = await (await page.request.get(revisedHref)).body()
      const revisedPreview = canvas.getByRole('tabpanel', { name: latest.path.split('/').at(-1) ?? latest.path, exact: true }).frameLocator('iframe[title="HTML preview"]').frameLocator('iframe[title="HTML document"]')
      await expect(revisedPreview.locator('body')).toContainText('84')
      expect(await (await page.request.get(originalHref)).body()).toEqual(originalBytes)
      if (format === 'Word') {
        const xml = await (await JSZip.loadAsync(revisedBytes)).file('word/document.xml')?.async('string')
        expect(xml).toContain('Revised quarterly report')
        expect(xml).toContain('84')
      } else {
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(Uint8Array.from(revisedBytes).buffer)
        expect(workbook.worksheets[0]?.name).toBe('Revised quarterly report')
        expect(workbook.worksheets[0]?.getSheetValues()).toContainEqual([undefined, 'Revenue', 84])
      }
      await page.screenshot({ path: info.outputPath('office-chat-revision.png') })
    } finally { await app.close(); await provider.close() }
  })
}
