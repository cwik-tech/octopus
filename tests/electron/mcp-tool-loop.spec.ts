import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

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

test('agent grant executes a real MCP tool and revocation removes it from desktop chat', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const userDataPath = testInfo.outputPath('mcp-tool-loop-user-data')
  const projectRoot = testInfo.outputPath('mcp-tool-loop-project')
  const lifecyclePath = testInfo.outputPath('mcp-tool-loop-lifecycle.jsonl')
  const callsPath = testInfo.outputPath('mcp-tool-loop-calls.jsonl')
  const providerSecret = `desktop-provider-secret-${Date.now()}`
  await createAgent(projectRoot)
  await fs.mkdir(userDataPath, { recursive: true })

  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  const app = await electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: '1',
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${providerFixture.url}/v1`,
    },
  })
  const page = await app.firstWindow()

  try {
    await configureProvider(page, providerFixture.url, providerSecret)
    await configureMcp(page, lifecyclePath, callsPath)
    await expect.poll(() => eventCount(lifecyclePath, 'ready')).toBe(1)

    await openAgentMcpGrants(page)
    const grant = page.getByRole('switch', {
      name: 'Grant Fixture MCP to tool-agent',
    })
    await expect(grant).not.toBeChecked()
    await grant.click()
    await expect(grant).toBeChecked()

    await sendAgentChat(page)
    await expect(
      page.getByText(
        'provider-consumed:echo-marker:provider-loop-marker',
        { exact: true },
      ),
    ).toBeVisible()
    await expect.poll(() => jsonLineCount(callsPath)).toBe(1)

    await openMcpSettings(page)
    await page.getByLabel('Enable Fixture MCP').click()
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => eventCount(lifecyclePath, 'stopped')).toBe(1)

    await openAgentMcpGrants(page)
    await expect(
      page.getByText('No globally enabled MCP connections are available.'),
    ).toBeVisible()
    await sendAgentChat(page)
    await expect(
      page.getByText('provider-no-tools', { exact: true }),
    ).toBeVisible()
    await expect.poll(() => jsonLineCount(callsPath)).toBe(1)

    await openMcpSettings(page)
    await page.getByLabel('Enable Fixture MCP').click()
    await expect(page.getByText('Connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => eventCount(lifecyclePath, 'ready')).toBe(2)

    await openAgentMcpGrants(page)
    const restoredGrant = page.getByRole('switch', {
      name: 'Grant Fixture MCP to tool-agent',
    })
    await expect(restoredGrant).toBeChecked()
    await sendAgentChat(page)
    await expect.poll(() => jsonLineCount(callsPath)).toBe(2)

    await openAgentMcpGrants(page)
    const revocableGrant = page.getByRole('switch', {
      name: 'Grant Fixture MCP to tool-agent',
    })
    await revocableGrant.click()
    await expect(revocableGrant).not.toBeChecked()
    await sendAgentChat(page)
    await expect.poll(() => jsonLineCount(callsPath)).toBe(2)

    const providerSettings = await fs.readFile(
      path.join(userDataPath, 'provider-settings.json'),
      'utf8',
    )
    const mcpSettings = await fs.readFile(
      path.join(userDataPath, 'mcp-settings.json'),
      'utf8',
    )
    expect(providerSettings).not.toContain(providerSecret)
    expect(mcpSettings).not.toContain(lifecyclePath)
    expect(mcpSettings).not.toContain(callsPath)
  } finally {
    await app.close()
    await providerFixture.close()
  }

  await expect.poll(() => eventCount(lifecyclePath, 'stopped')).toBe(2)
  const lifecycle = await readJsonLines(lifecyclePath) as Array<{ pid: number }>
  for (const pid of new Set(lifecycle.map((event) => event.pid))) {
    await expect.poll(() => isProcessAlive(pid)).toBe(false)
  }
  await expect.poll(() => isProcessAlive(providerFixture.pid)).toBe(false)
})

async function configureProvider(
  page: Page,
  providerUrl: string,
  providerSecret: string,
): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
  await page.getByRole('button', { name: 'Add' }).click()
  await page.getByLabel('Connection type').selectOption('openai-compatible')
  await page.getByLabel('Name').fill('Fixture Provider')
  await page.getByLabel('Base URL').fill(`${providerUrl}/v1`)
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill(providerSecret)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await page.getByRole('button', { name: /^Fixture Provider/ }).click()
  await page.getByRole('switch', { name: 'Enable fixture/tool-loop' }).click()
}

async function configureMcp(
  page: Page,
  lifecyclePath: string,
  callsPath: string,
): Promise<void> {
  await page.getByRole('button', { name: 'MCPs' }).click()
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Name').fill('Fixture MCP')
  await page.getByLabel('MCP transport').selectOption('stdio')
  await page
    .getByRole('textbox', { name: 'Command', exact: true })
    .fill(process.execPath)
  await page.getByLabel('Arguments, one per line').fill(stdioFixturePath)
  await page.getByLabel(
    'I trust this command and understand validation will run it locally on this computer.',
  ).check()
  await addSecretRow(page, 1, 'MCP_FIXTURE_LIFECYCLE_PATH', lifecyclePath)
  await addSecretRow(page, 2, 'MCP_FIXTURE_CALLS_PATH', callsPath)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function openMcpSettings(page: Page): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'MCPs' }).click()
  await expect(page.getByRole('heading', { name: 'MCPs' })).toBeVisible()
}

async function openAgentMcpGrants(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create' }).click()
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: /^Tool Agent\b/ }).click()
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByRole('tab', { name: 'MCPs' }).click()
}

async function sendAgentChat(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  const showInspector = page.getByRole('button', { name: 'Show inspector' })
  if (await showInspector.isVisible()) await showInspector.click()
  const toolAgent = page.getByRole('button', { name: /^Tool Agent/i })
  if ((await toolAgent.getAttribute('aria-pressed')) !== 'true') {
    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    await search.fill('tool-agent')
    await toolAgent.click()
  }
  const input = page.getByPlaceholder('Send a message to the selected agents...')
  await expect(input).toBeEnabled()
  await input.fill('Use the available marker tool and return its result.')
  const sendButton = page.getByRole('button', { name: 'Send message' })
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(sendButton).toBeEnabled()
}

async function addSecretRow(
  page: Page,
  index: number,
  key: string,
  value: string,
): Promise<void> {
  await page.getByRole('button', { name: 'Add secret' }).click()
  await page.getByLabel(`Secret environment variables key ${index}`).fill(key)
  await page.getByLabel(`Secret environment variables value ${index}`).fill(value)
}

async function createAgent(projectRoot: string): Promise<void> {
  const directory = path.join(projectRoot, 'agents', 'tool-agent')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'tool-agent.md'),
    [
      '---',
      'name: tool-agent',
      'description: Desktop MCP tool-loop agent.',
      'tier: strategic',
      'provider: openai',
      'model: fixture/tool-loop',
      'thinking: low',
      '---',
      '',
      '# Tool Agent',
      '',
      'Use available tools to ground every answer.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function readJsonLines(filePath: string): Promise<unknown[]> {
  try {
    return (await fs.readFile(filePath, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function eventCount(filePath: string, event: string): Promise<number> {
  const entries = await readJsonLines(filePath) as Array<{ event?: string }>
  return entries.filter((entry) => entry.event === event).length
}

async function jsonLineCount(filePath: string): Promise<number> {
  return (await readJsonLines(filePath)).length
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
