import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const stdioFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

test('Settings adds, protects, reconnects, disables, and deletes a real stdio MCP', async ({}, testInfo) => {
  test.setTimeout(45_000)
  const userDataPath = testInfo.outputPath('mcp-settings-user-data')
  const lifecyclePath = testInfo.outputPath('mcp-lifecycle.jsonl')
  const secret = `desktop-mcp-secret-${Date.now()}`
  await fs.mkdir(userDataPath, { recursive: true })

  let app = await launchDesktop(userDataPath)
  let page = await app.firstWindow()
  try {
    await openMcpSettings(page)
    await page.getByRole('button', { name: 'Add connection' }).click()
    await page.getByRole('button', { name: 'Paste JSON' }).click()
    await page.getByRole('textbox', { name: 'MCP configuration JSON' }).fill(JSON.stringify({
      mcpServers: {
        'Fixture MCP': {
          command: process.execPath,
          args: [stdioFixturePath],
          env: {
            MCP_FIXTURE_LIFECYCLE_PATH: lifecyclePath,
            MCP_FIXTURE_TEST_SECRET: secret,
          },
        },
      },
    }))
    await page.getByRole('button', { name: 'Apply JSON' }).click()
    await expect(page.getByLabel('Name')).toHaveValue('Fixture MCP')
    await expect(page.getByRole('textbox', { name: 'Command', exact: true }))
      .toHaveValue(process.execPath)
    await expect(page.getByLabel('Arguments, one per line')).toHaveValue(stdioFixturePath)
    await page.getByLabel(
      'I trust this command and understand validation will run it locally on this computer.',
    ).check()
    await page.getByRole('button', { name: 'Save & Validate' }).click()

    const row = page.locator('[data-mcp-server]').filter({ hasText: 'Fixture MCP' })
    await expect(row).toBeVisible()
    await expect(row.getByText('Connected', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Enable Fixture MCP')).toBeChecked()
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(1)
  } finally {
    await app.close()
  }
  await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(1)

  const persisted = await fs.readFile(
    path.join(userDataPath, 'mcp-settings.json'),
    'utf8',
  )
  expect(persisted).toContain('opaque-platform-ciphertext')
  expect(persisted).toContain('MCP_FIXTURE_TEST_SECRET')
  expect(persisted).not.toContain(secret)
  expect(persisted).not.toContain(lifecyclePath)

  app = await launchDesktop(userDataPath)
  page = await app.firstWindow()
  try {
    await openMcpSettings(page)
    const row = page.locator('[data-mcp-server]').filter({ hasText: 'Fixture MCP' })
    await expect(row.getByText('Connected', { exact: true })).toBeVisible()
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(2)

    await page.getByLabel('Edit Fixture MCP').click()
    await expect(
      page.getByLabel('Secret environment variables value 1'),
    ).toHaveValue('')
    await expect(
      page.getByLabel('Secret environment variables value 2'),
    ).toHaveValue('')
    await page.getByLabel('Close editor').click()

    await page.getByLabel('Enable Fixture MCP').click()
    await expect(row.getByText('Disabled', { exact: true })).toBeVisible()
    await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(2)

    await page.getByLabel('Enable Fixture MCP').click()
    await expect(row.getByText('Connected', { exact: true })).toBeVisible()
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(3)

    await page.getByLabel('Delete Fixture MCP').click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(3)
  } finally {
    await app.close()
  }

  const events = await readLifecycle(lifecyclePath)
  expect(events.filter((event) => event.event === 'ready')).toHaveLength(3)
  expect(events.filter((event) => event.event === 'stopped')).toHaveLength(3)
  expect(events.every((event) => event.secretPresent !== false)).toBe(true)
  for (const pid of new Set(events.map((event) => event.pid))) {
    await expect.poll(() => isProcessAlive(pid)).toBe(false)
  }
})

async function launchDesktop(userDataPath: string) {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  return electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: '1',
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
    },
  })
}

async function openMcpSettings(page: Page): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'MCPs' }).click()
  await expect(page.getByRole('heading', { name: 'MCPs' })).toBeVisible()
}

interface LifecycleEvent {
  event: 'ready' | 'stopped'
  pid: number
  secretPresent?: boolean
}

async function readLifecycle(filePath: string): Promise<LifecycleEvent[]> {
  try {
    const contents = await fs.readFile(filePath, 'utf8')
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LifecycleEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function lifecycleCount(
  filePath: string,
  event: LifecycleEvent['event'],
): Promise<number> {
  return (await readLifecycle(filePath)).filter((entry) => entry.event === event)
    .length
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
