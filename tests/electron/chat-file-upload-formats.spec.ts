import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const parserFixtures = path.join(repoRoot, 'file-parser', 'tests', 'fixtures')

/**
 * Real files off disk, not synthesised buffers: the point of this spec is that the bytes a person
 * actually uploads reach the parser the desktop app ships and come back with the right verdict.
 */
const uploads = {
  docx: path.join(parserFixtures, 'business-plan.docx'),
  ods: path.join(parserFixtures, 'yield-data.ods'),
  legacyDoc: path.join(parserFixtures, 'legacy-report.doc'),
}

test('Run composer parses OOXML and OpenDocument uploads and refuses a legacy .doc with a remedy', async ({}, testInfo) => {
  test.setTimeout(90_000)

  // A fixture that is not on disk would make every assertion below vacuous.
  for (const [label, fixture] of Object.entries(uploads)) {
    await expect(
      fs.access(fixture),
      `${label} fixture missing: ${fixture}`,
    ).resolves.toBeUndefined()
  }

  const workspacePath = testInfo.outputPath('chat-file-format-workspace')
  const projectRootPath = testInfo.outputPath('chat-file-format-project')
  const userDataPath = testInfo.outputPath('chat-file-format-user-data')
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
    title: 'Upload format E2E',
  })
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

  try {
    const page = await app.firstWindow()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page
      .getByRole('button', { name: /^Upload format E2E\b/ })
      .first()
      .click()

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText('Upload format E2E', { exact: true })).toBeVisible()

    // The run composer sets no `accept`, so a legacy .doc genuinely reaches the parser here.
    await chat
      .getByLabel('Upload files')
      .setInputFiles([uploads.docx, uploads.ods, uploads.legacyDoc])

    await expect(chat.getByTestId('file-message-card')).toHaveCount(3)

    const docxCard = chat
      .getByTestId('file-message-card')
      .filter({ hasText: 'business-plan.docx' })
    await expect(docxCard).toContainText('parsed', { timeout: 60_000 })

    const odsCard = chat
      .getByTestId('file-message-card')
      .filter({ hasText: 'yield-data.ods' })
    await expect(odsCard).toContainText('parsed', { timeout: 60_000 })

    const legacyCard = chat
      .getByTestId('file-message-card')
      .filter({ hasText: 'legacy-report.doc' })
    // Names the format, and says what to do about it. Not a library exception.
    await expect(legacyCard).toContainText('Word 97-2003 (.doc)', { timeout: 60_000 })
    await expect(legacyCard).toContainText('save it as .docx')
    await expect(legacyCard).not.toContainText('invalid signature')
    await expect(legacyCard).not.toContainText('central directory')

    // The store is the authority the chat context reads from, so assert it too.
    const stored = await sessionStore.listFiles(session.id)
    const byName = new Map(stored.map((file) => [file.name, file]))
    expect(byName.get('business-plan.docx')?.parseStatus).toBe('parsed')
    expect(byName.get('yield-data.ods')?.parseStatus).toBe('parsed')
    expect(byName.get('legacy-report.doc')?.parseStatus).toBe('error')
    expect(byName.get('legacy-report.doc')?.parserError).toContain('.docx')

    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})
