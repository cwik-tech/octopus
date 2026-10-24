import { expect, test as base, type ElectronApplication } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { agentDialogueRecordSchema } from '../../contracts/agent-dialogue.js'
import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startVoiceLayerFixture, type VoiceLayerFixture } from '../helpers/voice-layer-fixture.js'
import { startFakeChatCompletionsServer, type FakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { APP_DEFAULT_MODEL, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

const ALPHA_MARKER = 'Voice dialogue fixture alpha-analyst.'
const BETA_MARKER = 'Voice dialogue fixture beta-builder.'
const TOPIC = 'Consider a pricing pilot.'
const FIRST_REPLY = 'A useful pricing pilot needs evidence.'
const NEXT_REPLY = 'The new question needs a different answer.'

function makeGate() {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const test = base.extend<{
  gates: { interrupt: ReturnType<typeof makeGate>; reserveRequested: ReturnType<typeof makeGate>; reserve: ReturnType<typeof makeGate> }
  provider: FakeChatCompletionsServer
  voice: VoiceLayerFixture
  journey: { app: ElectronApplication; client: Client; store: FileSystemSessionStore; sessionId: string }
}>({
  gates: async ({}, use) => {
    const gates = { interrupt: makeGate(), reserveRequested: makeGate(), reserve: makeGate() }
    try { await use(gates) } finally {
      gates.interrupt.release()
      gates.reserveRequested.release()
      gates.reserve.release()
    }
  },
  provider: async ({ gates }, use) => {
    // The paid, nondeterministic model is replaced only at HTTP. The desktop,
    // API, Agent execution, MCP transport and filesystem stores remain real.
    const provider = await startFakeChatCompletionsServer({ script: [
      { match: (request) => !request.stream && request.systemPrompt?.includes(ALPHA_MARKER) === true, content: FIRST_REPLY },
      { match: (request) => {
        const match = !request.stream && request.systemPrompt?.includes(BETA_MARKER) === true
        if (match) gates.reserveRequested.release()
        return match
      }, content: 'The reserved reply was never heard.', gate: gates.reserve.promise },
      { match: (request) => !request.stream && request.systemPrompt?.includes(BETA_MARKER) === true, content: NEXT_REPLY },
      { content: 'OK' },
    ] })
    try { await use(provider) } finally { gates.reserve.release(); await provider.close() }
  },
  voice: async ({ gates }, use, testInfo) => {
    // Physical speech is unavailable and nondeterministic. Replace playback at
    // its authenticated MCP boundary with controlled progress and receipts.
    const voice = await startVoiceLayerFixture(testInfo.outputPath('voice-control'), { onSay: async (input, context) => {
      const utteranceId = input.utteranceId
      if (!utteranceId) throw new Error('A dialogue speech call must have a stable utterance ID')
      await context.progress({ utteranceId, state: 'started', heardChars: 0, totalChars: input.text.length })
      if (input.speaker?.id === 'alpha-analyst') {
        context.signal.addEventListener('abort', gates.interrupt.release, { once: true })
        await gates.interrupt.promise
        return { utteranceId, outcome: 'interrupted', heardChars: 14 }
      }
      return { utteranceId, outcome: 'spoken', heardChars: input.text.length }
    } })
    try { await use(voice) } finally { gates.interrupt.release(); await voice.close() }
  },
  journey: async ({ provider, voice: _voice, gates }, use, testInfo) => {
    const workspacePath = testInfo.outputPath('workspace')
    const projectRoot = testInfo.outputPath('project')
    const userDataPath = testInfo.outputPath('user-data')
    let app: ElectronApplication | undefined
    let client: Client | undefined
    let transport: StreamableHTTPClientTransport | undefined
    try {
      await Promise.all([
        fs.mkdir(workspacePath, { recursive: true }),
        writeAgentPersona(projectRoot, { name: 'alpha-analyst', description: 'Examines pricing.', marker: ALPHA_MARKER }),
        writeAgentPersona(projectRoot, { name: 'beta-builder', description: 'Challenges pricing.', marker: BETA_MARKER }),
        seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL }),
      ])
      const store = new FileSystemSessionStore(workspacePath)
      const session = await store.createSession({ title: 'Voice dialogue journey' })
      app = await launchDesktop({ userDataPath, workspacePath, env: {
        ...desktopEnvironment({ projectRoot, userDataPath, workspacePath }),
        OCTOPUS_VOICE_CONTROL_DIR: testInfo.outputPath('voice-control'),
      } })
      const descriptorInput: unknown = JSON.parse(await fs.readFile(path.join(testInfo.outputPath('voice-control'), 'apps', 'octopus.json'), 'utf8'))
      const descriptor = voiceControlDescriptorSchema.parse(descriptorInput)
      transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), { requestInit: { headers: { ...descriptor.mcp.headers } } })
      client = new Client({ name: 'voice-dialogue-desktop', version: '1.0.0' })
      await client.connect(new ExactOptionalMcpTransport(transport))
      await use({ app, client, store, sessionId: session.id })
    } finally {
      gates.interrupt.release()
      gates.reserve.release()
      await transport?.terminateSession().catch(() => undefined)
      await client?.close().catch(() => undefined)
      await app?.close()
    }
  },
})

test('interrupted speech keeps its heard words in the desktop chat and a typed interjection resumes the next Agent', async ({ journey, gates, provider }) => {
  const result = await journey.client.callTool({ name: 'start_dialogue', arguments: {
    sessionId: journey.sessionId, agents: ['alpha-analyst', 'beta-builder'], topic: TOPIC, delivery: 'voice', maxTurns: 2,
  } }, undefined, { timeout: 10_000 })
  expect(result.isError).not.toBe(true)
  const record = agentDialogueRecordSchema.parse(result.structuredContent)
  expect(record.sessionId).toBe(journey.sessionId)
  const page = await journey.app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  await page.getByRole('complementary', { name: 'Primary navigation', exact: true })
    .getByRole('button', { name: /^Voice dialogue journey\b/ }).click()
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  await expect(chat.getByRole('log').getByText(FIRST_REPLY, { exact: true })).toBeVisible()
  await gates.reserveRequested.promise

  gates.interrupt.release()

  await expect(chat.getByRole('status', { name: 'Reply cut off' })).toBeVisible()
  await expect(chat.getByRole('log').getByText('A useful', { exact: true })).toBeVisible()
  await expect(chat.getByRole('log').getByText(FIRST_REPLY, { exact: true })).toHaveCount(0)
  await expect(chat.getByRole('status', { name: 'Dialogue pause reason' }))
    .toHaveText('Speech interrupted. Send an interjection or resume.')
  await expect(chat.getByRole('button', { name: 'Resume dialogue', exact: true })).toBeEnabled()
  await chat.getByRole('textbox').fill('What about churn?')
  await chat.getByRole('button', { name: 'Send message', exact: true }).click()
  gates.reserve.release()

  await expect(chat.getByRole('log').getByText(NEXT_REPLY, { exact: true })).toBeVisible()
  await expect(chat.getByText('Reached the 2-turn limit.', { exact: true })).toBeVisible()
  await expect(chat.getByRole('status', { name: 'Dialogue pause reason' })).toHaveCount(0)
  expect((await journey.store.listChatMessages(journey.sessionId)).map((message) => message.text))
    .toEqual([TOPIC, 'A useful', 'What about churn?', NEXT_REPLY])
  expect(provider.requests.find((request) => request.systemPrompt?.includes(BETA_MARKER) && request.userMessage?.includes('What about churn?'))?.userMessage)
    .toContain('[cut off]')
})

test('an external dialogue refreshes the session that is already open without show', async ({ journey }) => {
  const page = await journey.app.firstWindow()
  await page.getByRole('tab', { name: 'Run', exact: true }).click()
  const listed = page.waitForResponse((response) => response.request().method() === 'GET' &&
    new URL(response.url()).pathname.endsWith(`/sessions/${journey.sessionId}/dialogues`))
  await page.getByRole('complementary', { name: 'Primary navigation', exact: true })
    .getByRole('button', { name: /^Voice dialogue journey\b/ }).click()
  expect((await listed).ok()).toBe(true)
  const chat = page.getByRole('region', { name: 'Run chat', exact: true })
  await expect(chat.getByRole('button', { name: 'Stop dialogue', exact: true })).toHaveCount(0)
  const started = await journey.client.callTool({ name: 'start_dialogue', arguments: {
    sessionId: journey.sessionId, agents: ['alpha-analyst', 'beta-builder'], topic: TOPIC, delivery: 'voice', maxTurns: 2,
  } }, undefined, { timeout: 10_000 })
  expect(started.isError).not.toBe(true)
  expect(agentDialogueRecordSchema.parse(started.structuredContent).sessionId).toBe(journey.sessionId)

  await expect(chat.getByRole('button', { name: 'Stop dialogue', exact: true })).toBeEnabled()
  await expect(chat.getByRole('log').getByText(FIRST_REPLY, { exact: true })).toBeVisible()
  await chat.getByRole('button', { name: 'Stop dialogue', exact: true }).click()
  await expect(chat.getByText('Stopped.', { exact: true })).toBeVisible()
  expect((await journey.store.listChatMessages(journey.sessionId)).map((message) => message.text)).toEqual([TOPIC])
})
