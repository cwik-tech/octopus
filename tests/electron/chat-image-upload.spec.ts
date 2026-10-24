import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SourceFileParserLauncher } from '../../core/file-parser-launcher.js'
import { captureSessionDocuments } from '../../services/document-context-service.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { APP_DEFAULT_MODEL, repoRoot, seedProviderSettings } from './support/model-selection-fixture.js'

test('Run chat reads both uploaded images and restores the successful conversation after reload', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.cp(path.join(repoRoot, 'tests/fixtures/packaged-workflow-smoke'), projectRootPath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Image attachment regression' })
  // The runtime owns IDs. Fill this test's provider fixture after the real upload
  // has frozen its revisions, so neither display names nor a copied hash algorithm
  // choose which document is read. Only the paid model HTTP boundary is replaced.
  const firstRead = { document: '' }
  const secondRead = { document: '' }
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => request.toolCount > 0 && Boolean(request.userMessage?.includes('project-oriented')),
      toolCalls: [
        { id: 'read-first-image', name: 'document_read', arguments: firstRead },
        { id: 'read-second-image', name: 'document_read', arguments: secondRead },
      ] },
    { content: 'Use a project sidebar and a task list.' },
  ] })
  let app: ElectronApplication | undefined
  const errors: string[] = []
  try {
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL, kind: 'lm-studio' })
    app = await electron.launch({ args: ['.'], cwd: repoRoot, env: {
      ...fixtureDesktopEnvironment(), NODE_ENV: 'test', PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath, PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    } })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('tab', { name: 'Run', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('button', { name: /^Image attachment regression\b/ }).first().click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await chat.getByLabel('Upload files').setInputFiles([
      path.join(repoRoot, 'file-parser/tests/fixtures/test-photo.jpg'),
      path.join(repoRoot, 'file-parser/tests/fixtures/icon.png'),
    ])
    await expect(chat.getByTestId('file-message-card')).toHaveCount(2)
    await expect(chat.getByTestId('file-message-card').filter({ hasText: 'test-photo.jpg' })).toContainText('parsed', { timeout: 20_000 })
    await expect(chat.getByTestId('file-message-card').filter({ hasText: 'icon.png' })).toContainText('parsed', { timeout: 20_000 })
    const files = await store.listFiles(session.id)
    const documents = await captureSessionDocuments({ sessionId: session.id, files, sessionStore: store,
      sourceRoot: store.inputsDir(session.id), parserLauncher: new SourceFileParserLauncher(repoRoot),
    })
    firstRead.document = documents.find((document) => document.name === 'test-photo.jpg')?.id ?? ''
    secondRead.document = documents.find((document) => document.name === 'icon.png')?.id ?? ''
    expect(firstRead.document).toMatch(/^doc_/)
    expect(secondRead.document).toMatch(/^doc_/)
    await chat.getByRole('textbox').fill('Suggest project-oriented improvements using both images. Do not code.')
    await chat.getByRole('textbox').press('Enter')
    await expect(chat.getByText('Use a project sidebar and a task list.', { exact: true })).toBeVisible({ timeout: 25_000 })
    const transported = JSON.stringify(provider.requests.map((request) => request.body.messages))
    const firstThumbnail = await fs.readFile(path.join(store.inputsDir(session.id), 'parsed/test-photo.jpg.thumb.jpg'))
    const secondThumbnail = await fs.readFile(path.join(store.inputsDir(session.id), 'parsed/icon.png.thumb.jpg'))
    expect(transported).toContain(`data:image/jpeg;base64,${firstThumbnail.toString('base64')}`)
    expect(transported).toContain(`data:image/jpeg;base64,${secondThumbnail.toString('base64')}`)
    await expect(chat.getByText('Captured document could not be parsed', { exact: true })).toHaveCount(0)
    await page.reload()
    await page.getByRole('button', { name: /^Image attachment regression\b/ }).first().click()
    await expect(page.getByText('Use a project sidebar and a task list.', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally { await app?.close(); await provider.close() }
})
