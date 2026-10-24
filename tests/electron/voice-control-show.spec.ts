/**
 * A voice layer can bring Octopus forward with a chat open.
 *
 * The journey crosses every boundary `show` depends on: the descriptor the
 * desktop writes, the MCP endpoint, the main process focusing its window, and
 * the renderer opening the session it is told to. Nothing in it sends a model
 * turn, so no provider is involved.
 */
import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod/v4'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { launchDesktop } from './support/desktop-launch.js'

const createdSessionSchema = z.object({ session: z.object({ id: z.uuid(), title: z.string() }) })

test('a voice layer opens a chat in Octopus with show', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-show-desktop-'))
  const userDataPath = path.join(root, 'user-data')
  const workspacePath = path.join(root, 'workspace')
  const discoveryDir = path.join(root, 'voice-control')
  const app = await launchDesktop({
    userDataPath,
    workspacePath,
    env: { OCTOPUS_VOICE_CONTROL_DIR: discoveryDir },
  })
  let client: Client | undefined
  let transport: StreamableHTTPClientTransport | undefined
  try {
    const page = await app.firstWindow()

    // The voice layer finds Octopus through the descriptor the desktop wrote.
    const descriptor = voiceControlDescriptorSchema.parse(
      JSON.parse(await fs.readFile(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8')),
    )
    transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), {
      requestInit: { headers: { ...descriptor.mcp.headers } },
    })
    client = new Client({ name: 'voice-layer-journey', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport))

    const created = await client.callTool({ name: 'create_session', arguments: { title: 'Voice journey' } })
    const payload: unknown = created.structuredContent
    const sessionId = createdSessionSchema.parse(payload).session.id
    const titleButton = page.getByRole('button', { name: 'Edit session title' })
    await expect(titleButton).not.toHaveText('Voice journey')

    // Act: "show me that chat".
    const shown = await client.callTool({ name: 'show', arguments: { sessionId } })
    expect(shown.isError).not.toBe(true)

    // Assert: the window is up and the chat is the one open.
    await expect(titleButton).toHaveText('Voice journey')
    const windowState = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
      return window ? { visible: window.isVisible(), minimized: window.isMinimized() } : null
    })
    expect(windowState?.minimized).toBe(false)
    // A headless run never shows its window, by design (electron/main.ts), so
    // being brought forward is checked only in a visible-window run.
    if (process.env.PIPELINE_DESKTOP_E2E_HEADLESS === '0') {
      expect(windowState?.visible).toBe(true)
    }
  } finally {
    await transport?.terminateSession().catch(() => undefined)
    await client?.close().catch(() => undefined)
    await app.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
