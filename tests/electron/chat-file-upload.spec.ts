import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { APP_DEFAULT_MODEL, seedProviderSettings } from './support/model-selection-fixture.js'
import { makeTextPdf } from '../helpers/text-pdf.js'

test('whole PDF review reaches the final page and restores truthful coverage after reload', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const workspacePath = testInfo.outputPath('review-workspace')
  const projectRootPath = testInfo.outputPath('review-project')
  const userDataPath = testInfo.outputPath('review-user-data')
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.cp(path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'), projectRootPath, { recursive: true })
  const store = new FileSystemSessionStore(workspacePath)
  await store.createSession({ title: 'Complete PDF review' })
  // Only the nondeterministic model's HTTP boundary is replaced.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => Boolean(request.systemPrompt?.includes('Review this fragment') && request.userMessage?.includes('PAGE_FACT_434=verified')), content: '{"evidence":["PAGE_FACT_434=verified"]}' },
    ...Array.from({ length: 450 }, () => ({ match: (request: import('../support/fake-chat-completions-server.js').FakeChatCompletionsRequest) => Boolean(request.systemPrompt?.includes('Review this fragment')), content: '{"evidence":[]}' })),
    { content: 'The final page states PAGE_FACT_434=verified.' },
  ] })
  let app: ElectronApplication | undefined
  const rendererErrors: string[] = []
  try {
    await seedProviderSettings({ userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL, kind: 'lm-studio' })
    app = await electron.launch({ args: ['.'], cwd: repoRoot, env: { ...fixtureDesktopEnvironment(), NODE_ENV: 'test', PIPELINE_DESKTOP_E2E: '1', PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_REPO_ROOT: repoRoot, PIPELINE_DESKTOP_USER_DATA: userDataPath, PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath } })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    // Startup seeds this isolated editable project before the chat journey begins.
    await page.getByRole('tab', { name: 'Run', exact: true }).click({ timeout: 90_000 })
    await page.getByRole('button', { name: /^Complete PDF review\b/ }).first().click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await chat.getByLabel('Upload files').setInputFiles({ name: 'complete.pdf', mimeType: 'application/pdf', buffer: makeTextPdf(434) })
    const card = chat.getByTestId('file-message-card').filter({ hasText: 'complete.pdf' })
    await expect(card).toContainText('parsed', { timeout: 20_000 })
    await chat.getByRole('textbox').fill('Review the entire PDF and report PAGE_FACT_434.')
    await chat.getByRole('textbox').press('Enter')
    await expect(chat.getByText('The final page states PAGE_FACT_434=verified.', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('434/434 pages processed')
    expect(JSON.stringify(provider.requests.at(-1)?.body.messages)).toContain('PAGE_FACT_434=verified')
    await page.reload()
    await page.getByRole('button', { name: /^Complete PDF review\b/ }).first().click()
    await expect(page.getByTestId('file-message-card').filter({ hasText: 'complete.pdf' })).toContainText('434/434 pages processed')
  } finally {
    await testInfo.attach('renderer-errors', { body: JSON.stringify(rendererErrors), contentType: 'application/json' });
    await app?.close(); await provider.close()
  }
})

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

test('Run composer uploads multiple files, restores cards, and deletes without chat attachments', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const workspacePath = testInfo.outputPath('chat-file-workspace')
  const projectRootPath = testInfo.outputPath('chat-file-project')
  const userDataPath = testInfo.outputPath('chat-file-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({
    title: 'Multi-file upload E2E',
  })
  // Sending is what persists the message, and a turn is admitted only on a
  // model. The General Agent names none, so an application default has to
  // exist, written the way Settings writes it, on a keyless LM Studio
  // connection: the native tool route refuses a keyless OpenAI-compatible one.
  // The reply itself is not what this journey checks.
  const provider = await startFakeChatCompletionsServer({
    script: [{ content: 'Noted.', deltas: ['Noted.'] }],
  })
  // From here the server is owned: seeding, launching and the journey run under
  // one guard, and teardown closes whatever was started, whatever failed.
  let app: ElectronApplication | undefined
  let primaryFailure: { readonly error: unknown } | undefined
  try {
    await seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      kind: 'lm-studio',
    })
    app = await electron.launch({
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
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .getByRole('button', { name: /^Multi-file upload E2E\b/ })
      .first()
      .click()

    let chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText('Multi-file upload E2E', { exact: true })).toBeVisible()
    await chat
      .getByRole('button', { name: 'Add files or MCP resources' })
      .click()
    const mcpMenuItem = page.getByRole('menuitem', { name: 'Add from MCP' })
    await expect(mcpMenuItem).toBeVisible()
    await expect(mcpMenuItem).toHaveCSS('white-space', 'nowrap')
    await page.keyboard.press('Escape')

    const picker = chat.getByLabel('Upload files')
    await expect(picker).toHaveAttribute('multiple', '')
    await picker.setInputFiles([
      {
        name: 'first-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('first grounded context'),
      },
      {
        name: 'second-context.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('second grounded context'),
      },
    ])

    await expect(chat.getByTestId('file-message-card')).toHaveCount(2)
    for (const filename of ['first-context.txt', 'second-context.txt']) {
      const card = chat.getByTestId('file-message-card').filter({
        hasText: filename,
      })
      await expect(card).toHaveAttribute('data-state', 'current')
      await expect(card).toContainText('parsed')
      await expect(
        chat.getByRole('button', { name: `Scroll to ${filename}` }),
      ).toBeVisible()
    }
    const firstFileIcon = chat.getByRole('button', {
      name: 'Scroll to first-context.txt',
    })
    await firstFileIcon.hover()
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
      'first-context.txt',
    )
    await expect(firstFileIcon).not.toHaveAttribute('title')

    await page.reload()
    await page
      .getByRole('button', { name: /^Multi-file upload E2E\b/ })
      .first()
      .click()
    chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByTestId('file-message-card')).toHaveCount(2)
    await expect(
      chat.getByRole('button', { name: 'Scroll to first-context.txt' }),
    ).toBeVisible()

    const beforeDeleteFiles = await sessionStore.listFiles(session.id)
    const firstParsedOutput = beforeDeleteFiles.find(
      (file) => file.name === 'first-context.txt',
    )?.outputs?.text
    expect(firstParsedOutput).toBeTruthy()

    await chat
      .getByRole('button', { name: 'Delete first-context.txt' })
      .click()
    await expect(chat.getByText('Delete this file?')).toBeVisible()
    await chat.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(
      chat.getByTestId('file-message-card').filter({
        hasText: 'first-context.txt',
      }),
    ).toHaveCount(0)
    await expect(
      chat.getByRole('button', { name: 'Scroll to first-context.txt' }),
    ).toHaveCount(0)
    await expect(
      chat.getByTestId('file-message-card').filter({
        hasText: 'second-context.txt',
      }),
    ).toHaveCount(1)

    const authoritativeFiles = await sessionStore.listFiles(session.id)
    expect(authoritativeFiles.map((file) => file.name)).toEqual([
      'second-context.txt',
    ])
    await expect(
      fs.access(
        path.join(
          workspacePath,
          'sessions',
          session.id,
          'inputs',
          'parsed',
          firstParsedOutput!,
        ),
      ),
    ).rejects.toThrow()

    await chat.getByRole('textbox').fill('Use the remaining attachment.')
    await chat.getByRole('textbox').press('Enter')
    const remainingCard = chat.getByTestId('file-message-card').filter({
      hasText: 'second-context.txt',
    })
    await expect(remainingCard).toContainText('revision locked')
    await expect(
      chat.getByRole('button', { name: 'Delete second-context.txt' }),
    ).toHaveCount(0)
    await expect
      .poll(async () => {
        const [file] = await sessionStore.listFiles(session.id)
        return typeof file?.usedAt
      })
      .toBe('string')
    await expect
      .poll(async () => {
        const messages = await sessionStore.listChatMessages(session.id)
        return messages.some(
          (message) =>
            message.role === 'user' &&
            message.text === 'Use the remaining attachment.',
        )
      })
      .toBe(true)

    const chatLog = await fs
      .readFile(
        path.join(workspacePath, 'sessions', session.id, 'chat.jsonl'),
        'utf8',
      )
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
    expect(chatLog).not.toContain('first-context.txt')
    expect(chatLog).not.toContain('second-context.txt')
    expect(pageErrors).toEqual([])
  } catch (error) {
    primaryFailure = { error }
  }
  const launched = app
  await finishWithTeardown(primaryFailure, [
    ...(launched ? [() => launched.close()] : []),
    () => provider.close(),
  ])
})

/**
 * Runs every teardown step even when an earlier one fails, then rethrows the
 * journey's own failure with any teardown errors beside it, never instead of
 * it.
 */
async function finishWithTeardown(
  primaryFailure: { readonly error: unknown } | undefined,
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const teardownErrors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      teardownErrors.push(error)
    }
  }
  if (primaryFailure && teardownErrors.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...teardownErrors],
      'The journey failed, and so did its teardown',
    )
  }
  if (primaryFailure) throw primaryFailure.error
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, 'The journey passed, but its teardown failed')
  }
}
