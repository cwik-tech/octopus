import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { launchDesktop } from './support/desktop-launch.js'

test('TM12 voice show reuses the matching window and preserves the other window chat', async ({}, info) => {
  const workspacePath = info.outputPath('workspace')
  const discoveryDir = info.outputPath('voice-control')
  const store = new FileSystemSessionStore(workspacePath)
  const alpha = await store.createSession({ title: 'Voice window alpha' })
  const beta = await store.createSession({ title: 'Voice window beta' })
  const app = await launchDesktop({ userDataPath: info.outputPath('user'), workspacePath, env: { OCTOPUS_VOICE_CONTROL_DIR: discoveryDir } })
  const client = new Client({ name: 'multi-window-voice', version: '1.0.0' })
  let transport: StreamableHTTPClientTransport | undefined
  try {
    const first = await app.firstWindow()
    await first.getByRole('complementary', { name: 'Primary navigation', exact: true }).getByRole('button', { name: /^Voice window alpha\b/ }).click()
    await expect(first.getByRole('button', { name: 'Edit session title' })).toHaveText(alpha.title)
    const opened = app.waitForEvent('window')
    await first.getByRole('button', { name: 'Open in new window', exact: true }).click()
    const second = await opened
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText(alpha.title)
    await second.getByRole('complementary', { name: 'Primary navigation', exact: true }).getByRole('button', { name: /^Voice window beta\b/ }).click()
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText(beta.title)
    const input: unknown = JSON.parse(await fs.readFile(path.join(discoveryDir, 'apps/octopus.json'), 'utf8'))
    const descriptor = voiceControlDescriptorSchema.parse(input)
    transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), { requestInit: { headers: { ...descriptor.mcp.headers } } })
    await client.connect(new ExactOptionalMcpTransport(transport))
    expect((await client.callTool({ name: 'show', arguments: { sessionId: alpha.id } })).isError).not.toBe(true)
    await expect(first.getByRole('button', { name: 'Edit session title' })).toHaveText(alpha.title)
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText(beta.title)
    expect(app.windows()).toHaveLength(2)
    // A new main document has no mounted chat; its former routing hint must disappear.
    const leaving = await app.browserWindow(first)
    await leaving.evaluate((window) => window.loadURL('about:blank'))
    expect((await client.callTool({ name: 'show', arguments: { sessionId: alpha.id } })).isError).not.toBe(true)
    await expect(second.getByRole('button', { name: 'Edit session title' })).toHaveText(alpha.title)
    expect(first.url()).toBe('about:blank')
  } finally { await transport?.terminateSession().catch(() => undefined); await client.close(); await app.close() }
})
