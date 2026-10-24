/**
 * The two visible upload journeys for local PDF OCR, in the real desktop application.
 *
 * Lower integration tests prove the service paths, the routing gate and the parser contract.
 * These exist for what only the desktop can show: that the composer a user actually reaches
 * uploads the file, that the upload reports itself parsed, and that the recognized value from a
 * page which exists only as pixels is in the stored artifact the next chat turn will read.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { TeamFileStore } from '../../domains/team-files/team-file-store.js'
import { readTeamFileContext } from '../../domains/team-files/team-file-context.js'
import { MIXED_OCR_FIXTURE } from '../../file-parser/tests/mixed-ocr-expectations.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

async function fixture(): Promise<Buffer> {
  return fs.readFile(
    path.join(repoRoot, 'file-parser', 'tests', 'fixtures', MIXED_OCR_FIXTURE.fileName),
  )
}

async function launchDesktop(testInfo: { outputPath: (name: string) => string }, prefix: string) {
  const workspacePath = testInfo.outputPath(`${prefix}-workspace`)
  const projectRootPath = testInfo.outputPath(`${prefix}-project`)
  const userDataPath = testInfo.outputPath(`${prefix}-user-data`)
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
      projectRootPath,
      { recursive: true },
    ),
  ])
  const configuredExecutable = process.env['PIPELINE_DESKTOP_EXECUTABLE']?.trim()
  const executablePath = configuredExecutable
    ? path.resolve(repoRoot, configuredExecutable)
    : undefined
  const app = await electron.launch({
    args: executablePath === undefined ? ['.'] : [],
    cwd: repoRoot,
    ...(executablePath === undefined ? {} : { executablePath }),
    env: {
      ...fixtureDesktopEnvironment(),
      NODE_ENV: 'test',
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      ...(executablePath === undefined ? { PIPELINE_DESKTOP_REPO_ROOT: repoRoot } : {}),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    },
  })
  return { app, workspacePath }
}

test('Run chat reads a pictured page from an uploaded PDF with no PDF model', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, workspacePath } = await launchDesktop(testInfo, 'run-ocr')
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Operating plan OCR' })

  try {
    const page = await app.firstWindow()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Operating plan OCR\b/ }).first().click()

    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByText('Operating plan OCR', { exact: true })).toBeVisible()

    await chat.getByLabel('Upload files').setInputFiles([
      {
        name: MIXED_OCR_FIXTURE.fileName,
        mimeType: 'application/pdf',
        buffer: await fixture(),
      },
    ])

    const card = chat.getByTestId('file-message-card').filter({
      hasText: MIXED_OCR_FIXTURE.fileName,
    })
    await expect(card).toHaveCount(1, { timeout: 60_000 })
    await expect(card).toContainText('parsed', { timeout: 60_000 })

    // The stored artifact is what the next chat turn puts in provider context.
    const [file] = await sessionStore.listFiles(session.id)
    expect(file?.outputs?.text).toBeTruthy()
    const parsed = await fs.readFile(
      path.join(workspacePath, 'sessions', session.id, 'inputs', 'parsed', file!.outputs!.text!),
      'utf8',
    )
    expect(parsed).toContain(MIXED_OCR_FIXTURE.page10.title)
    expect(parsed).toContain(MIXED_OCR_FIXTURE.page10.salesMarketing2028)
    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})

test('Create Agent and Team tabs share one upload whose pictured page is recognized', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, workspacePath } = await launchDesktop(testInfo, 'create-ocr')

  try {
    const page = await app.firstWindow()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))

    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    const resourceTabs = page.getByLabel('Resource type')
    await resourceTabs.getByRole('tab', { name: 'Agents', exact: true }).click()

    // The picker is a hidden input behind a button, so it is attached rather than visible.
    const composer = page.getByLabel('Upload files')
    await expect(composer).toBeAttached({ timeout: 30_000 })
    await composer.setInputFiles([
      {
        name: MIXED_OCR_FIXTURE.fileName,
        mimeType: 'application/pdf',
        buffer: await fixture(),
      },
    ])

    const card = page.getByTestId('file-message-card').filter({
      hasText: MIXED_OCR_FIXTURE.fileName,
    })
    await expect(card).toHaveCount(1, { timeout: 60_000 })
    await expect(card).toContainText('parsed', { timeout: 60_000 })

    // Switching the inspector changes which resource is being designed, not the upload. The
    // same card, from the same draft, is still there.
    await resourceTabs.getByRole('tab', { name: 'Teams', exact: true }).click()
    await expect(card).toHaveCount(1)

    // Resource Architect context, read from the draft the composer uploaded against, with no
    // PDF reader selected.
    const teamFileStore = new TeamFileStore(workspacePath)
    const owners = await fs.readdir(path.join(workspacePath, 'team'))
    expect(owners.length).toBeGreaterThan(0)
    const contexts = await Promise.all(
      owners.map((owner) => readTeamFileContext(teamFileStore, owner)),
    )
    const documents = contexts.flatMap((context) => context.documents)
    const uploaded = documents.find((document) => document.name === MIXED_OCR_FIXTURE.fileName)
    expect(uploaded).toBeTruthy()
    expect(uploaded!.content).toContain(MIXED_OCR_FIXTURE.page10.salesMarketing2028)
    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})
