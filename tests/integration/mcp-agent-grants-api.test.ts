import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'

const repoRoot = process.cwd()
const stdioFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

test('agent MCP grant API defaults off, persists isolation, and obeys global lifecycle', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agent-grants-'))
  const projectRoot = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  // The workspace directory is the caller's to create: the runtime deliberately
  // refuses to manufacture a path it was merely pointed at, so an enrolled
  // launch fails here rather than inventing the workspace.
  fs.mkdirSync(workspacePath, { recursive: true })
  const settingsPath = path.join(directory, 'mcp-settings.json')
  const lifecyclePath = path.join(directory, 'mcp-lifecycle.jsonl')
  createAgent(projectRoot, 'alpha-agent', 'openai')
  createAgent(projectRoot, 'beta-agent', 'openai')
  createAgent(projectRoot, 'cli-agent', 'gemini')
  const originalPersona = fs.readFileSync(
    path.join(projectRoot, 'agents', 'alpha-agent', 'alpha-agent.md'),
    'utf8',
  )

  let server: StartedApiServer | null = null
  try {
    server = await startGrantApi({
      projectRoot,
      workspacePath,
      settingsPath,
    })
    const created = await fetch(`${server.url}/settings/mcps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'grant-fixture',
        name: 'Grant fixture',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [stdioFixturePath],
          cwd: repoRoot,
          secretEnvironment: {
            MCP_FIXTURE_LIFECYCLE_PATH: {
              operation: 'replace',
              value: lifecyclePath,
            },
          },
        },
      }),
    })
    assert.equal(created.status, 201)
    const validated = await fetch(
      `${server.url}/settings/mcps/grant-fixture/validate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stdioTrustAcknowledged: true }),
      },
    )
    assert.equal(validated.status, 200)
    await waitForEventCount(lifecyclePath, 'ready', 1)

    const alphaInitial = await listGrants(server.url, 'alpha-agent')
    assert.equal(alphaInitial.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await grantPayload(alphaInitial), {
      servers: [
        {
          id: 'grant-fixture',
          name: 'Grant fixture',
          transport: 'stdio',
          status: 'connected',
          enabled: true,
          granted: false,
          compatible: true,
          providerSupportMode: 'native-tool-loop',
        },
      ],
    })

    const grantAlpha = await setGrant(server.url, 'alpha-agent', true)
    assert.equal(grantAlpha.status, 200)
    assert.equal((await grantView(grantAlpha)).granted, true)
    assert.equal(
      (await grantPayload(await listGrants(server.url, 'beta-agent')))
        .servers[0]?.granted,
      false,
    )

    const incompatible = await grantPayload(
      await listGrants(server.url, 'cli-agent'),
    )
    assert.equal(incompatible.servers[0]?.compatible, false)
    assert.match(incompatible.servers[0]?.reason ?? '', /does not yet support/i)
    const incompatiblePatch = await setGrant(server.url, 'cli-agent', true)
    assert.equal(incompatiblePatch.status, 409)
    assert.match(await incompatiblePatch.text(), /does not yet support/i)

    const malformedPatch = await fetch(
      `${server.url}/create/agents/alpha-agent/mcp-grants`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serverId: 'grant-fixture',
          enabled: true,
          unexpected: true,
        }),
      },
    )
    assert.equal(malformedPatch.status, 400)
    assert.equal(
      (await fetch(
        `${server.url}/create/agents/alpha-agent%252Fescape/mcp-grants`,
      )).status,
      400,
    )

    await server.close()
    server = null
    await waitForEventCount(lifecyclePath, 'stopped', 1)
    server = await startGrantApi({
      projectRoot,
      workspacePath,
      settingsPath,
    })
    await waitForEventCount(lifecyclePath, 'ready', 2)
    assert.equal(
      (await grantPayload(await listGrants(server.url, 'alpha-agent')))
        .servers[0]?.granted,
      true,
    )

    const disabled = await fetch(
      `${server.url}/settings/mcps/grant-fixture`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    )
    assert.equal(disabled.status, 200)
    await waitForEventCount(lifecyclePath, 'stopped', 2)
    assert.deepEqual(
      await grantPayload(await listGrants(server.url, 'alpha-agent')),
      { servers: [] },
    )

    const reenabled = await fetch(
      `${server.url}/settings/mcps/grant-fixture`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    )
    assert.equal(reenabled.status, 200)
    await waitForEventCount(lifecyclePath, 'ready', 3)
    assert.equal(
      (await grantPayload(await listGrants(server.url, 'alpha-agent')))
        .servers[0]?.granted,
      true,
    )

    const revoke = await setGrant(server.url, 'alpha-agent', false)
    assert.equal(revoke.status, 200)
    assert.equal((await grantView(revoke)).granted, false)
    await setGrant(server.url, 'alpha-agent', true)
    assert.equal(fs.readFileSync(
      path.join(projectRoot, 'agents', 'alpha-agent', 'alpha-agent.md'),
      'utf8',
    ), originalPersona)
    const deleteAgent = await fetch(
      `${server.url}/create/agents/alpha-agent`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteSkills: false }),
      },
    )
    assert.equal(deleteAgent.status, 200)
    assert.equal(fs.existsSync(
      path.join(projectRoot, 'agents', 'alpha-agent'),
    ), false)
    assert.deepEqual(
      (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
        agentGrants: unknown[]
      }).agentGrants,
      [],
    )

    const deleted = await fetch(
      `${server.url}/settings/mcps/grant-fixture`,
      { method: 'DELETE' },
    )
    assert.equal(deleted.status, 204)
    await waitForEventCount(lifecyclePath, 'stopped', 3)
    assert.equal(
      (await listGrants(server.url, 'alpha-agent')).status,
      404,
    )

    const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      agentGrants: unknown[]
    }
    assert.deepEqual(persisted.agentGrants, [])
  } finally {
    await server?.close().catch(() => undefined)
    const events = readLifecycle(lifecyclePath)
    for (const pid of new Set(events.map((event) => event.pid))) {
      assert.equal(isProcessAlive(pid), false, `MCP fixture PID ${pid} remained alive`)
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function startGrantApi(params: {
  projectRoot: string
  workspacePath: string
  settingsPath: string
}): Promise<StartedApiServer> {
  return startApiServer({
    store: new FileSystemRunStore(params.workspacePath),
    launcher: new PiRunLauncher(),
    repoRootPath: params.projectRoot,
    workspacePath: params.workspacePath,
    mcpSettingsService: new McpSettingsService({
      storagePath: params.settingsPath,
      secretCodec: {
        encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
        decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
      },
      clientManager: new McpClientManager({
        connectTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        closeTimeoutMs: 1_000,
      }),
    }),
  })
}

function createAgent(root: string, name: string, provider: string): void {
  const directory = path.join(root, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      'tier: strategic',
      `provider: ${provider}`,
      'model: fixture-model',
      'thinking: low',
      '---',
      '',
      `# ${name}`,
      '',
      'Fixture agent.',
      '',
    ].join('\n'),
    'utf8',
  )
}

function listGrants(baseUrl: string, agentName: string): Promise<Response> {
  return fetch(
    `${baseUrl}/create/agents/${encodeURIComponent(agentName)}/mcp-grants`,
  )
}

function setGrant(
  baseUrl: string,
  agentName: string,
  enabled: boolean,
): Promise<Response> {
  return fetch(
    `${baseUrl}/create/agents/${encodeURIComponent(agentName)}/mcp-grants`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'grant-fixture', enabled }),
    },
  )
}

interface GrantView {
  id: string
  name: string
  transport: 'stdio' | 'streamable-http'
  status: string
  enabled: boolean
  granted: boolean
  compatible: boolean
  reason?: string
}

function grantPayload(response: Response): Promise<{ servers: GrantView[] }> {
  assert.equal(response.status, 200)
  return response.json() as Promise<{ servers: GrantView[] }>
}

function grantView(response: Response): Promise<GrantView> {
  return response.json() as Promise<GrantView>
}

interface LifecycleEvent {
  event: 'ready' | 'stopped'
  pid: number
}

function readLifecycle(filePath: string): LifecycleEvent[] {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LifecycleEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitForEventCount(
  filePath: string,
  event: LifecycleEvent['event'],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (readLifecycle(filePath).filter((entry) => entry.event === event).length >= count) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for ${count} ${event} events`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
