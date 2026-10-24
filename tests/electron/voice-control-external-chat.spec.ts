import { expect, test, type TestInfo } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as z from 'zod/v4'
import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { APP_DEFAULT_MODEL, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

test('an external agent answer appears in the already open chat without show or navigation', async ({}, testInfo) => {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRoot = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const discoveryDir = testInfo.outputPath('voice-control')
  // Paid model generation is substituted only at HTTP. The desktop, REST services,
  // persisted chat, authenticated MCP and preload bridge remain real.
  const started = gate()
  const answer = gate()
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => {
      const matches = request.systemPrompt?.includes('External chat alpha fixture.') ?? false
      if (matches) started.release()
      return matches
    }, gate: answer.promise, content: 'An external answer reached this chat.' },
    { content: 'An external answer reached this chat.' },
  ] })
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    writeAgentPersona(projectRoot, { name: 'alpha-analyst', description: 'Examines pricing.', marker: 'External chat alpha fixture.' }),
    seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  ])
  const store = new FileSystemSessionStore(workspacePath)
  const session = await store.createSession({ title: 'External answer journey' })
  const app = await launchDesktop({ userDataPath, workspacePath, env: {
    ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }), OCTOPUS_VOICE_CONTROL_DIR: discoveryDir
  } })
  const client = new Client({ name: 'external-chat-journey', version: '1.0.0' })
  let transport: StreamableHTTPClientTransport | undefined
  try {
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    const initialTranscript = page.waitForResponse((response) => response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${session.id}/messages`))
    await page.getByRole('complementary', { name: 'Primary navigation', exact: true })
      .getByRole('button', { name: /^External answer journey\b/ }).click()
    const loaded = await initialTranscript
    expect(loaded.ok()).toBe(true)
    const before: unknown = await loaded.json()
    expect(before).toMatchObject({ messages: [] })
    const chat = page.getByRole('region', { name: 'Run chat', exact: true })
    await expect(page.getByRole('button', { name: 'Edit session title' })).toHaveText('External answer journey')
    const descriptorInput: unknown = JSON.parse(await fs.readFile(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8'))
    const descriptor = voiceControlDescriptorSchema.parse(descriptorInput)
    transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), { requestInit: { headers: { ...descriptor.mcp.headers } } })
    await client.connect(new ExactOptionalMcpTransport(transport))
    const focusedBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)

    const call = client.callTool({ name: 'ask', arguments: { sessionId: session.id, agentName: 'alpha-analyst', text: 'Answer the external question.' } }, undefined, { timeout: 20_000 })
    // Teardown must preserve an earlier assertion failure.
    void call.catch(() => undefined)
    await started.promise
    try {
      await expect(chat.getByRole('log').getByRole('status', { name: /is responding/ })).toBeVisible()
    } finally {
      answer.release()
      await call
    }
    const result = await call

    expect(result.isError).not.toBe(true)
    await expect(chat.getByRole('log').getByText('An external answer reached this chat.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit session title' })).toHaveText('External answer journey')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)).toBe(focusedBefore)
    expect((await store.listChatMessages(session.id)).map((line) => line.text)).toEqual(['Answer the external question.', 'An external answer reached this chat.'])
  } finally {
    answer.release()
    await transport?.terminateSession().catch(() => undefined)
    await client.close()
    await app.close()
    await provider.close()
  }
})

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function withVoiceChat(testInfo: TestInfo, run: (fixture: {
  app: Awaited<ReturnType<typeof launchDesktop>>
  client: Client
  store: FileSystemSessionStore
  started: Promise<void>
  release: () => void
  finish: () => void
}) => Promise<void>) {
  const workspacePath = testInfo.outputPath('workspace')
  const projectRoot = testInfo.outputPath('project')
  const userDataPath = testInfo.outputPath('user-data')
  const discoveryDir = testInfo.outputPath('voice-control')
  const started = gate()
  const answer = gate()
  const finish = gate()
  // Only the non-deterministic provider is replaced, at its HTTP boundary.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (request) => request.systemPrompt?.includes('Create a 4 to 6 word session title') ?? false,
      content: 'Choosing Ontologies For Flower Catalogs' },
    { match: (request) => {
      const matches = !request.stream && (request.systemPrompt?.includes('External chat alpha fixture.') ?? false)
      if (matches) started.release()
      return matches
    }, gate: answer.promise, content: 'Use Plant Ontology for flower structures.' },
    { match: (request) => {
      const matches = request.stream && (request.systemPrompt?.includes('External chat alpha fixture.') ?? false)
      if (matches) started.release()
      return matches
    },
      deltas: ['Use Plant ', 'Ontology for flower structures.'], deltaGates: [answer.promise, finish.promise], gate: finish.promise },
    { content: 'Use Plant Ontology for flower structures.' },
  ] })
  await fs.mkdir(workspacePath, { recursive: true })
  await writeAgentPersona(projectRoot, { name: 'alpha-analyst', description: 'Examines flowers.', marker: 'External chat alpha fixture.' })
  await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  const store = new FileSystemSessionStore(workspacePath)
  const app = await launchDesktop({ userDataPath, workspacePath, env: {
    ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }), OCTOPUS_VOICE_CONTROL_DIR: discoveryDir
  } })
  const client = new Client({ name: 'external-progress-journey', version: '1.0.0' })
  let transport: StreamableHTTPClientTransport | undefined
  try {
    await app.firstWindow()
    const descriptor = voiceControlDescriptorSchema.parse(JSON.parse(await fs.readFile(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8')))
    transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), { requestInit: { headers: { ...descriptor.mcp.headers } } })
    await client.connect(new ExactOptionalMcpTransport(transport))
    await run({ app, client, store, started: started.promise, release: answer.release, finish: finish.release })
  } finally {
    answer.release()
    finish.release()
    await transport?.terminateSession().catch(() => undefined)
    await client.close()
    await app.close()
    await provider.close()
  }
}

test('a new voice chat gets a generated title from the question', async ({}, testInfo) => {
  await withVoiceChat(testInfo, async ({ client, store, release, finish }) => {
    release()
    finish()
    const result = await client.callTool({ name: 'ask', arguments: { agentName: 'alpha-analyst', text: 'What ontology should I use for flowers?' } })
    expect(result.isError).not.toBe(true)
    const { sessionId } = z.object({ sessionId: z.string() }).parse(result.structuredContent)
    const session = await store.getSession(sessionId)
    expect(session?.title).toBe('Choosing Ontologies For Flower Catalogs')
  })
})

test('opening a voice chat during generation shows thinking and then the saved answer', async ({}, testInfo) => {
  await withVoiceChat(testInfo, async ({ app, client, store, started, release, finish }) => {
    const session = await store.createSession({ title: 'Flower question journey' })
    const call = client.callTool({ name: 'ask', arguments: { sessionId: session.id, agentName: 'alpha-analyst', text: 'What ontology should I use for flowers?' } })
    // Keep teardown from replacing an assertion failure with an unhandled MCP rejection.
    void call.catch(() => undefined)
    // Observe the actual provider request before opening the chat.
    await started
    const page = await app.firstWindow()
    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('complementary', { name: 'Primary navigation', exact: true })
      .getByRole('button', { name: /^Flower question journey\b/ }).click()
    const log = page.getByRole('region', { name: 'Run chat', exact: true }).getByRole('log')
    await expect(log.getByText('What ontology should I use for flowers?', { exact: true })).toBeVisible()
    try {
      await expect(log.getByRole('status', { name: /is responding/ })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('voice-thinking.png') })
      release()
      await expect(log.getByTestId('streaming-reply')).toContainText('Use Plant')
    } finally {
      release()
      finish()
      await call
    }
    expect((await call).isError).not.toBe(true)
    await expect(log.getByText('Use Plant Ontology for flower structures.', { exact: true })).toHaveCount(1)
    await expect(log.getByRole('status', { name: /is responding/ })).toHaveCount(0)
    await expect(log.getByTestId('streaming-reply')).toHaveCount(0)
  })
})
