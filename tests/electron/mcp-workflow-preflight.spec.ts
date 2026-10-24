import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { setFrontMatterFields } from '../support/config-rewrite.js'
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
const providerModel = 'fixture/tool-loop'

test('desktop workflow preflight blocks, then launches after a real MCP grant', async ({}, testInfo) => {
  test.setTimeout(75_000)
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot)
  const providerSecret = `mcp-workflow-provider-secret-${Date.now()}`
  const userDataPath = testInfo.outputPath('mcp-workflow-user-data')
  const workspacePath = testInfo.outputPath('mcp-workflow-workspace')
  const projectRoot = testInfo.outputPath('mcp-workflow-project')
  const lifecyclePath = testInfo.outputPath('mcp-workflow-lifecycle.jsonl')
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
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${providerFixture.url}/v1`,
      TEAM_RUNTIME_TASK_RUNNER_DRY_RUN: '1',
    },
  })
  const page = await app.firstWindow()

  try {
    await configureMcp(page, lifecyclePath)
    await expect.poll(() => eventCount(lifecyclePath, 'ready')).toBe(1)
    const apiBaseUrl = await desktopApiBaseUrl(page)
    const sessionResponse = await fetch(`${apiBaseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'MCP workflow preflight' }),
    })
    expect(sessionResponse.status).toBe(201)
    const session = await sessionResponse.json() as { id: string }

    const blockedResponse = await fetch(
      `${apiBaseUrl}/sessions/${session.id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'mcp-writing',
          brief: 'Draft a short evidence-grounded memo.',
        }),
      },
    )
    expect(blockedResponse.status).toBe(409)
    const blocked = await blockedResponse.json() as {
      retryable: boolean
      diagnostics: Array<{ capability: string; access: string[] }>
      plan: { status: string }
    }
    expect(blocked.retryable).toBe(true)
    expect(blocked.plan.status).toBe('ready')
    expect(blocked.diagnostics).toMatchObject([
      { capability: 'documents', access: ['read'] },
    ])
    const emptyTasks = await fetch(
      `${apiBaseUrl}/sessions/${session.id}/tasks`,
    ).then((response) => response.json()) as { tasks: unknown[] }
    expect(emptyTasks.tasks).toEqual([])

    await grantWriterMcp(page)

    const launchedResponse = await fetch(
      `${apiBaseUrl}/sessions/${session.id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'mcp-writing' }),
      },
    )
    const launchedBody = await launchedResponse.json()
    expect(launchedResponse.status, JSON.stringify(launchedBody)).toBe(202)
    const task = launchedBody as {
      id: string
      runPath: string
      mcpResolutionPath: string
    }
    await expect.poll(async () => {
      const response = await fetch(
        `${apiBaseUrl}/sessions/${session.id}/tasks/${task.id}`,
      )
      return ((await response.json()) as { status: string }).status
    }).toBe('done')

    const resolution = JSON.parse(
      await fs.readFile(task.mcpResolutionPath, 'utf8'),
    ) as {
      authorization: { state: string; brokerRechecksAtCallTime: boolean }
      steps: Array<{
        matches: Array<{
          capability: string
          candidates: Array<{ serverName: string; agentPath: string }>
        }>
      }>
    }
    expect(resolution.authorization).toEqual({
      state: 'non-authoritative',
      brokerRechecksAtCallTime: true,
    })
    expect(
      resolution.steps[0]?.matches.find(
        (match) => match.capability === 'documents',
      )?.candidates,
    ).toContainEqual({
      serverId: expect.any(String),
      serverName: 'Workflow MCP',
      agentPath: 'agents/writer',
      provider: 'openai',
      state: 'supported',
    })
    expect(task.mcpResolutionPath.startsWith(task.runPath)).toBe(true)
    expect(JSON.stringify(resolution)).not.toMatch(/stdio-server|transport|secret/i)
  } finally {
    await Promise.allSettled([app.close(), providerFixture.close()])
  }

  await expect.poll(() => eventCount(lifecyclePath, 'stopped')).toBe(1)
  for (const pid of new Set(
    (await readJsonLines(lifecyclePath) as Array<{ pid: number }>).map(
      (event) => event.pid,
    ),
  )) {
    await expect.poll(() => isProcessAlive(pid)).toBe(false)
  }
})

async function configureMcp(page: Page, lifecyclePath: string): Promise<void> {
  await page.getByLabel('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'MCPs' }).click()
  await page.getByRole('button', { name: 'Add connection' }).click()
  await page.getByLabel('Name').fill('Workflow MCP')
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(process.execPath)
  await page.getByLabel('Arguments, one per line').fill(stdioFixturePath)
  await page.getByLabel(
    'I trust this command and understand validation will run it locally on this computer.',
  ).check()
  await page.getByRole('button', { name: 'Add secret' }).click()
  await page.getByLabel('Secret environment variables key 1').fill(
    'MCP_FIXTURE_LIFECYCLE_PATH',
  )
  await page.getByLabel('Secret environment variables value 1').fill(lifecyclePath)
  await page.getByRole('button', { name: 'Add capability' }).click()
  await page.getByLabel('Workflow capability 1', { exact: true }).fill('documents')
  await page.getByLabel('Workflow capability access 1').selectOption('read')
  await page.getByRole('button', { name: 'Save & Validate' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
}

async function grantWriterMcp(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: /^Writer\b/ }).click()
  await page.getByRole('tab', { name: /^Tools/ }).click()
  await page.getByRole('tab', { name: 'MCPs' }).click()
  const grant = page.getByRole('switch', {
    name: 'Grant Workflow MCP to writer',
  })
  await expect(grant).not.toBeChecked()
  await grant.click()
  await expect(grant).toBeChecked()
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

async function createProject(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, 'workflows'), { recursive: true })
  await fs.mkdir(path.join(projectRoot, 'teams'), { recursive: true })
  await fs.cp(
    path.join(repoRoot, 'teams', 'writing-team'),
    path.join(projectRoot, 'teams', 'writing-team'),
    { recursive: true },
  )
  // No team.yaml rewrite here. `TeamConfig` carries no top-level `provider` or
  // `model` (see `core/types.ts`), and the one provider field the schema still
  // accepts — `defaults.provider` — is documented there as retired and read
  // only so it can be reported as ignored. The rewrite that used to run here
  // matched nothing in the bundled writing-team config and could not have
  // routed a dispatch even if it had. The persona front matter below and the
  // teams.yaml written after it are what actually route this preflight.
  for (const agentName of ['brief-builder', 'writer', 'editor', 'web-researcher']) {
    const agentDirectory = path.join(projectRoot, 'agents', agentName)
    await fs.cp(
      path.join(repoRoot, 'agents', agentName),
      agentDirectory,
      { recursive: true },
    )
    const agentPath = path.join(agentDirectory, `${agentName}.md`)
    await fs.writeFile(
      agentPath,
      routeAgentToFixture(agentPath, await fs.readFile(agentPath, 'utf8')),
      'utf8',
    )
  }
  await fs.writeFile(
    path.join(projectRoot, 'teams.yaml'),
    [
      'writing-team:',
      '  type: team',
      '  description: Writing fixture',
      '  team_path: ./teams/writing-team',
      '  input_artifact: incoming-brief.md',
      '  output_artifact: final-draft.md',
      `  host_model: ${providerModel}`,
      '  host_provider: openai',
      '',
    ].join('\n'),
  )
  await fs.writeFile(
    path.join(projectRoot, 'workflows', 'registry.yaml'),
    [
      'mcp-writing:',
      '  description: MCP workflow preflight fixture',
      '  template_path: ./mcp-writing.yaml',
      '',
    ].join('\n'),
  )
  await fs.writeFile(
    path.join(projectRoot, 'workflows', 'mcp-writing.yaml'),
    [
      'workflow:',
      '  id: mcp-writing',
      '  mcp_requirements:',
      '    - capability: documents',
      '      access: read',
      '      necessity: required',
      '  steps:',
      '    - id: draft',
      '      type: team',
      '      team: writing-team',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '  output:',
      '    from_step: draft',
      '    artifact: final-draft.md',
      '',
    ].join('\n'),
  )
}

/**
 * Pin a seeded persona to the fixture provider and model.
 *
 * Set, not replaced. A bundled persona may legitimately stop declaring
 * `provider:`, and a rewrite that quietly matched nothing would leave this
 * preflight dispatching to the real application default under a name that says
 * it exercises the fixture. `setFrontMatterFields` throws instead when there
 * is no front matter to pin the values in.
 */
function routeAgentToFixture(file: string, source: string): string {
  return setFrontMatterFields({
    fields: { model: providerModel, provider: 'openai' },
    file,
    source,
  })
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
  return (await readJsonLines(filePath) as Array<{ event?: string }>).filter(
    (entry) => entry.event === event,
  ).length
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
