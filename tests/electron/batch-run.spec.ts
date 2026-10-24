import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { BatchExecutionItemPage, BatchView } from '../../contracts/batches.js'
import { replaceRequiredText } from '../support/config-rewrite.js'
import { startDeterministicOpenAiServer } from './support/deterministic-openai-server.js'
import { APP_DEFAULT_MODEL, seedProviderSettings } from './support/model-selection-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('desktop Batch automatically processes two PDF pitch decks with spaced names without MCP resources or manual approval', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const userDataPath = testInfo.outputPath('two-pitch-decks-user-data')
  const workspacePath = testInfo.outputPath('two-pitch-decks-workspace')
  const projectRootPath = testInfo.outputPath('two-pitch-decks-project')
  const piStatePath = testInfo.outputPath('two-pitch-decks-pi-state')
  const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-two-pitch-decks-'))
  await Promise.all([userDataPath, workspacePath, piStatePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await prepareDeterministicPitchDeckProject(projectRootPath)
  await Promise.all([
    fs.copyFile(
      path.join(repoRoot, 'file-parser', 'tests', 'fixtures', 'visual-deck.pdf'),
      path.join(externalPath, 'ExampleCo Pitch Deck.pdf'),
    ),
    fs.copyFile(
      path.join(repoRoot, 'file-parser', 'tests', 'fixtures', 'visual-deck.pdf'),
      path.join(externalPath, 'DemoCo - Pitch Deck.pdf'),
    ),
  ])
  const deterministicOpenAi = await startDeterministicOpenAiServer()
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({
      userDataPath,
      workspacePath,
      projectRootPath,
      piStatePath,
      openAiBaseUrl: deterministicOpenAi.baseUrl,
    })
    await replaceDirectoryDialog(app, externalPath)
    const page = await app.firstWindow()
    const apiBaseUrl = await rendererApiBaseUrl(page)

    await page.getByRole('button', { name: /Schedule & Batches/ }).click()
    await page.getByRole('tab', { name: 'Batches', exact: true }).click()
    await page.getByRole('button', { name: 'New Batch', exact: true }).click()
    await page.getByLabel('Name').fill('Two pitch decks')
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await page.getByRole('textbox', { name: 'Extensions', exact: true }).fill('pdf')
    await page.getByRole('combobox', { name: 'Workflow' }).selectOption('pitch-deck-evaluation')
    await page.getByRole('button', { name: 'Create Batch' }).click()
    await expect(page.getByText('Two pitch decks', { exact: true })).toBeVisible()

    const definition = await findBatch(apiBaseUrl, 'Two pitch decks')
    await page.getByRole('button', { name: 'Run Two pitch decks' }).click()
    const execution = await waitForExecution(apiBaseUrl, definition.id, (candidate) =>
      candidate.status === 'completed',
    )
    const detail = await getExecution(apiBaseUrl, definition.id, execution.id)

    expect(detail.items.map((item) => item.fileName).sort()).toEqual([
      'DemoCo - Pitch Deck.pdf',
      'ExampleCo Pitch Deck.pdf',
    ])
    expect(detail.items.every((item) => item.status === 'done')).toBe(true)
    expect(detail.items.every((item) => Boolean(item.sessionId && item.taskId))).toBe(true)
    expect(detail.items.every((item) => item.failureDetail === undefined)).toBe(true)
    expect(deterministicOpenAi.requestCount()).toBeGreaterThanOrEqual(4)

    for (const item of detail.items) {
      const tasksResponse = await fetch(
        `${apiBaseUrl}/sessions/${encodeURIComponent(item.sessionId!)}/tasks`,
      )
      expect(tasksResponse.status).toBe(200)
      const tasks = await tasksResponse.json() as { tasks: Array<{ id: string; status: string }> }
      expect(tasks.tasks).toEqual([
        expect.objectContaining({ id: item.taskId, status: 'done' }),
      ])
      const plan = JSON.parse(await fs.readFile(
        path.join(workspacePath, 'sessions', item.sessionId!, 'run-plan.json'),
        'utf8',
      )) as { status: string; taskId?: string }
      expect(plan).toEqual(expect.objectContaining({ status: 'completed', taskId: item.taskId }))
    }
    await expect(page.getByText('MCP resource import request is invalid.', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Begin workflow' })).toHaveCount(0)
  } finally {
    await app?.close().catch(() => undefined)
    await deterministicOpenAi.close().catch(() => undefined)
    terminateWorkspacePiProcesses(workspacePath)
    await fs.rm(externalPath, { recursive: true, force: true })
  }
})

test('desktop Batch processes mixed files, persists session provenance, publishes results, and retains rerun history after cleanup', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = testInfo.outputPath('batch-run-user-data')
  const workspacePath = testInfo.outputPath('batch-run-workspace')
  const projectRootPath = testInfo.outputPath('batch-run-project')
  const piStatePath = testInfo.outputPath('batch-run-pi-state')
  const externalPath = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-batch-run-'))
  await Promise.all([userDataPath, workspacePath, piStatePath].map((directory) =>
    fs.mkdir(directory, { recursive: true }),
  ))
  await fs.cp(
    path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
    projectRootPath,
    { recursive: true },
  )
  await Promise.all([
    fs.copyFile(path.join(repoRoot, 'file-parser', 'tests', 'fixtures', 'notes.txt'), path.join(externalPath, 'notes.txt')),
    fs.copyFile(path.join(repoRoot, 'file-parser', 'tests', 'fixtures', 'malformed-trailer.pdf'), path.join(externalPath, 'report.pdf')),
    fs.copyFile(path.join(repoRoot, 'file-parser', 'tests', 'fixtures', 'business-plan.docx'), path.join(externalPath, 'plan.docx')),
  ])
  const deterministicOpenAi = await startDeterministicOpenAiServer()
  let app: ElectronApplication | undefined
  try {
    app = await launchDesktop({
      userDataPath,
      workspacePath,
      projectRootPath,
      piStatePath,
      openAiBaseUrl: deterministicOpenAi.baseUrl,
    })
    await replaceDirectoryDialog(app, externalPath)
    const page = await app.firstWindow()
    await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
    // The app is ready after the loading page hands over to the renderer.
    if (process.platform === 'darwin') {
      const headlessNodePath = await app.evaluate(() => process.env.TEAM_RUNTIME_PI_NODE_PATH)
      expect(headlessNodePath).toMatch(/ Helper\.app\/Contents\/MacOS\/[^/]+ Helper$/)
    }
    const apiBaseUrl = await rendererApiBaseUrl(page)

    await page.getByRole('button', { name: /Schedule & Batches/ }).click()
    await page.getByRole('tab', { name: 'Batches', exact: true }).click()
    await page.getByRole('button', { name: 'New Batch', exact: true }).click()
    await page.getByLabel('Name').fill('Mixed files')
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await page.getByRole('textbox', { name: 'Extensions', exact: true }).fill('txt, pdf, docx')
    await page.getByRole('combobox', { name: 'Workflow' }).selectOption('packaged-smoke')
    await page.getByRole('button', { name: 'Create Batch' }).click()
    await expect(page.getByText('Mixed files', { exact: true })).toBeVisible()

    const definition = await findBatch(apiBaseUrl, 'Mixed files')
    await page.getByRole('button', { name: 'Run Mixed files' }).click()
    const first = await waitForExecution(apiBaseUrl, definition.id, (execution) =>
      execution.status === 'completed' && execution.counts.done === 3,
    )
    const firstDetail = await getExecution(apiBaseUrl, definition.id, first.id)
    expect(firstDetail.items).toHaveLength(3)
    expect(firstDetail.items.every((item) => item.status === 'done')).toBe(true)
    expect(firstDetail.items.every((item) => item.resultArtifacts.length > 0)).toBe(true)
    expect(deterministicOpenAi.requestCount()).toBeGreaterThanOrEqual(6)

    for (const item of firstDetail.items) {
      expect(item.sessionId).toBeTruthy()
      const session = JSON.parse(await fs.readFile(
        path.join(workspacePath, 'sessions', item.sessionId!, 'session.json'),
        'utf8',
      )) as { origin?: unknown }
      expect(session.origin).toEqual({
        kind: 'batch',
        batchId: definition.id,
        executionId: first.id,
        itemId: item.id,
      })
      const artifact = await fetch(
        `${apiBaseUrl}/batches/${definition.id}/executions/${first.id}/items/${item.id}/artifacts/0`,
      )
      expect(artifact.status).toBe(200)
      expect((await artifact.text()).length).toBeGreaterThan(0)
    }

    await expect.poll(async () => page.getByText('3 done', { exact: false }).count(), {
      timeout: 20_000,
    }).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Clear copied results for Mixed files' }).click()
    await page.getByRole('button', { name: 'Clear copied results', exact: true }).click()
    await expect.poll(async () => (await findBatch(apiBaseUrl, 'Mixed files')).latestExecution?.resultsClearedAt, {
      timeout: 20_000,
    }).toBeTruthy()
    await expect(page.getByText('Copied result cleared', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: /^Download .* result for / })).toHaveCount(0)

    await page.getByRole('button', { name: 'Run Mixed files' }).click()
    const second = await waitForExecution(apiBaseUrl, definition.id, (execution) =>
      execution.id !== first.id && execution.status === 'completed',
    )
    expect(second.counts.skipped).toBe(3)
    expect(second.counts.done).toBe(0)

    await updateBatchRerunPolicy(apiBaseUrl, definition.id, 'always')
    deterministicOpenAi.blockResponses()
    await page.getByRole('button', { name: 'Run Mixed files' }).click()
    const cancellable = await waitForExecution(apiBaseUrl, definition.id, (execution) =>
      execution.id !== second.id && execution.status === 'running' && execution.counts.running > 0,
    )
    if (process.platform === 'darwin') {
      await expect.poll(() => workspacePiProcessIds(workspacePath).length, {
        timeout: 20_000,
      }).toBeGreaterThan(0)
      for (const pid of workspacePiProcessIds(workspacePath)) {
        await expect.poll(() => launchServicesProcessType(pid), {
          timeout: 5_000,
        }).toBe('UIElement')
      }
    }
    await expect(page.getByRole('button', { name: 'Cancel Mixed files' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel Mixed files' }).click()
    const cancelled = await waitForExecution(apiBaseUrl, definition.id, (execution) =>
      execution.id === cancellable.id && execution.status === 'cancelled',
    )
    expect(cancelled.counts.cancelled).toBeGreaterThan(0)
    if (process.platform === 'darwin') {
      await expect.poll(() => workspacePiProcessIds(workspacePath), {
        timeout: 20_000,
      }).toEqual([])
    }
  } finally {
    deterministicOpenAi.releaseBlockedResponses()
    await app?.close().catch(() => undefined)
    await deterministicOpenAi.close().catch(() => undefined)
    terminateWorkspacePiProcesses(workspacePath)
    await fs.rm(externalPath, { recursive: true, force: true })
  }
})

async function replaceDirectoryDialog(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderPath] })
  }, selectedPath)
}

function workspacePiProcessIds(workspacePath: string): number[] {
  if (process.platform !== 'darwin') return []
  const candidates = commandOutput('ps', ['-axo', 'pid=,comm='])
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+pi\s*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => Number(match[1]))
  return candidates.filter((pid) => {
    const cwd = commandOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1)
    if (!cwd) return false
    const relative = path.relative(workspacePath, cwd)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function launchServicesProcessType(pid: number): string {
  const match = commandOutput('lsappinfo', ['list'])
    .match(new RegExp(`pid = ${pid}[^\\n]*type="([^"]+)"`))
  return match?.[1] ?? ''
}

function terminateWorkspacePiProcesses(workspacePath: string): void {
  for (const pid of workspacePiProcessIds(workspacePath)) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The process exited between discovery and cleanup.
      }
    }
  }
}

function commandOutput(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

async function updateBatchRerunPolicy(
  apiBaseUrl: string,
  batchId: string,
  rerunPolicy: 'always',
): Promise<void> {
  const current = await findBatch(apiBaseUrl, 'Mixed files')
  const response = await fetch(`${apiBaseUrl}/batches/${batchId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: current.revision, rerunPolicy }),
  })
  expect(response.status).toBe(200)
}

async function rendererApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const hash = await page.evaluate(() => window.location.hash.slice(1))
  const value = new URLSearchParams(hash).get('pipeline-api-base-url')
  if (!value) throw new Error('Desktop renderer did not expose its API base URL.')
  return value
}

async function findBatch(apiBaseUrl: string, name: string): Promise<BatchView> {
  const response = await fetch(`${apiBaseUrl}/batches`)
  expect(response.status).toBe(200)
  const payload = await response.json() as { batches: BatchView[] }
  const batch = payload.batches.find((candidate) => candidate.name === name)
  if (!batch) throw new Error(`Batch not found: ${name}`)
  return batch
}

async function waitForExecution(
  apiBaseUrl: string,
  batchId: string,
  predicate: (execution: NonNullable<BatchView['latestExecution']>) => boolean,
): Promise<NonNullable<BatchView['latestExecution']>> {
  let latest: BatchView['latestExecution']
  await expect.poll(async () => {
    latest = (await getBatch(apiBaseUrl, batchId)).latestExecution
    return latest ? predicate(latest) : false
  }, { timeout: 120_000, intervals: [250, 500, 1_000] }).toBe(true)
  return latest!
}

async function getBatch(apiBaseUrl: string, batchId: string): Promise<BatchView> {
  const response = await fetch(`${apiBaseUrl}/batches/${encodeURIComponent(batchId)}`)
  expect(response.status).toBe(200)
  return await response.json() as BatchView
}

async function getExecution(
  apiBaseUrl: string,
  batchId: string,
  executionId: string,
): Promise<BatchExecutionItemPage> {
  const response = await fetch(`${apiBaseUrl}/batches/${batchId}/executions/${executionId}?limit=100`)
  expect(response.status).toBe(200)
  return await response.json() as BatchExecutionItemPage
}

async function launchDesktop(options: {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly projectRootPath: string
  readonly piStatePath: string
  readonly openAiBaseUrl: string
}): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null
  // The packaged-smoke worker names no model, and a Team's retired defaults no
  // longer choose one, so each Batch item needs an application default. It is
  // written the way Settings writes it, on a keyless LM Studio connection to the
  // same deterministic server: the native tool route refuses a keyless
  // OpenAI-compatible one.
  await seedProviderSettings({
    userDataPath: options.userDataPath,
    baseUrl: options.openAiBaseUrl.replace(/\/v1$/, ''),
    defaultModel: APP_DEFAULT_MODEL,
    kind: 'lm-studio',
  })
  return electron.launch({
    args: executablePath ? ['--disable-gpu', '--no-sandbox'] : ['.', '--disable-gpu', '--no-sandbox'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      OPENAI_API_KEY: 'batch-electron-test-key',
      OPENAI_BASE_URL: options.openAiBaseUrl,
      PI_CODING_AGENT_DIR: options.piStatePath,
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: options.projectRootPath,
      PIPELINE_DESKTOP_USER_DATA: options.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: options.workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
}

async function prepareDeterministicPitchDeckProject(projectRootPath: string): Promise<void> {
  await fs.cp(
    path.join(repoRoot, 'tests', 'fixtures', 'packaged-workflow-smoke'),
    projectRootPath,
    { recursive: true },
  )
  const workflowPath = path.join(
    projectRootPath,
    'workflows',
    'templates',
    'pitch-deck-evaluation.yaml',
  )
  const packagedWorkflowPath = path.join(
    projectRootPath,
    'workflows',
    'templates',
    'packaged-smoke.yaml',
  )
  await fs.writeFile(
    workflowPath,
    replaceRequiredText({
      file: packagedWorkflowPath,
      pattern: 'id: packaged-smoke',
      replacement: 'id: pitch-deck-evaluation',
      source: await fs.readFile(packagedWorkflowPath, 'utf8'),
    }),
  )
  await fs.writeFile(
    path.join(projectRootPath, 'workflows', 'registry.yaml'),
    [
      'pitch-deck-evaluation:',
      '  description: Deterministic two-stage pitch deck evaluation for Batch acceptance.',
      '  template_path: ./templates/pitch-deck-evaluation.yaml',
      '  capabilities:',
      '    - pitch_deck_evaluation',
      '',
    ].join('\n'),
  )
}
