import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseProviderTurnDiagnosticRecords } from '../../domains/runtime/provider-turn-diagnostics.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { launchDesktop } from './support/desktop-launch.js'
import { APP_DEFAULT_MODEL, FIXTURE_PROVIDER, desktopEnvironment, seedProviderSettings, writeAgentPersona } from './support/model-selection-fixture.js'

function gate() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
async function anotherView(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window')
  await page.getByRole('button', { name: 'Open in new window', exact: true }).click()
  const next = await opened
  await expect(next.getByRole('button', { name: 'Edit session title' })).toHaveText('Concurrent shared chat')
  return next
}
async function providerDiagnostics(workspace: string) {
  const entries = await fs.readdir(workspace, { recursive: true })
  const files = entries.filter((entry) => entry.endsWith('.jsonl') && entry.includes('/provider-turns/'))
  const records = []
  for (const file of files) records.push(...parseProviderTurnDiagnosticRecords(await fs.readFile(path.join(workspace, file), 'utf8')))
  return records
}

async function assertNoPaidCli(workspace: string): Promise<void> {
  const entries = await fs.readdir(workspace, { recursive: true })
  for (const entry of entries.filter((entry) => entry.endsWith('journal.jsonl') && entry.includes('assignments/'))) {
    const lines = (await fs.readFile(path.join(workspace, entry), 'utf8')).trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const value: unknown = JSON.parse(line)
      const encoded = JSON.stringify(value)
      expect(encoded).not.toMatch(/"requestedProvider"\s*:\s*"(?:codex|claude)"/)
    }
  }
}

test('J5 shared views stay locked during a reply and can send again when it finishes', async ({}, info) => {
  const finishA = gate()
  const finishB = gate()
  // The nondeterministic paid provider is replaced only at its HTTP boundary.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (r) => r.stream && (r.userMessage?.includes('Window A request') ?? false), deltas: ['Alpha opening', ' alpha final'], deltaGates: [Promise.resolve(), finishA.promise], gate: finishA.promise },
    { match: (r) => r.stream && (r.userMessage?.includes('Window B request') ?? false), deltas: ['Beta opening', ' beta final'], deltaGates: [Promise.resolve(), finishB.promise], gate: finishB.promise },
    { content: 'Fixture complete' },
  ] })
  const workspacePath = info.outputPath('workspace')
  const projectRoot = info.outputPath('project')
  const userDataPath = info.outputPath('user')
  await seedProviderSettings({ userDataPath, baseUrl: provider.url, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  await writeAgentPersona(projectRoot, { name: 'general-agent', description: 'Fixture assistant', marker: 'Shared window fixture.', tier: 'orchestration', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  await new FileSystemSessionStore(workspacePath).createSession({ title: 'Concurrent shared chat' })
  const app = await launchDesktop({ userDataPath, workspacePath, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
  try {
    const first = await app.firstWindow()
    await first.getByRole('complementary', { name: 'Primary navigation', exact: true }).getByRole('button', { name: /^Concurrent shared chat\b/ }).click()
    const second = await anotherView(app, first)
    const third = await anotherView(app, first)
    const a = first.getByRole('region', { name: 'Run chat', exact: true })
    const b = second.getByRole('region', { name: 'Run chat', exact: true })
    const c = third.getByRole('region', { name: 'Run chat', exact: true })
    await a.getByRole('textbox').fill('Window A request')
    await a.getByRole('textbox').press('Enter')
    await expect(a).toContainText('Alpha opening')
    await expect(b.getByRole('textbox')).toBeDisabled()
    await expect(b.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible()
    finishA.release()
    await expect(b.getByRole('textbox')).toBeEnabled()
    await b.getByRole('textbox').fill('Window B request')
    await b.getByRole('textbox').press('Enter')
    await expect(b).toContainText('Beta opening')
    await expect(a).toContainText('Beta opening', { timeout: 2000 })
    await expect(b).toContainText('Alpha opening')
    await expect(c).toContainText('Alpha opening')
    await expect(c).toContainText('Beta opening')
    finishA.release()
    finishB.release()
    for (const chat of [a, b, c]) {
      await expect(chat.getByText('Alpha opening alpha final', { exact: true })).toBeVisible()
      await expect(chat.getByText('Beta opening beta final', { exact: true })).toBeVisible()
    }
  } finally {
    finishA.release()
    finishB.release()
    await app.close()
    await provider.close()
    await assertNoPaidCli(workspacePath)
  }
})

async function pair(info: import('@playwright/test').TestInfo, baseUrl: string) {
  const workspacePath = info.outputPath('workspace')
  const projectRoot = info.outputPath('project')
  const userDataPath = info.outputPath('user')
  await seedProviderSettings({ userDataPath, baseUrl, kind: 'lm-studio', defaultModel: APP_DEFAULT_MODEL })
  await writeAgentPersona(projectRoot, { name: 'general-agent', description: 'Fixture assistant', marker: 'Shared window fixture.', tier: 'orchestration', provider: FIXTURE_PROVIDER, model: APP_DEFAULT_MODEL.id })
  const store = new FileSystemSessionStore(workspacePath)
  await store.createSession({ title: 'Concurrent shared chat' })
  const app = await launchDesktop({ userDataPath, workspacePath, env: desktopEnvironment({ projectRoot, userDataPath, workspacePath }) })
  const first = await app.firstWindow()
  await first.getByRole('complementary', { name: 'Primary navigation', exact: true }).getByRole('button', { name: /^Concurrent shared chat\b/ }).click()
  const second = await anotherView(app, first)
  return { app, first, second, store, workspacePath }
}

test('J5 Stop unlocks both views before another turn can start', async ({}, info) => {
  const finishA = gate()
  const finishB = gate()
  // Provider latency is nondeterministic; control only the HTTP response stream.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (r) => r.stream && (r.userMessage?.includes('Window A request') ?? false), deltas: ['Alpha opening', ' alpha final'], deltaGates: [Promise.resolve(), finishA.promise], gate: finishA.promise },
    { match: (r) => r.stream && (r.userMessage?.includes('Window B request') ?? false), deltas: ['Beta opening', ' beta final'], deltaGates: [Promise.resolve(), finishB.promise], gate: finishB.promise },
    { content: 'Fixture complete' },
  ] })
  const fixture = await pair(info, provider.url)
  try {
    const a = fixture.first.getByRole('region', { name: 'Run chat', exact: true })
    const b = fixture.second.getByRole('region', { name: 'Run chat', exact: true })
    await a.getByRole('textbox').fill('Window A request')
    await a.getByRole('textbox').press('Enter')
    await expect(a).toContainText('Alpha opening')
    await expect(b.getByRole('textbox')).toBeDisabled()
    await a.getByRole('button', { name: 'Stop generation', exact: true }).click()
    await expect(b).toContainText('Response cancelled')
    expect(await providerDiagnostics(fixture.workspacePath)).toContainEqual(expect.objectContaining({ kind: 'provider-cancellation', source: 'user-stop' }))
    await expect(b.getByRole('textbox')).toBeEnabled()
    await b.getByRole('textbox').fill('Window B request')
    await b.getByRole('textbox').press('Enter')
    await expect(b).toContainText('Beta opening')
    await expect(a).toContainText('Beta opening')
    // The cancelled provider stays gated; it cannot race a final answer against Stop.
    finishB.release()
    await expect(a.getByText('Beta opening beta final', { exact: true })).toBeVisible()
    await expect(b.getByText('Beta opening beta final', { exact: true })).toBeVisible()
    await expect(a.getByText('Alpha opening alpha final', { exact: true })).toHaveCount(0)
    await expect(b.getByText('Alpha opening alpha final', { exact: true })).toHaveCount(0)
    await expect(a.getByTestId('streaming-reply')).toHaveCount(0)
    await expect(b.getByTestId('streaming-reply')).toHaveCount(0)
  } finally {
    finishA.release(); finishB.release()
    await fixture.app.close(); await provider.close()
    await assertNoPaidCli(fixture.workspacePath)
  }
})

test('J5 a failed provider turn removes its previews in both views and preserves the saved question', async ({}, info) => {
  const finish = gate()
  const requested = gate()
  // Only the failing HTTP provider is replaced. No internal application module is stubbed.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (r) => { const matches = r.stream && (r.userMessage?.includes('Failure request') ?? false); if (matches) requested.release(); return matches }, failStatus: 400, gate: finish.promise },
    { content: 'Fixture complete' },
  ] })
  const fixture = await pair(info, provider.url)
  try {
    const a = fixture.first.getByRole('region', { name: 'Run chat', exact: true })
    const b = fixture.second.getByRole('region', { name: 'Run chat', exact: true })
    await a.getByRole('textbox').fill('Failure request')
    await a.getByRole('textbox').press('Enter')
    await requested.promise
    await expect(b.getByRole('log').getByText('Failure request', { exact: true })).toBeVisible()
    const settled = fixture.second.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/messages'))
    finish.release()
    expect((await settled).ok()).toBe(true)
    await expect(a.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    await expect(a.getByTestId('streaming-reply')).toHaveCount(0)
    await expect(b.getByTestId('streaming-reply')).toHaveCount(0)
    await expect(a.getByRole('log').getByText('Failure request', { exact: true })).toBeVisible()
    await expect(b.getByRole('log').getByText('Failure request', { exact: true })).toBeVisible()
  } finally {
    finish.release(); await fixture.app.close(); await provider.close()
    await assertNoPaidCli(fixture.workspacePath)
  }
})

test('a reopened view locks input and can stop a running turn before its first answer', async ({}, info) => {
  const finish = gate()
  const requested = gate()
  // The paid provider is replaced only at HTTP; the API, stores and cancellation are real.
  const provider = await startFakeChatCompletionsServer({ script: [
    { match: (r) => { const matches = r.stream && (r.userMessage?.includes('Silent request') ?? false); if (matches) requested.release(); return matches }, deltas: ['Late answer'], deltaGates: [finish.promise], gate: finish.promise },
    { content: 'Fixture complete' },
  ] })
  const fixture = await pair(info, provider.url)
  try {
    const a = fixture.first.getByRole('region', { name: 'Run chat', exact: true })
    await a.getByRole('textbox').fill('Silent request')
    await a.getByRole('textbox').press('Enter')
    await requested.promise
    await fixture.second.getByRole('button', { name: 'New chat', exact: true }).click()
    await fixture.second.getByRole('complementary', { name: 'Primary navigation', exact: true }).getByRole('button', { name: /^Concurrent shared chat\b/ }).click()
    const b = fixture.second.getByRole('region', { name: 'Run chat', exact: true })
    await expect(b.getByRole('log').getByText('Silent request', { exact: true })).toBeVisible()
    await expect(b.getByRole('textbox')).toBeDisabled({ timeout: 3000 })
    await b.getByRole('button', { name: 'Stop generation', exact: true }).click()
    await expect(b).toContainText('Response cancelled')
    expect(await providerDiagnostics(fixture.workspacePath)).toContainEqual(expect.objectContaining({ kind: 'provider-cancellation', source: 'user-stop' }))
    await expect(b.getByRole('textbox')).toBeEnabled()
    await expect(a).toContainText('Response cancelled')
    await expect(a.getByTestId('streaming-reply')).toHaveCount(0)
    await expect(b.getByTestId('streaming-reply')).toHaveCount(0)
  } finally {
    finish.release()
    await fixture.app.close()
    await provider.close()
    await assertNoPaidCli(fixture.workspacePath)
  }
})
