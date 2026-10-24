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
const interactiveFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'interactive-stdio-server.mjs',
)

test('desktop gates real MCP approval and elicitation while persisting only redacted audit data', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const providerFixture = await startOpenAiToolLoopFixture(
    repoRoot,
    'mcp-interaction-server.mjs',
  )
  const userDataPath = testInfo.outputPath('mcp-interactions-user-data')
  const workspacePath = testInfo.outputPath('mcp-interactions-workspace')
  const projectRoot = testInfo.outputPath('mcp-interactions-project')
  const lifecyclePath = testInfo.outputPath('mcp-interactions-lifecycle.jsonl')
  const callsPath = testInfo.outputPath('mcp-interactions-calls.jsonl')
  const providerSecret = `interaction-provider-secret-${Date.now()}`
  const ephemeralFormValue = `public-data-topic-${Date.now()}`
  const observedMcpPids = new Set<number>()
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    createAgents(projectRoot),
  ])

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
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${providerFixture.url}/v1`,
    },
  })
  const page = await app.firstWindow()

  try {
    const apiBaseUrl = await desktopApiBaseUrl(page)

    await configureProvider(page, providerFixture.url, providerSecret)
    await configureMcp(page, lifecyclePath, callsPath)
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(1)
    for (const event of await readLifecycle(lifecyclePath)) {
      observedMcpPids.add(event.pid)
    }

    await grantMcpToAgent(page, 'approval-agent')
    await grantMcpToAgent(page, 'form-agent')

    await openAgentChat(page)
    await selectAgent(page, 'approval-agent', 'Approval Agent')
    await submitChat(page, 'Use the available write tool after asking me for permission.')
    // The conversation exists from the first turn, not from launch: the desktop
    // opens on a draft that is only persisted once it is used.
    const session = await firstSession(apiBaseUrl)

    const pendingRegion = page.getByRole('region', { name: 'Pending MCP requests' })
    await expect(pendingRegion.getByText('Approval required', { exact: true })).toBeVisible()
    await expect(pendingRegion).toContainText('mcp__')
    await expect(pendingRegion).toContainText('approval-write')
    await expect(pendingRegion.getByText('marker', { exact: true })).toBeVisible()
    await expect(pendingRegion).not.toContainText('approval-write-marker')
    await expect.poll(() => jsonLineCount(callsPath)).toBe(0)

    const approval = await pendingInteraction(
      apiBaseUrl,
      session.id,
      (interaction) => interaction.kind === 'approval',
    )
    expect(approval.argumentNames).toEqual(['marker'])
    expect(approval).not.toHaveProperty('arguments')
    expect(approval).not.toHaveProperty('argumentsHash')

    await pendingRegion.getByRole('button', { name: 'Allow once' }).click()
    await expect(page.getByText(
      'provider-consumed:approval-write:approval-write-marker',
      { exact: true },
    )).toBeVisible()
    await expect.poll(() => jsonLineCount(callsPath)).toBe(1)

    const approvalAudit = await readAssignmentAudit(workspacePath, session.id, approval)
    expect(approvalAudit.map((event) => event.type)).toEqual([
      'mcp.tool.requested',
      'mcp.approval.requested',
      'mcp.approval.resolved',
      'mcp.tool.started',
      'mcp.tool.completed',
    ])
    expect(approvalAudit[0]?.argumentNames).toEqual(['marker'])
    expect(JSON.stringify(approvalAudit)).not.toContain('approval-write-marker')
    expect(JSON.stringify(approvalAudit)).not.toMatch(/"arguments"\s*:/)

    await selectAgent(page, 'approval-agent', 'Approval Agent')
    await selectAgent(page, 'form-agent', 'Form Agent')
    await submitChat(page, 'Use the public-data form tool and continue with my choices.')

    await expect(pendingRegion.getByText('Information requested', { exact: true })).toBeVisible()
    await expect(pendingRegion.getByText(
      'Choose the public-data result format for this request.',
      { exact: true },
    )).toBeVisible()
    await expect(pendingRegion.locator('input[type="password"]')).toHaveCount(0)
    await expect.poll(() => jsonLineCount(callsPath)).toBe(1)

    const form = await pendingInteraction(
      apiBaseUrl,
      session.id,
      (interaction) => interaction.kind === 'elicitation' && interaction.mode === 'form',
    )
    expect(form).not.toHaveProperty('parentRequestId')
    expect(form.schema?.additionalProperties).toBe(false)

    await pendingRegion.getByLabel('Topic *').fill(ephemeralFormValue)
    await pendingRegion.getByLabel('Result count *').fill('5')
    await pendingRegion.getByLabel('Category').selectOption('technical')
    await pendingRegion.getByLabel('table').check()
    await pendingRegion.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByText(
      'provider-consumed:elicit-form:accept:elicit-form-marker',
      { exact: true },
    )).toBeVisible()
    await expect.poll(() => jsonLineCount(callsPath)).toBe(2)

    const formAudit = await readAssignmentAudit(workspacePath, session.id, form)
    expect(formAudit.map((event) => event.type)).toEqual([
      'mcp.tool.requested',
      'mcp.tool.started',
      'mcp.elicitation.requested',
      'mcp.elicitation.resolved',
      'mcp.tool.completed',
    ])
    expect(formAudit[2]).toMatchObject({ elicitationMode: 'form' })
    expect(formAudit[3]).toMatchObject({
      elicitationMode: 'form',
      elicitationStatus: 'accepted',
      elicitationAction: 'accept',
    })
    expect(JSON.stringify(formAudit)).not.toContain(ephemeralFormValue)
    expect(JSON.stringify(await readJsonLines(callsPath))).not.toContain(ephemeralFormValue)
    expect(await treeContains(workspacePath, ephemeralFormValue)).toBe(false)

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

  await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(1)
  for (const event of await readLifecycle(lifecyclePath)) {
    observedMcpPids.add(event.pid)
  }
  for (const pid of observedMcpPids) {
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
  await page.getByLabel('Name').fill('Interaction Provider')
  await page.getByLabel('Base URL').fill(`${providerUrl}/v1`)
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill(providerSecret)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await page.getByRole('button', { name: /^Interaction Provider/ }).click()
  await page.getByRole('switch', { name: 'Enable fixture/approval' }).click()
  await page.getByRole('switch', { name: 'Enable fixture/elicitation-form' }).click()
}

async function configureMcp(
  page: Page,
  lifecyclePath: string,
  callsPath: string,
): Promise<void> {
  await page.getByRole('button', { name: 'MCPs' }).click()
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Name').fill('Interaction MCP')
  await page.getByLabel('MCP transport').selectOption('stdio')
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(process.execPath)
  await page.getByLabel('Arguments, one per line').fill(interactiveFixturePath)
  await page.getByLabel(
    'I trust this command and understand validation will run it locally on this computer.',
  ).check()
  await addSecretRow(page, 1, 'MCP_FIXTURE_LIFECYCLE_PATH', lifecyclePath)
  await addSecretRow(page, 2, 'MCP_FIXTURE_CALLS_PATH', callsPath)
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function grantMcpToAgent(page: Page, agentName: string): Promise<void> {
  await page.getByRole('tab', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', {
    name: agentName === 'approval-agent' ? /^Approval Agent\b/ : /^Form Agent\b/,
  }).click()
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByRole('tab', { name: 'MCPs' }).click()
  const grant = page.getByRole('switch', {
    name: `Grant Interaction MCP to ${agentName}`,
  })
  await expect(grant).not.toBeChecked()
  await grant.click()
  await expect(grant).toBeChecked()
}

async function openAgentChat(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click()
  await expect(page.getByRole('button', { name: 'Search Agents' })).toBeVisible()
}

async function selectAgent(
  page: Page,
  agentName: string,
  agentLabel: string,
): Promise<void> {
  const showInspector = page.getByRole('button', { name: 'Show inspector' })
  if (await showInspector.isVisible()) await showInspector.click()
  await page.getByRole('button', { name: 'Search Agents' }).click()
  const search = page.getByRole('searchbox', { name: 'Search Agents' })
  await search.fill(agentName)
  await page.getByRole('button', { name: new RegExp(`^${agentLabel}`, 'i') }).click()
  // The search stays open after a pick and covers its own trigger.
  await search.press('Escape')
  await expect(page.getByRole('button', { name: 'Search Agents' })).toHaveAttribute('aria-expanded', 'false')
}

async function submitChat(page: Page, message: string): Promise<void> {
  const input = page.getByPlaceholder('Send a message to the selected agents...')
  await expect(input).toBeEnabled()
  await input.fill(message)
  const sendButton = page.getByRole('button', { name: 'Send message' })
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
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

async function firstSession(apiBaseUrl: string): Promise<SessionSummary> {
  let sessions: SessionSummary[] = []
  await expect.poll(async () => {
    sessions = (await apiGet<{ sessions: SessionSummary[] }>(
      `${apiBaseUrl}/sessions`,
    )).sessions
    return sessions.length
  }, { timeout: 10_000 }).toBeGreaterThan(0)
  return sessions[0]!
}

async function pendingInteraction(
  apiBaseUrl: string,
  sessionId: string,
  predicate: (interaction: McpInteractionView) => boolean,
): Promise<McpInteractionView> {
  let match: McpInteractionView | undefined
  await expect.poll(async () => {
    const payload = await apiGet<{ interactions: McpInteractionView[] }>(
      `${apiBaseUrl}/sessions/${sessionId}/mcp-interactions`,
    )
    match = payload.interactions.find(predicate)
    return Boolean(match)
  }, { timeout: 10_000 }).toBe(true)
  return match!
}

async function readAssignmentAudit(
  workspacePath: string,
  sessionId: string,
  interaction: McpInteractionView,
): Promise<Array<Record<string, unknown>>> {
  const auditPath = path.join(
    workspacePath,
    'sessions',
    sessionId,
    'runs',
    interaction.runId,
    'assignments',
    interaction.assignmentId,
    'mcp',
    'audit',
    'events.jsonl',
  )
  let events: Array<Record<string, unknown>> = []
  await expect.poll(async () => {
    events = await readJsonLines(auditPath) as Array<Record<string, unknown>>
    return events.at(-1)?.type
  }).toBe('mcp.tool.completed')
  return events
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload as T
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    ),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function createAgents(projectRoot: string): Promise<void> {
  await Promise.all([
    createAgent(projectRoot, 'approval-agent', 'fixture/approval'),
    createAgent(projectRoot, 'form-agent', 'fixture/elicitation-form'),
  ])
}

async function createAgent(
  projectRoot: string,
  name: string,
  model: string,
): Promise<void> {
  const directory = path.join(projectRoot, 'agents', name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: Real MCP interaction fixture for ${name}.`,
      'tier: strategic',
      'provider: openai',
      `model: ${model}`,
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Use the available MCP tool exactly once and return its result.',
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

async function readLifecycle(filePath: string): Promise<LifecycleEvent[]> {
  return await readJsonLines(filePath) as LifecycleEvent[]
}

async function lifecycleCount(
  filePath: string,
  event: LifecycleEvent['event'],
): Promise<number> {
  return (await readLifecycle(filePath)).filter((entry) => entry.event === event).length
}

async function jsonLineCount(filePath: string): Promise<number> {
  return (await readJsonLines(filePath)).length
}

async function treeContains(root: string, needle: string): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (await treeContains(target, needle)) return true
      continue
    }
    if (!entry.isFile()) continue
    const contents = await fs.readFile(target)
    if (contents.includes(Buffer.from(needle, 'utf8'))) return true
  }
  return false
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface SessionSummary {
  id: string
}

interface McpInteractionView {
  kind: 'approval' | 'elicitation'
  mode?: 'form' | 'url'
  runId: string
  assignmentId: string
  argumentNames?: string[]
  schema?: { additionalProperties?: boolean }
  [key: string]: unknown
}

interface LifecycleEvent {
  event: 'ready' | 'stopped'
  pid: number
}
