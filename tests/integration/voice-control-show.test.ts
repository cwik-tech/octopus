import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { voiceControlDescriptorSchema } from '../../contracts/voice-control.js'
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import type { VoiceControlShowTarget } from '../../server/voice-control/voice-control-runtime.js'

const TEST_NONEXISTENT_PID = 2_147_483_647

/**
 * The desktop's window is the boundary here: the server is handed a function
 * that shows a session, which the Electron main process implements. The test
 * stands in for that window and records what it was asked to show.
 */
async function withShowServer(
  show: ((target: VoiceControlShowTarget) => Promise<void>) | undefined,
  run: (input: { server: StartedApiServer; client: Client }) => Promise<void>,
): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-show-')))
  const workspacePath = path.join(root, 'workspace')
  const discoveryDir = path.join(root, 'voice-control')
  fs.mkdirSync(workspacePath, { recursive: true })
  const server = await startApiServer({
    apiToken: randomBytes(32).toString('base64url'),
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: workspacePath }
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath: process.cwd(),
    voiceControl: {
      mcpToken: randomBytes(32).toString('base64url'),
      discoveryDir,
      ...(show === undefined ? {} : { show }),
    },
  })
  let client: Client | undefined
  try {
    const descriptor = voiceControlDescriptorSchema.parse(
      JSON.parse(fs.readFileSync(path.join(discoveryDir, 'apps', 'octopus.json'), 'utf8')),
    )
    const transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), {
      requestInit: { headers: { ...descriptor.mcp.headers } },
    })
    client = new Client({ name: 'voice-layer-test', version: '1.0.0' })
    await client.connect(new ExactOptionalMcpTransport(transport))
    await run({ server, client })
  } finally {
    await client?.close()
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function createSession(server: StartedApiServer, title: string): Promise<string> {
  const response = await fetch(`${server.url}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[]
  return content[0]?.text ?? ''
}

test('show asks the window to open the named session', async () => {
  const shown: VoiceControlShowTarget[] = []
  await withShowServer(async (target) => {
    shown.push(target)
  }, async ({ server, client }) => {
    const sessionId = await createSession(server, 'Oat milk research')

    const result = await client.callTool({ name: 'show', arguments: { sessionId } })

    assert.notEqual(result.isError, true, firstText(result))
    assert.deepEqual(shown, [{ sessionId }])
    assert.match(firstText(result), /Oat milk research/)
  })
})

test('show refuses a session that does not exist and asks the window for nothing', async () => {
  const shown: VoiceControlShowTarget[] = []
  await withShowServer(async (target) => {
    shown.push(target)
  }, async ({ client }) => {
    const result = await client.callTool({
      name: 'show',
      arguments: { sessionId: '00000000-0000-4000-8000-000000000000' },
    })

    assert.equal(result.isError, true)
    assert.deepEqual(shown, [])
  })
})

test('show says so when Octopus has no window', async () => {
  await withShowServer(undefined, async ({ server, client }) => {
    const sessionId = await createSession(server, 'Headless')

    const result = await client.callTool({ name: 'show', arguments: { sessionId } })

    assert.equal(result.isError, true)
    assert.match(firstText(result), /no window/i)
  })
})
