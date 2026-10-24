import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const projectFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp-workflow-worker',
)
const stdioFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

test('detached workflow worker uses the rehydrated parent MCP broker across desktop restarts', async ({}, testInfo) => {
  test.setTimeout(150_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const userDataPath = testInfo.outputPath('mcp-worker-user-data')
  const workspacePath = testInfo.outputPath('mcp-worker-workspace')
  const projectRoot = testInfo.outputPath('mcp-worker-project')
  const piStatePath = testInfo.outputPath('mcp-worker-pi-state')
  const lifecyclePath = testInfo.outputPath('mcp-worker-lifecycle.jsonl')
  const callsPath = testInfo.outputPath('mcp-worker-calls.jsonl')
  const serverSecret = `mcp-worker-server-secret-${Date.now()}`
  const workerPids = new Set<number>()
  const mcpPids = new Set<number>()
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(projectFixturePath, projectRoot, { recursive: true }),
  ])

  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  const desktopEnvironment: Record<string, string> = {
    ...fixtureDesktopEnvironment(),
    PIPELINE_DESKTOP_E2E: '1',
    ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
    PIPELINE_DESKTOP_USER_DATA: userDataPath,
    PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
    PI_CODING_AGENT_DIR: piStatePath,
    OPENAI_API_KEY: 'mcp-worker-provider-key',
    OPENAI_BASE_URL: `${providerFixture.url}/v1`,
    TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS: '4000',
  }
  delete desktopEnvironment.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN

  let app: ElectronApplication | null = null
  try {
    app = await launchDesktop(executablePath, desktopEnvironment)
    let page = await app.firstWindow()
    await configureMcp(page, lifecyclePath, callsPath, serverSecret)
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(1)
    collectMcpPids(mcpPids, await readLifecycle(lifecyclePath))
    await grantWorkerMcp(page)

    const firstApiBaseUrl = await desktopApiBaseUrl(page)
    const firstAcceptedTask = await launchWorkflow(
      firstApiBaseUrl,
      'MCP worker first launch',
    )
    const firstTask = await waitForStartedTask(
      firstApiBaseUrl,
      firstAcceptedTask,
      workerPids,
    )
    await assertWorkerEnvironment(firstTask, {
      lifecyclePath,
      callsPath,
      serverSecret,
    })
    const completedFirst = await waitForTask(firstApiBaseUrl, firstTask, workerPids)
    expect(completedFirst.status).toBe('done')
    await expect.poll(() => jsonLineCount(callsPath)).toBe(1)
    await assertWorkflowRun(completedFirst, {
      lifecyclePath,
      callsPath,
      serverSecret,
    })
    await expect.poll(() => isProcessAlive(firstTask.pid)).toBe(false)

    await app.close()
    app = null
    await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(1)
    collectMcpPids(mcpPids, await readLifecycle(lifecyclePath))
    for (const pid of mcpPids) {
      await expect.poll(() => isProcessAlive(pid)).toBe(false)
    }

    app = await launchDesktop(executablePath, desktopEnvironment)
    page = await app.firstWindow()
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(2)
    collectMcpPids(mcpPids, await readLifecycle(lifecyclePath))
    await assertRehydratedConfiguration(page)

    const secondApiBaseUrl = await desktopApiBaseUrl(page)
    const secondAcceptedTask = await launchWorkflow(
      secondApiBaseUrl,
      'MCP worker restart launch',
    )
    const secondTask = await waitForStartedTask(
      secondApiBaseUrl,
      secondAcceptedTask,
      workerPids,
    )
    await assertWorkerEnvironment(secondTask, {
      lifecyclePath,
      callsPath,
      serverSecret,
    })
    const completedSecond = await waitForTask(secondApiBaseUrl, secondTask, workerPids)
    expect(completedSecond.status).toBe('done')
    await expect.poll(() => jsonLineCount(callsPath)).toBe(2)
    await assertWorkflowRun(completedSecond, {
      lifecyclePath,
      callsPath,
      serverSecret,
    })
    await expect.poll(() => isProcessAlive(secondTask.pid)).toBe(false)

    const revokedAcceptedTask = await launchWorkflow(
      secondApiBaseUrl,
      'MCP worker revoked after launch',
    )
    const revokedTask = await waitForStartedTask(
      secondApiBaseUrl,
      revokedAcceptedTask,
      workerPids,
    )
    const grant = page.getByRole('switch', {
      name: 'Grant Workflow Worker MCP to mcp-worker-agent',
    })
    await expect(grant).toBeChecked()
    await grant.click()
    await expect(grant).not.toBeChecked()
    const revokedResult = await waitForTerminalTask(
      secondApiBaseUrl,
      revokedTask,
      workerPids,
    )
    expect(['failed', 'blocked']).toContain(revokedResult.status)
    await expect.poll(() => jsonLineCount(callsPath)).toBe(2)
    await expect.poll(() => isProcessAlive(revokedTask.pid)).toBe(false)

    const calls = await readJsonLines(callsPath) as McpCall[]
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => ({ tool: call.tool, marker: call.marker }))).toEqual([
      { tool: 'echo-marker', marker: 'provider-loop-marker' },
      { tool: 'echo-marker', marker: 'provider-loop-marker' },
    ])
  } finally {
    await app?.close().catch(() => undefined)
    await providerFixture.close()
  }

  await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(2)
  const lifecycle = await readLifecycle(lifecyclePath)
  collectMcpPids(mcpPids, lifecycle)
  expect(
    lifecycle
      .filter((event) => event.event === 'ready')
      .every((event) => event.secretPresent === true),
  ).toBe(true)
  for (const pid of [...workerPids, ...mcpPids]) {
    await expect.poll(() => isProcessAlive(pid)).toBe(false)
  }
  await expect.poll(() => isProcessAlive(providerFixture.pid)).toBe(false)
})

async function launchDesktop(
  executablePath: string | null,
  environment: Record<string, string>,
): Promise<ElectronApplication> {
  return electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: environment,
  })
}

async function configureMcp(
  page: Page,
  lifecyclePath: string,
  callsPath: string,
  serverSecret: string,
): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'MCPs' }).click()
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Name').fill('Workflow Worker MCP')
  await page.getByLabel('MCP transport').selectOption('stdio')
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(process.execPath)
  await page.getByLabel('Arguments, one per line').fill(stdioFixturePath)
  await page.getByLabel(
    'I trust this command and understand validation will run it locally on this computer.',
  ).check()
  await addSecretRow(page, 1, 'MCP_FIXTURE_LIFECYCLE_PATH', lifecyclePath)
  await addSecretRow(page, 2, 'MCP_FIXTURE_CALLS_PATH', callsPath)
  await addSecretRow(page, 3, 'MCP_FIXTURE_TEST_SECRET', serverSecret)
  await page.getByRole('button', { name: 'Add capability' }).click()
  await page.getByLabel('Workflow capability 1', { exact: true }).fill('marker.echo')
  await page.getByLabel('Workflow capability access 1').selectOption('read')
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function grantWorkerMcp(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: /^Mcp Worker Agent\b/ }).click()
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByRole('tab', { name: 'MCPs' }).click()
  const grant = page.getByRole('switch', {
    name: 'Grant Workflow Worker MCP to mcp-worker-agent',
  })
  await expect(grant).not.toBeChecked()
  await grant.click()
  await expect(grant).toBeChecked()
}

async function assertRehydratedConfiguration(page: Page): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'MCPs' }).click()
  const row = page.locator('[data-mcp-server]').filter({
    hasText: 'Workflow Worker MCP',
  })
  await expect(row.getByText('Connected', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Enable Workflow Worker MCP')).toBeChecked()
  await page.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('tab', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: /^Mcp Worker Agent\b/ }).click()
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByRole('tab', { name: 'MCPs' }).click()
  await expect(page.getByRole('switch', {
    name: 'Grant Workflow Worker MCP to mcp-worker-agent',
  })).toBeChecked({ timeout: 15_000 })
}

async function launchWorkflow(
  apiBaseUrl: string,
  title: string,
): Promise<SessionTask> {
  const sessionResponse = await fetch(`${apiBaseUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const sessionBody = await sessionResponse.json()
  expect(sessionResponse.status, JSON.stringify(sessionBody)).toBe(201)
  const session = sessionBody as { id: string }

  const taskResponse = await fetch(
    `${apiBaseUrl}/sessions/${session.id}/tasks`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: 'mcp-worker',
        brief: 'Use the marker MCP tool once and preserve its exact result.',
      }),
    },
  )
  const taskBody = await taskResponse.json()
  expect(taskResponse.status, JSON.stringify(taskBody)).toBe(202)
  expect((taskBody as SessionTask).status).toBe('queued')
  expect(JSON.stringify(taskBody)).not.toMatch(
    /PIPELINE_MCP_WORKER_TURN_URL|\/_pipeline-worker\//,
  )
  return taskBody as SessionTask
}

async function waitForStartedTask(
  apiBaseUrl: string,
  task: SessionTask,
  trackedPids: Set<number>,
): Promise<StartedSessionTask> {
  let current = task
  await expect.poll(async () => {
    const response = await fetch(
      `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
    )
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(`Task poll failed: ${response.status} ${JSON.stringify(payload)}`)
    }
    current = payload as SessionTask
    if (typeof current.pid !== 'number') return false
    trackedPids.add(current.pid)
    for (const pid of await descendantPids(current.pid)) trackedPids.add(pid)
    return isProcessAlive(current.pid)
  }, {
    message: `Timed out waiting for queued task ${task.id} to start a real worker`,
    timeout: 20_000,
    intervals: [50, 100, 250],
  }).toBe(true)
  expect(['queued', 'running']).toContain(current.status)
  return current as StartedSessionTask
}

async function waitForTask(
  apiBaseUrl: string,
  task: StartedSessionTask,
  trackedPids: Set<number>,
): Promise<SessionTask> {
  let current: SessionTask = task
  await expect.poll(async () => {
    for (const pid of await descendantPids(task.pid)) trackedPids.add(pid)
    const response = await fetch(
      `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
    )
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(`Task poll failed: ${response.status} ${JSON.stringify(payload)}`)
    }
    current = payload as SessionTask
    return current.status
  }, { timeout: 60_000, intervals: [100, 250, 500] }).toBe('done')
  return current
}

async function waitForTerminalTask(
  apiBaseUrl: string,
  task: StartedSessionTask,
  trackedPids: Set<number>,
): Promise<SessionTask> {
  let current: SessionTask = task
  await expect.poll(async () => {
    for (const pid of await descendantPids(task.pid)) trackedPids.add(pid)
    const response = await fetch(
      `${apiBaseUrl}/sessions/${task.sessionId}/tasks/${task.id}`,
    )
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(`Task poll failed: ${response.status} ${JSON.stringify(payload)}`)
    }
    current = payload as SessionTask
    return current.status
  }, { timeout: 60_000, intervals: [100, 250, 500] }).toMatch(
    /^(done|failed|blocked|cancelled)$/,
  )
  return current
}

async function assertWorkerEnvironment(
  task: StartedSessionTask,
  secrets: ServerSecrets,
): Promise<void> {
  expect(task.pid).toEqual(expect.any(Number))
  const { stdout } = await execFileAsync('ps', ['eww', '-p', String(task.pid)])
  expect(stdout).toContain(`TEAM_RUNTIME_TASK_ID=${task.id}`)
  expect(stdout).toContain('PIPELINE_MCP_WORKER_TURN_URL=http://127.0.0.1:')
  for (const forbidden of serverSecretValues(secrets)) {
    expect(stdout).not.toContain(forbidden)
  }
}

async function descendantPids(rootPid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='])
  const childrenByParent = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const parent = Number(parentText)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), pid])
  }
  const descendants: number[] = []
  const pending = [...(childrenByParent.get(rootPid) ?? [])]
  while (pending.length > 0) {
    const pid = pending.shift()!
    descendants.push(pid)
    pending.push(...(childrenByParent.get(pid) ?? []))
  }
  return descendants
}

async function assertWorkflowRun(
  task: SessionTask,
  secrets: ServerSecrets,
): Promise<void> {
  expect(task.runPath).toEqual(expect.any(String))
  expect(task.assignmentPath).toEqual(expect.any(String))
  const wrapperPath = path.join(
    task.assignmentPath,
    'workflow-mcp-worker-result.md',
  )
  await expect.poll(
    async () => fs.readFile(wrapperPath, 'utf8').catch(() => ''),
    { timeout: 10_000, intervals: [50, 100, 250] },
  ).toContain('- Status: completed')
  expect(JSON.stringify(task)).not.toMatch(
    /PIPELINE_MCP_WORKER_TURN_URL|\/_pipeline-worker\//,
  )
  const taskRecord = await fs.readFile(
    path.join(
      path.dirname(path.dirname(task.runPath)),
      'tasks',
      task.id,
      'task.json',
    ),
    'utf8',
  )
  expect(taskRecord).not.toMatch(
    /PIPELINE_MCP_WORKER_TURN_URL|\/_pipeline-worker\//,
  )
  expect(await treeContains(task.runPath, 'PIPELINE_MCP_WORKER_TURN_URL')).toBe(false)
  expect(await treeContains(task.runPath, '/_pipeline-worker/')).toBe(false)

  const auditPaths = await findNamedFiles(task.runPath, 'events.jsonl', (filePath) =>
    filePath.endsWith(path.join('mcp', 'audit', 'events.jsonl')))
  expect(auditPaths).toHaveLength(1)
  const auditPath = auditPaths[0]!
  const childAssignmentPath = path.dirname(path.dirname(path.dirname(auditPath)))
  expect(path.dirname(childAssignmentPath)).toBe(path.join(task.runPath, 'assignments'))
  expect(childAssignmentPath).not.toBe(task.assignmentPath)

  const audit = await readJsonLines(auditPath) as Array<Record<string, unknown>>
  expect(audit.map((event) => event.type)).toEqual([
    'mcp.tool.requested',
    'mcp.tool.started',
    'mcp.tool.completed',
  ])
  for (const event of audit) {
    expect(event).toMatchObject({
      workflowId: 'mcp-worker',
      workflowStepId: 'collect-marker',
      agentPath: 'agents/mcp-worker-agent',
      toolCallId: 'call-marker',
    })
  }

  const evidenceManifests = await findNamedFiles(
    path.join(childAssignmentPath, 'evidence', 'mcp', 'tool-results'),
    'manifest.json',
  )
  expect(evidenceManifests).toHaveLength(1)
  const evidencePath = evidenceManifests[0]!
  const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')) as {
    workflowId?: string
    workflowStepId?: string
    agentPath?: string
    contents: Array<{ storedPath: string }>
  }
  expect(evidence).toMatchObject({
    workflowId: 'mcp-worker',
    workflowStepId: 'collect-marker',
    agentPath: 'agents/mcp-worker-agent',
  })
  expect(evidence.contents).toHaveLength(1)
  const sealedContentPath = path.join(
    path.dirname(evidencePath),
    ...evidence.contents[0]!.storedPath.split('/'),
  )
  expect(await fs.readFile(sealedContentPath, 'utf8')).toBe(
    'echo-marker:provider-loop-marker',
  )
  if (process.platform !== 'win32') {
    expect((await fs.stat(evidencePath)).mode & 0o222).toBe(0)
    expect((await fs.stat(sealedContentPath)).mode & 0o222).toBe(0)
  }

  const finalArtifact = await fs.readFile(
    path.join(childAssignmentPath, 'final.md'),
    'utf8',
  )
  expect(finalArtifact).toContain(
    'provider-consumed:echo-marker:provider-loop-marker',
  )
  for (const forbidden of serverSecretValues(secrets)) {
    expect(await treeContains(task.runPath, forbidden)).toBe(false)
  }
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

async function desktopApiBaseUrl(page: Page): Promise<string> {
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      'pipeline-api-base-url',
    ),
  )
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function findNamedFiles(
  root: string,
  filename: string,
  predicate: (filePath: string) => boolean = () => true,
): Promise<string[]> {
  const matches: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && entry.name === filename && predicate(target)) {
        matches.push(target)
      }
    }
  }
  await visit(root)
  return matches.sort()
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
    if ((await fs.readFile(target)).includes(Buffer.from(needle, 'utf8'))) {
      return true
    }
  }
  return false
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

function collectMcpPids(target: Set<number>, events: LifecycleEvent[]): void {
  for (const event of events) target.add(event.pid)
}

function serverSecretValues(secrets: ServerSecrets): string[] {
  return [
    secrets.serverSecret,
    secrets.lifecyclePath,
    secrets.callsPath,
    'MCP_FIXTURE_TEST_SECRET',
    'MCP_FIXTURE_LIFECYCLE_PATH',
    'MCP_FIXTURE_CALLS_PATH',
  ]
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface ServerSecrets {
  lifecyclePath: string
  callsPath: string
  serverSecret: string
}

interface SessionTask {
  id: string
  sessionId: string
  runId: string
  assignmentId: string
  pid?: number
  status: string
  runPath: string
  assignmentPath: string
}

interface StartedSessionTask extends SessionTask {
  pid: number
}

interface LifecycleEvent {
  event: 'ready' | 'stopped'
  pid: number
  secretPresent?: boolean
}

interface McpCall {
  tool: string
  marker: string
  pid: number
}
