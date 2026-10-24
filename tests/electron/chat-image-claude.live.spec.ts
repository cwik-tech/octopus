import { _electron as electron, expect, test } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { z } from 'zod'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import { repoRoot } from './support/model-selection-fixture.js'

test('Run uploads two images and real Claude Code identifies both through the CLI bridge', async ({}, testInfo) => {
  test.setTimeout(150_000)
  const workspacePath = testInfo.outputPath('workspace')
  const projectRootPath = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  await fs.mkdir(workspacePath, { recursive: true })
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.cp(path.join(repoRoot, 'tests/fixtures/packaged-workflow-smoke'), projectRootPath, { recursive: true })
  const agentDirectory = path.join(projectRootPath, 'agents', 'visual-reader')
  await fs.mkdir(agentDirectory, { recursive: true })
  await fs.writeFile(path.join(agentDirectory, 'visual-reader.md'), [
    '---', 'name: visual-reader', 'description: Inspect uploaded images with document tools.',
    'tier: strategic', 'provider: claude', 'model: opus', 'thinking: low', '---', '',
    'Inspect each requested image using document_read before answering. Report only what you can see.',
  ].join('\n'))
  await fs.writeFile(path.join(userDataPath, 'provider-settings.json'), JSON.stringify({
    version: 3, connections: [], cliEnabled: { claude: true }, cliModelEnabled: { claude: { opus: true } },
    defaultModel: { provider: 'claude', model: 'opus' },
  }))
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'Live Claude visual grounding' })
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
  const app = await electron.launch({ args: executablePath ? [] : ['.'], cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: { ...fixtureDesktopEnvironment(), NODE_ENV: 'test', PIPELINE_DESKTOP_E2E: '1',
      // This opt-in journey uses the real CLI; the ordinary fixture guard
      // deliberately hides every installed provider executable.
      PATH: process.env.PATH ?? '', PIPELINE_CLI_PATH_FALLBACK: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath, PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('button', { name: /^Live Claude visual grounding\b/ }).first().click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByRole('button', { name: 'Edit session title' })).toHaveText('Live Claude visual grounding')
    await expect(chat.getByRole('button', { name: 'Run chat model' })).toContainText('Opus', { timeout: 30_000 })
    // Neutral upload names keep the expected colors out of the model's text input.
    await chat.getByLabel('Upload files').setInputFiles([
      { name: 'A.jpg', mimeType: 'image/jpeg', buffer: await fs.readFile(path.join(repoRoot, 'file-parser/tests/fixtures/test-photo.jpg')) },
      { name: 'B.png', mimeType: 'image/png', buffer: await fs.readFile(path.join(repoRoot, 'file-parser/tests/fixtures/icon.png')) },
    ])
    await expect(chat.getByTestId('file-message-card').filter({ hasText: 'A.jpg' })).toContainText('parsed', { timeout: 20_000 })
    await expect(chat.getByTestId('file-message-card').filter({ hasText: 'B.png' })).toContainText('parsed', { timeout: 20_000 })
    await chat.getByRole('textbox').fill('@visual-reader Use document_read to inspect BOTH pictures. What is the dominant color of each? Reply only A=<color>; B=<color>.')
    const replyResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith(`/sessions/${session.id}/messages`), { timeout: 90_000 })
    await chat.getByRole('textbox').press('Enter')
    const response = await replyResponse
    expect(response.ok()).toBe(true)
    const result = z.object({ meta: z.object({ replies: z.array(z.object({
      speakerId: z.string(), mcp: z.object({ status: z.string(), executedToolCallCount: z.number() }),
    })) }) }).parse(await response.json())
    expect(result.meta.replies).toHaveLength(1)
    expect(result.meta.replies[0]?.speakerId).toBe('visual-reader')
    expect(result.meta.replies[0]?.mcp.status).toBe('used')
    expect(result.meta.replies[0]?.mcp.executedToolCallCount).toBeGreaterThanOrEqual(2)
    await fs.writeFile(testInfo.outputPath('agent-tool-response.json'), JSON.stringify(result, null, 2))
    await expect(chat.getByText(/A\s*=\s*red\s*;\s*B\s*=\s*green/i)).toBeVisible({ timeout: 75_000 })
    const messages = await store.listChatMessages(session.id)
    expect(messages.find((message) => message.role === 'user')?.turnRequest?.responder).toBe('agents')
    const answer = messages.filter((message) => message.role === 'assistant').at(-1)
    expect(answer?.speaker?.id).toBe('visual-reader')
    expect(answer?.text).toMatch(/A\s*=\s*red\s*;\s*B\s*=\s*green/i)
    if (!answer?.execution) throw new Error('The image answer has no persisted agent execution')
    const journalPath = path.join(workspacePath, 'sessions', session.id, 'runs', answer.execution.runId,
      'assignments', answer.execution.assignmentId, '.runtime/execution-journal/journal.jsonl')
    const events = (await fs.readFile(journalPath, 'utf8')).trim().split('\n')
      .map((line) => z.object({ type: z.string(), payload: z.unknown() }).parse(JSON.parse(line)))
    const prepared = z.object({ route: z.string(), resolvedModel: z.string(), executedToolCount: z.number() })
      .parse(events.find((event) => event.type === 'agent.turn.prepared')?.payload)
    expect(prepared).toMatchObject({ route: 'mcp-cli', resolvedModel: 'opus' })
    expect(prepared.executedToolCount).toBeGreaterThanOrEqual(2)
    await page.reload()
    await page.getByRole('button', { name: /^Live Claude visual grounding\b/ }).first().click()
    await expect(page.getByText(/A\s*=\s*red\s*;\s*B\s*=\s*green/i)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('claude-visual-answer.png') })
  } finally { await app.close() }
})
