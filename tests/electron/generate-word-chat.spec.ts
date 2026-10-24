import {
  _electron as electron,
  expect,
  test,
  type Page,
} from '@playwright/test'
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

test('Generate Word switch controls real DOCX delivery from selected-agent Chat', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const providerRequestLogPath = testInfo.outputPath('provider-requests.jsonl')
  const providerFixture = await startOpenAiToolLoopFixture(
    repoRoot,
    'openai-tool-loop-server.mjs',
    {
      env: { PROVIDER_FIXTURE_REQUEST_LOG: providerRequestLogPath },
    },
  )
  const projectRoot = testInfo.outputPath('generate-word-project')
  const userDataPath = testInfo.outputPath('generate-word-user-data')
  const workspacePath = testInfo.outputPath('generate-word-workspace')
  const personaPath = await createWriterAgent(projectRoot)
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
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
      OPENAI_API_KEY: 'generate-word-e2e-key',
      OPENAI_BASE_URL: `${providerFixture.url}/v1`,
    },
  })

  try {
    const page = await app.firstWindow()

    await setGenerateWordPermission(page, personaPath, true)
    await sendWordRequest(page, 0)

    const enabledRequests = await readJsonLines(providerRequestLogPath)
    expect(
      enabledRequests.some((request) =>
        request.tools?.some((tool) =>
          tool?.type === 'function' &&
          tool.function?.name === 'generate_word'
        )
      ),
    ).toBe(true)
    expect(
      enabledRequests.some((request) =>
        request.messages?.some((message) => message?.role === 'tool')
      ),
    ).toBe(true)

    const downloadLink = page.getByRole('link', {
      name: /^Download .*\.docx$/i,
    })
    await expect(downloadLink).toHaveCount(1)
    const downloadUrl = await downloadLink.getAttribute('href')
    expect(downloadUrl).not.toBeNull()
    const downloaded = await page.evaluate(async (url) => {
      const response = await fetch(url)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        signature: String.fromCharCode(...bytes.subarray(0, 2)),
        size: bytes.byteLength,
      }
    }, downloadUrl!)
    expect(downloaded.status).toBe(200)
    expect(downloaded.contentType).toMatch(
      /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
    )
    expect(downloaded.signature).toBe('PK')
    expect(downloaded.size).toBeGreaterThan(1_000)
    await expect.poll(
      () => countFilesWithExtension(workspacePath, '.docx'),
    ).toBe(1)

    await setGenerateWordPermission(page, personaPath, false)
    await sendWordRequest(page, 1)

    await expect(downloadLink).toHaveCount(1)
    await expect.poll(
      () => countFilesWithExtension(workspacePath, '.docx'),
    ).toBe(1)
  } finally {
    await app.close()
    await providerFixture.close()
  }
})

async function setGenerateWordPermission(
  page: Page,
  personaPath: string,
  enabled: boolean,
): Promise<void> {
  await page.getByRole('tab', { name: 'Create', exact: true }).click()
  const showSidebar = page.getByRole('button', { name: 'Show sidebar' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: /^Word Writer\b/ }).click()
  await page.getByRole('tab', { name: /^Tools/ }).click()

  const generateWordSwitch = page.getByRole('switch', {
    name: 'Toggle Generate Word',
  })
  if (enabled) {
    await expect(generateWordSwitch).not.toBeChecked()
  } else {
    await expect(generateWordSwitch).toBeChecked()
  }
  await generateWordSwitch.click()
  if (enabled) {
    await expect(generateWordSwitch).toBeChecked()
  } else {
    await expect(generateWordSwitch).not.toBeChecked()
  }

  // A tool switch saves on change; the editor has no Save button
  // (agent-package-editor.test.tsx, "saves a … switch change immediately").
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect.poll(async () => fs.readFile(personaPath, 'utf8')).toContain(
    enabled ? 'tools: generate_word' : 'tools: none',
  )
}

async function sendWordRequest(
  page: Page,
  expectedResponseCount: number,
): Promise<void> {
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  const showInspector = page.getByRole('button', { name: 'Show inspector' })
  if (await showInspector.isVisible()) await showInspector.click()

  const wordWriter = page.getByRole('button', { name: /^Word Writer/i })
  if ((await wordWriter.getAttribute('aria-pressed')) !== 'true') {
    await page.getByRole('button', { name: 'Search Agents' }).click()
    const search = page.getByRole('searchbox', { name: 'Search Agents' })
    await search.fill('word-writer')
    await wordWriter.click()
  }

  const input = page.getByPlaceholder(
    'Send a message to the selected agents...',
  )
  const request =
    'Create a Word document with headings, page numbers, and a dynamic table of contents.'
  await input.fill(request)
  const send = page.getByRole('button', { name: 'Send message' })
  await expect(send).toBeEnabled()
  const sentRequests = page.getByText(request, { exact: true })
  const sentBefore = await sentRequests.count()
  await send.click()
  // Send stays enabled while a first turn creates its session. The request
  // bubble renders in the same update that swaps Send out, so wait on it.
  await expect(sentRequests).toHaveCount(sentBefore + 1)
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await expect(
    page.getByRole('heading', { name: 'Lorem Ipsum Document' }),
  ).toHaveCount(expectedResponseCount)
}

async function createWriterAgent(projectRoot: string): Promise<string> {
  const directory = path.join(projectRoot, 'agents', 'word-writer')
  const personaPath = path.join(directory, 'word-writer.md')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    personaPath,
    [
      '---',
      'name: word-writer',
      'description: Generate Word desktop E2E writer.',
      'tier: execution',
      'provider: openai',
      'model: fixture/generate-word',
      'thinking: low',
      'tools: none',
      '---',
      '',
      '# Word Writer',
      '',
      'Write complete business documents as canonical Markdown.',
      '',
    ].join('\n'),
    'utf8',
  )
  return personaPath
}

async function countFilesWithExtension(
  directory: string,
  extension: string,
): Promise<number> {
  let count = 0
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      count += await countFilesWithExtension(entryPath, extension)
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      count += 1
    }
  }
  return count
}

async function readJsonLines(filePath: string): Promise<Array<{
  tools?: Array<{
    type?: string
    function?: { name?: string }
  }>
  messages?: Array<{ role?: string }>
}>> {
  return (await fs.readFile(filePath, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      tools?: Array<{
        type?: string
        function?: { name?: string }
      }>
      messages?: Array<{ role?: string }>
    })
}
