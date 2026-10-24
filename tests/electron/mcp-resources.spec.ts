import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const resourceFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'resource-stdio-server.mjs',
)
const projectFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'packaged-workflow-smoke',
)
const resourceUri = 'mcp-resource-fixture://resources/text'
const resourceMarker = 'mcp-resource-text-marker'
const resourceSha256 = createHash('sha256').update(resourceMarker).digest('hex')

test('imports immutable MCP resource snapshots and preserves them in a dry-run workflow', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const userDataPath = testInfo.outputPath('mcp-resources-user-data')
  const workspacePath = testInfo.outputPath('mcp-resources-workspace')
  const projectRoot = testInfo.outputPath('mcp-resources-project')
  const lifecyclePath = testInfo.outputPath('mcp-resources-lifecycle.jsonl')
  const secret = `mcp-resource-secret-${Date.now()}`
  const observedChildPids = new Set<number>()
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    createProject(projectRoot),
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
      TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: '1',
      // Keep the real detached worker observable while the durable queue
      // hands the accepted task to its process.
      TEAM_RUNTIME_TASK_RUNNER_STARTUP_DELAY_MS: '2000',
    },
  })
  const page = await app.firstWindow()

  try {
    const apiBaseUrl = await desktopApiBaseUrl(page)
    expect(new URL(apiBaseUrl).pathname).toMatch(/^\/_pipeline\/[A-Za-z0-9_-]{43}$/)
    await expect(page.getByRole('button', {
      name: 'Add files or MCP resources',
    })).toBeVisible()

    await configureResourceMcp(page, lifecyclePath, secret)
    await expect.poll(() => lifecycleCount(lifecyclePath, 'ready')).toBe(1)
    for (const event of await readLifecycle(lifecyclePath)) {
      observedChildPids.add(event.pid)
    }

    // Opening the picker is what makes the draft durable: the listing is bound
    // to a session, so the conversation has to exist before it can be browsed.
    await openMcpResourcePicker(page)
    let sessions: SessionSummary[] = []
    await expect.poll(async () => {
      sessions = await apiGet<{ sessions: SessionSummary[] }>(
        `${apiBaseUrl}/sessions`,
      ).then((payload) => payload.sessions)
      return sessions.length
    }, { timeout: 10_000 }).toBe(1)
    const session = sessions[0]!

    const resourceDialog = page.getByRole('dialog', { name: 'Add from MCP' })
    await expect(resourceDialog).toBeVisible()
    await expect(resourceDialog.getByText('Fixture text', { exact: true })).toBeVisible()
    await expect(resourceDialog.getByText(resourceUri, { exact: true })).toBeVisible()
    const importButton = resourceDialog.getByRole('button', {
      name: 'Import Fixture text',
    })

    await importButton.click()
    await expect(resourceDialog.getByRole('status')).toHaveText(
      'Fixture text added as 1 session file.',
    )
    await expect(importButton).toContainText('Import again')

    let files: SessionFile[] = []
    await expect.poll(async () => {
      files = await listSessionFiles(apiBaseUrl, session.id)
      return files.length
    }).toBe(1)
    const originalFile = files[0]!
    assertImportedFile(originalFile)

    await importButton.click()
    await expect(importButton).toContainText('Importing…')
    await expect(importButton).toContainText('Import again')
    await expect.poll(async () => {
      files = await listSessionFiles(apiBaseUrl, session.id)
      return files.length === 2
        ? files.map((file) => file.parseStatus).sort().join(',')
        : `count:${files.length}`
    }).toBe('parsed,parsed')
    expect(new Set(files.map((file) => file.name)).size).toBe(2)
    expect(new Set(files.map((file) => file.source?.snapshotId)).size).toBe(2)
    expect(files.map((file) => file.name)).toContain(originalFile.name)
    for (const file of files) assertImportedFile(file)

    await resourceDialog.getByLabel('Close MCP resource picker').click()
    const runChat = page.getByRole('region', { name: 'Run chat' })
    for (const file of files) {
      const fileCard = runChat
        .getByTestId('file-message-card')
        .filter({ hasText: file.name })
      await expect(fileCard.getByText(file.name, { exact: true })).toBeVisible()
      await expect(fileCard).toContainText('parsed ✓')
      const provenance = fileCard.getByLabel(`MCP provenance for ${file.name}`)
      await expect(provenance).toBeVisible()
      await provenance.click()
      await expect(fileCard.getByText('Fixture text', { exact: true })).toBeVisible()
      await expect(fileCard.getByText(resourceUri, { exact: true })).toBeVisible()
    }

    await disableResourceMcp(page)
    await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(1)
    for (const event of await readLifecycle(lifecyclePath)) {
      observedChildPids.add(event.pid)
      await expect.poll(() => isProcessAlive(event.pid)).toBe(false)
    }
    const disabledCatalog = await apiGet<{ resources: unknown[] }>(
      `${apiBaseUrl}/sessions/${session.id}/mcp-resources`,
    )
    expect(disabledCatalog.resources).toEqual([])

    const launchedResponse = await fetch(
      `${apiBaseUrl}/sessions/${session.id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'packaged-smoke',
          brief: 'Use the frozen MCP resource snapshot as workflow evidence.',
        }),
      },
    )
    const launchedBody = await launchedResponse.json() as SessionTask | ApiError
    expect(launchedResponse.status, JSON.stringify(launchedBody)).toBe(202)
    const launchedTask = launchedBody as SessionTask
    expect(launchedTask.status).toBe('queued')

    let startedTask = launchedTask
    await expect.poll(async () => {
      startedTask = await apiGet<SessionTask>(
        `${apiBaseUrl}/sessions/${session.id}/tasks/${launchedTask.id}`,
      )
      return typeof startedTask.pid === 'number' && isProcessAlive(startedTask.pid)
    }, {
      message: 'Timed out waiting for the durable queue to start the resource workflow',
      timeout: 20_000,
      intervals: [50, 100, 250],
    }).toBe(true)
    expect(['queued', 'running']).toContain(startedTask.status)
    observedChildPids.add(startedTask.pid!)

    let completedTask = startedTask
    await expect.poll(async () => {
      completedTask = await apiGet<SessionTask>(
        `${apiBaseUrl}/sessions/${session.id}/tasks/${launchedTask.id}`,
      )
      return completedTask.status
    }, { timeout: 20_000 }).toBe('done')
    expect(completedTask.workerStartedAt).toEqual(expect.any(String))
    expect(completedTask.inputSnapshotPath).toEqual(expect.any(String))
    expect(completedTask.assignmentPath).toEqual(expect.any(String))
    expect(completedTask.runPath).toEqual(expect.any(String))

    const immutablePayload = await assertFrozenResourceEvidence({
      task: completedTask,
      sessionId: session.id,
      files,
      originalSnapshotId: originalFile.source!.snapshotId,
    })
    for (const forbidden of [
      secret,
      lifecyclePath,
      resourceFixturePath,
      process.execPath,
      'MCP_FIXTURE_LIFECYCLE_PATH',
      'MCP_FIXTURE_TEST_SECRET',
    ]) {
      expect(immutablePayload).not.toContain(forbidden)
    }
    expect(immutablePayload).not.toMatch(
      /"(?:transport|command|args|arguments|environment|secretEnvironment)"\s*:/i,
    )
    expect(immutablePayload).not.toContain('"stdio"')

    const result = await fs.readFile(
      path.join(
        completedTask.assignmentPath!,
        'workflow-packaged-smoke-result.md',
      ),
      'utf8',
    )
    expect(result).toContain('Dry-run task runner completed for packaged-smoke.')
  } finally {
    await app.close()
  }

  await expect.poll(() => lifecycleCount(lifecyclePath, 'stopped')).toBe(1)
  for (const pid of observedChildPids) {
    await expect.poll(() => isProcessAlive(pid)).toBe(false)
  }
})

async function configureResourceMcp(
  page: Page,
  lifecyclePath: string,
  secret: string,
): Promise<void> {
  await openMcpSettings(page)
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Name').fill('Resource MCP')
  await page.getByLabel('MCP transport').selectOption('stdio')
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(process.execPath)
  await page.getByLabel('Arguments, one per line').fill(resourceFixturePath)
  await page.getByLabel(
    'I trust this command and understand validation will run it locally on this computer.',
  ).check()
  await addSecretRow(page, 1, 'MCP_FIXTURE_LIFECYCLE_PATH', lifecyclePath)
  await addSecretRow(page, 2, 'MCP_FIXTURE_TEST_SECRET', secret)
  await page.getByRole('button', { name: 'Save & Validate' }).click()

  const row = page.locator('[data-mcp-server]').filter({ hasText: 'Resource MCP' })
  await expect(row).toBeVisible()
  await expect(row.getByText('Connected', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Enable Resource MCP')).toBeChecked()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function disableResourceMcp(page: Page): Promise<void> {
  await openMcpSettings(page)
  const row = page.locator('[data-mcp-server]').filter({ hasText: 'Resource MCP' })
  const toggle = page.getByLabel('Enable Resource MCP')
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function openMcpSettings(page: Page): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'MCPs' }).click()
  await expect(page.getByRole('heading', { name: 'MCPs' })).toBeVisible()
}

async function openMcpResourcePicker(page: Page): Promise<void> {
  const chat = page.getByRole('region', { name: 'Run chat' })
  await chat.getByRole('button', { name: 'Add files or MCP resources' }).click()
  await page.getByRole('menuitem', { name: 'Add from MCP' }).click()
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

async function assertFrozenResourceEvidence(params: {
  task: SessionTask
  sessionId: string
  files: SessionFile[]
  originalSnapshotId: string
}): Promise<string> {
  const inputSnapshotPath = params.task.inputSnapshotPath!
  const runPath = params.task.runPath!
  const assignmentPath = params.task.assignmentPath!
  const provenancePath = path.join(inputSnapshotPath, 'mcp-provenance.json')
  const provenanceText = await fs.readFile(provenancePath, 'utf8')
  const provenance = JSON.parse(provenanceText) as McpProvenance
  expect(provenance).toMatchObject({
    version: 1,
    sessionId: params.sessionId,
    runId: params.task.runId,
    assignmentId: params.task.assignmentId,
  })
  expect(provenance.snapshots).toHaveLength(2)
  expect(new Set(provenance.snapshots.map((entry) => entry.snapshotId))).toEqual(
    new Set(params.files.map((file) => file.source!.snapshotId)),
  )
  expect(provenance.snapshots.some(
    (entry) => entry.snapshotId === params.originalSnapshotId,
  )).toBe(true)

  const inputManifestText = await fs.readFile(
    path.join(inputSnapshotPath, 'manifest.json'),
    'utf8',
  )
  const inputManifest = JSON.parse(inputManifestText) as InputSnapshotManifest
  expect(inputManifest.mcpProvenance).toEqual({
    path: 'mcp-provenance.json',
    bytes: Buffer.byteLength(provenanceText),
    sha256: sha256(Buffer.from(provenanceText)),
    snapshotCount: 2,
  })

  const runRecordText = await fs.readFile(path.join(runPath, 'run.json'), 'utf8')
  const runRecord = JSON.parse(runRecordText) as RunRecord
  expect(runRecord.paths.mcpProvenance).toBe('input-snapshot/mcp-provenance.json')
  expect(runRecord.paths.mcpResourceEvidence).toEqual(expect.any(String))
  const evidenceRoot = path.join(
    runPath,
    ...runRecord.paths.mcpResourceEvidence!.split('/'),
  )
  expect(evidenceRoot).toBe(
    path.join(assignmentPath, 'evidence', 'mcp', 'resources'),
  )

  const immutableParts = [provenanceText, inputManifestText, runRecordText]
  for (const snapshot of provenance.snapshots) {
    expect(snapshot).toMatchObject({
      sessionId: params.sessionId,
      server: { name: 'Resource MCP' },
      resource: { uri: resourceUri, name: 'Fixture text' },
      totalBytes: Buffer.byteLength(resourceMarker),
    })
    expect(snapshot.contents).toHaveLength(1)
    const content = snapshot.contents[0]!
    expect(content).toMatchObject({
      sourceUri: resourceUri,
      mimeType: 'text/plain',
      kind: 'text',
      byteLength: Buffer.byteLength(resourceMarker),
      sha256: resourceSha256,
    })

    const snapshotRoot = path.join(evidenceRoot, snapshot.snapshotId)
    const evidenceManifestPath = path.join(snapshotRoot, 'manifest.json')
    const evidenceManifestText = await fs.readFile(evidenceManifestPath, 'utf8')
    expect(JSON.parse(evidenceManifestText)).toEqual(snapshot)
    const evidenceContentPath = path.join(
      snapshotRoot,
      ...content.storedPath.split('/'),
    )
    const evidenceContent = await fs.readFile(evidenceContentPath)
    expect(evidenceContent.toString('utf8')).toBe(resourceMarker)
    expect(sha256(evidenceContent)).toBe(resourceSha256)
    expect((await fs.stat(evidenceManifestPath)).mode & 0o222).toBe(0)
    expect((await fs.stat(evidenceContentPath)).mode & 0o222).toBe(0)
    immutableParts.push(evidenceManifestText, evidenceContent.toString('utf8'))
  }
  expect((await fs.stat(provenancePath)).mode & 0o222).toBe(0)
  return immutableParts.join('\n')
}

function assertImportedFile(file: SessionFile): void {
  expect(file).toMatchObject({
    size: Buffer.byteLength(resourceMarker),
    parseStatus: 'parsed',
    source: {
      kind: 'mcp-resource',
      serverId: expect.any(String),
      serverName: 'Resource MCP',
      resourceId: expect.stringMatching(/^mcp_resource_[a-f0-9]{64}$/),
      resourceName: 'Fixture text',
      resourceUri,
      contentId: expect.stringMatching(/^mcp_content_[a-f0-9]{64}$/),
      contentUri: resourceUri,
      mimeType: 'text/plain',
      capturedAt: expect.any(String),
      sha256: resourceSha256,
    },
  })
  expect(file.name).toMatch(/^fixture-text-[a-f0-9]{32}\.txt$/)
  expect(file.source?.snapshotId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
}

async function listSessionFiles(
  apiBaseUrl: string,
  sessionId: string,
): Promise<SessionFile[]> {
  return apiGet<{ files: SessionFile[] }>(
    `${apiBaseUrl}/sessions/${sessionId}/files`,
  ).then((payload) => payload.files)
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

async function createProject(projectRoot: string): Promise<void> {
  await fs.cp(projectFixturePath, projectRoot, { recursive: true })
}

async function readLifecycle(filePath: string): Promise<LifecycleEvent[]> {
  try {
    return (await fs.readFile(filePath, 'utf8'))
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

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

interface SessionSummary {
  id: string
}

interface McpResourceSource {
  kind: 'mcp-resource'
  snapshotId: string
  serverId: string
  serverName: string
  resourceId: string
  resourceName: string
  resourceUri: string
  contentId: string
  contentUri: string
  mimeType: string
  capturedAt: string
  sha256: string
}

interface SessionFile {
  name: string
  size: number
  parseStatus: string
  source?: McpResourceSource
}

interface McpResourceContentManifest {
  id: string
  sourceUri: string
  mimeType: string
  kind: 'text' | 'binary'
  byteLength: number
  sha256: string
  storedPath: string
  materializedInputFilename: string
}

interface McpResourceImportManifest {
  version: 1
  snapshotId: string
  sessionId: string
  capturedAt: string
  server: { id: string; name: string }
  resource: { id: string; uri: string; name: string }
  totalBytes: number
  contents: McpResourceContentManifest[]
}

interface McpProvenance {
  version: 1
  sessionId: string
  runId: string
  assignmentId: string
  capturedAt: string
  snapshots: McpResourceImportManifest[]
}

interface InputSnapshotManifest {
  mcpProvenance: {
    path: string
    bytes: number
    sha256: string
    snapshotCount: number
  }
}

interface RunRecord {
  paths: {
    mcpProvenance: string
    mcpResourceEvidence: string | null
  }
}

interface SessionTask {
  id: string
  runId: string
  assignmentId?: string
  status: string
  pid?: number
  workerStartedAt?: string
  runPath?: string
  assignmentPath?: string
  inputSnapshotPath?: string
}

interface ApiError {
  error?: string
}

interface LifecycleEvent {
  event: 'ready' | 'stopped'
  pid: number
}
