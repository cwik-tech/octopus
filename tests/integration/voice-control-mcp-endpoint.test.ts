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

const TEST_NONEXISTENT_PID = 2_147_483_647

interface VoiceServerFixture {
  readonly server: StartedApiServer
  readonly apiToken: string
  readonly mcpToken: string
  readonly discoveryDir: string
  readonly workspacePath: string
  readonly descriptorPath: string
}

function writeWorkflowRegistry(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const registryPath = path.join(dir, 'registry.yaml')
  fs.writeFileSync(
    registryPath,
    [
      'market-research:',
      '  description: Research a market from an uploaded brief.',
      '  template_path: ./market-research.yaml',
      'weekly-summary:',
      '  description: Write a weekly summary for the team.',
      '  template_path: ./weekly-summary.yaml',
      '',
    ].join('\n'),
  )
  for (const id of ['market-research', 'weekly-summary']) {
    fs.writeFileSync(
      path.join(dir, `${id}.yaml`),
      [
        'workflow:',
        `  id: ${id}`,
        '  description: Test workflow.',
        '  input:',
        '    artifact: incoming-brief.md',
        '  steps:',
        '    - id: write',
        '      type: team',
        '      team: writing-team',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: final-draft.md',
        '  output:',
        '    from_step: write',
        '    artifact: final-draft.md',
        '  on_blocked: stop',
        '  on_failed: stop',
        '',
      ].join('\n'),
    )
  }
  return registryPath
}

async function withVoiceServer(
  fn: (fixture: VoiceServerFixture) => Promise<void>,
): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-mcp-')))
  const workspacePath = path.join(root, 'workspace')
  const discoveryDir = path.join(root, 'voice-control')
  fs.mkdirSync(workspacePath, { recursive: true })
  const registryPath = writeWorkflowRegistry(path.join(root, 'workflows'))
  const apiToken = randomBytes(32).toString('base64url')
  const mcpToken = randomBytes(32).toString('base64url')
  const server = await startApiServer({
    apiToken,
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: workspacePath }
      },
    },
    taskLauncher: {
      async startRun(request) {
        return { launched: true as const, pid: TEST_NONEXISTENT_PID, cwd: request.cwd }
      },
    },
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    repoRootPath: process.cwd(),
    workflowsRegistryPath: registryPath,
    voiceControl: { mcpToken, discoveryDir },
  })
  try {
    await fn({
      server,
      apiToken,
      mcpToken,
      discoveryDir,
      workspacePath,
      descriptorPath: path.join(discoveryDir, 'apps', 'octopus.json'),
    })
  } finally {
    // A test may have closed it already; a finished shutdown is not repeated.
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function readDescriptor(descriptorPath: string) {
  const parsed = voiceControlDescriptorSchema.safeParse(
    JSON.parse(fs.readFileSync(descriptorPath, 'utf8')),
  )
  assert.ok(parsed.success, 'the descriptor matches the voice-control contract')
  return parsed.data
}

async function connectFromDescriptor(descriptorPath: string): Promise<Client> {
  const descriptor = readDescriptor(descriptorPath)
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.mcp.url), {
    requestInit: { headers: { ...descriptor.mcp.headers } },
  })
  const client = new Client({ name: 'voice-layer-test', version: '1.0.0' })
  await client.connect(new ExactOptionalMcpTransport(transport))
  return client
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '1.0.0' },
    },
  })
}

function mcpUrl(server: StartedApiServer): string {
  return `http://${server.host}:${server.port}/_pipeline-mcp`
}

test('an MCP client that reads the descriptor lists the workflows from the registry', async () => {
  await withVoiceServer(async ({ descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const result = await client.callTool({ name: 'list_workflows', arguments: {} })

      assert.notEqual(result.isError, true)
      const structured = result.structuredContent as { workflows?: { id: string }[] } | undefined
      assert.deepEqual(
        structured?.workflows?.map((workflow) => workflow.id),
        ['market-research', 'weekly-summary'],
      )
      const content = result.content as { type: string; text?: string }[]
      assert.equal(content[0]?.type, 'text')
      assert.match(content[0]?.text ?? '', /2 workflows/)
    } finally {
      await client.close()
    }
  })
})

test('every tool carries a title and annotations the voice layer can read', async () => {
  await withVoiceServer(async ({ descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const { tools } = await client.listTools()
      assert.ok(tools.length > 0)
      for (const tool of tools) {
        assert.ok(tool.title, `${tool.name} has a title`)
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`)
        assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`)
      }
    } finally {
      await client.close()
    }
  })
})

test('the MCP path refuses a wrong token with 401', async () => {
  await withVoiceServer(async ({ server }) => {
    const response = await fetch(mcpUrl(server), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${randomBytes(32).toString('base64url')}`,
      },
      body: initializeBody(),
    })
    assert.equal(response.status, 401)
  })
})

test('the MCP path refuses the API token', async () => {
  await withVoiceServer(async ({ server, apiToken }) => {
    const response = await fetch(mcpUrl(server), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${apiToken}`,
      },
      body: initializeBody(),
    })
    assert.equal(response.status, 401)
  })
})

test('the MCP token is refused on REST routes', async () => {
  await withVoiceServer(async ({ server, mcpToken, apiToken }) => {
    const base = `http://${server.host}:${server.port}`
    const asPath = await fetch(`${base}/_pipeline/${encodeURIComponent(mcpToken)}/workflows`)
    assert.equal(asPath.status, 401)
    const asHeader = await fetch(`${base}/workflows`, {
      headers: { authorization: `Bearer ${mcpToken}` },
    })
    assert.equal(asHeader.status, 401)
    // The API token still works, so the refusals above are about the MCP token.
    const withApiToken = await fetch(`${base}/_pipeline/${encodeURIComponent(apiToken)}/workflows`)
    assert.equal(withApiToken.status, 200)
  })
})

test('the MCP path refuses a request with an Origin header', async () => {
  await withVoiceServer(async ({ server, mcpToken }) => {
    const response = await fetch(mcpUrl(server), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${mcpToken}`,
        origin: 'http://127.0.0.1:5173',
      },
      body: initializeBody(),
    })
    assert.equal(response.status, 403)
  })
})

test('the descriptor is private while the server runs and gone after shutdown', async () => {
  await withVoiceServer(async ({ server, descriptorPath, mcpToken }) => {
    const descriptor = readDescriptor(descriptorPath)
    assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600)
    assert.equal(descriptor.appId, 'octopus')
    assert.equal(descriptor.role, 'app')
    assert.equal(descriptor.pid, process.pid)
    assert.equal(descriptor.mcp.url, mcpUrl(server))
    assert.deepEqual(descriptor.mcp.headers, { Authorization: `Bearer ${mcpToken}` })

    await server.close()

    assert.equal(fs.existsSync(descriptorPath), false)
  })
})

async function restJson(server: StartedApiServer, method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${server.url}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  assert.ok(response.status < 300, `${method} ${route} answered ${response.status}`)
  return response.json()
}

function structuredOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content))
  const structured = result.structuredContent
  assert.ok(isRecord(structured), 'the result carries structuredContent')
  return structured
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('list_teams and list_agents name what the window lists', async () => {
  await withVoiceServer(async ({ server, descriptorPath }) => {
    const restTeams = (await restJson(server, 'GET', '/create/team-builder/teams')) as { teams: { id: string }[] }
    const restAgents = (await restJson(server, 'GET', '/create/agents')) as { agents: { name: string }[] }
    assert.ok(restTeams.teams.length > 0, 'the repository has teams to list')
    assert.ok(restAgents.agents.length > 0, 'the repository has agents to list')

    const client = await connectFromDescriptor(descriptorPath)
    try {
      const teams = structuredOf(await client.callTool({ name: 'list_teams', arguments: {} }))
      const agents = structuredOf(await client.callTool({ name: 'list_agents', arguments: {} }))

      assert.deepEqual(
        (teams.teams as { id: string }[]).map((team) => team.id),
        restTeams.teams.map((team) => team.id),
      )
      assert.deepEqual(
        (agents.agents as { name: string }[]).map((agent) => agent.name),
        restAgents.agents.map((agent) => agent.name),
      )
    } finally {
      await client.close()
    }
  })
})

test('list_sessions includes a chat created in the window', async () => {
  await withVoiceServer(async ({ server, descriptorPath }) => {
    const created = (await restJson(server, 'POST', '/sessions', { title: 'Voice planning' })) as { id: string }

    const client = await connectFromDescriptor(descriptorPath)
    try {
      const result = await client.callTool({ name: 'list_sessions', arguments: {} })
      const sessions = structuredOf(result).sessions as { id: string; title: string }[]
      assert.deepEqual(
        sessions.find((session) => session.id === created.id),
        { id: created.id, title: 'Voice planning' },
      )
      const content = result.content as { type: string; text?: string }[]
      assert.match(content[0]?.text ?? '', /Voice planning/)
    } finally {
      await client.close()
    }
  })
})

interface StartedTask {
  readonly sessionId: string
  readonly taskId: string
  readonly status: string
}

async function startWorkflowByVoice(client: Client, sessionId?: string): Promise<StartedTask> {
  const result = await client.callTool({
    name: 'start_workflow',
    arguments: {
      ...(sessionId === undefined ? {} : { sessionId }),
      workflowId: 'market-research',
      brief: 'Research the market for oat milk in Poland.',
    },
  })
  const structured = structuredOf(result)
  assert.equal(typeof structured.taskId, 'string')
  assert.equal(typeof structured.sessionId, 'string')
  assert.equal(typeof structured.status, 'string')
  return {
    sessionId: String(structured.sessionId),
    taskId: String(structured.taskId),
    status: String(structured.status),
  }
}

test('start_workflow returns a task at once, and get_task later reports done', async () => {
  await withVoiceServer(async ({ descriptorPath, workspacePath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      // Act: start work by voice. It answers before the work runs.
      const started = await startWorkflowByVoice(client)
      assert.equal(started.status, 'queued')

      // The worker process finishes and records that through its own store.
      const workerStore = new FileSystemSessionStore(workspacePath)
      const finished = await workerStore.updateTaskRecord(started.sessionId, started.taskId, {
        status: 'done',
        completedAt: new Date().toISOString(),
      })
      assert.equal(finished?.status, 'done')

      // Assert: asking about the task now reports it done.
      const result = await client.callTool({
        name: 'get_task',
        arguments: { sessionId: started.sessionId, taskId: started.taskId },
      })
      const task = structuredOf(result).task as { id: string; status: string; workflowId: string }
      assert.equal(task.id, started.taskId)
      assert.equal(task.status, 'done')
      assert.equal(task.workflowId, 'market-research')
      const content = result.content as { type: string; text?: string }[]
      assert.match(content[0]?.text ?? '', /done/)
    } finally {
      await client.close()
    }
  })
})

test('create_session makes a chat that start_workflow can use', async () => {
  await withVoiceServer(async ({ server, descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const created = structuredOf(await client.callTool({
        name: 'create_session',
        arguments: { title: 'Oat milk research' },
      }))
      const session = created.session as { id: string; title: string }
      assert.equal(session.title, 'Oat milk research')

      const started = await startWorkflowByVoice(client, session.id)
      assert.equal(started.sessionId, session.id)

      const restTasks = (await restJson(server, 'GET', `/sessions/${session.id}/tasks`)) as { tasks: { id: string }[] }
      assert.deepEqual(restTasks.tasks.map((task) => task.id), [started.taskId])
    } finally {
      await client.close()
    }
  })
})

test('list_tasks names the tasks in a chat', async () => {
  await withVoiceServer(async ({ descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const started = await startWorkflowByVoice(client)
      const listed = structuredOf(await client.callTool({
        name: 'list_tasks',
        arguments: { sessionId: started.sessionId },
      }))
      assert.deepEqual(
        (listed.tasks as { id: string }[]).map((task) => task.id),
        [started.taskId],
      )
    } finally {
      await client.close()
    }
  })
})

test('cancel_task cancels the task and is marked destructive', async () => {
  await withVoiceServer(async ({ server, descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const { tools } = await client.listTools()
      const cancelTool = tools.find((tool) => tool.name === 'cancel_task')
      assert.equal(cancelTool?.annotations?.destructiveHint, true)

      const started = await startWorkflowByVoice(client)
      const result = await client.callTool({
        name: 'cancel_task',
        arguments: { sessionId: started.sessionId, taskId: started.taskId },
      })
      assert.equal((structuredOf(result).task as { status: string }).status, 'cancelled')

      const restTask = (await restJson(server, 'GET', `/sessions/${started.sessionId}/tasks/${started.taskId}`)) as { status: string }
      assert.equal(restTask.status, 'cancelled')
    } finally {
      await client.close()
    }
  })
})

test('a refusal from the route comes back as a spoken error, not a crash', async () => {
  await withVoiceServer(async ({ descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const result = await client.callTool({
        name: 'get_task',
        arguments: {
          sessionId: '00000000-0000-4000-8000-000000000000',
          taskId: '00000000-0000-4000-8000-000000000001',
        },
      })
      assert.equal(result.isError, true)
      const content = result.content as { type: string; text?: string }[]
      assert.match(content[0]?.text ?? '', /not found/i)
    } finally {
      await client.close()
    }
  })
})

test('start_team starts the named team on a brief', async () => {
  await withVoiceServer(async ({ server, descriptorPath }) => {
    const restTeams = (await restJson(server, 'GET', '/create/team-builder/teams')) as { teams: { id: string }[] }
    const teamId = restTeams.teams[0]?.id
    assert.ok(teamId, 'the repository has a team to start')
    const client = await connectFromDescriptor(descriptorPath)
    try {
      const result = await client.callTool({
        name: 'start_team',
        arguments: { teamId, brief: 'Summarise the oat milk market.' },
      })
      const structured = structuredOf(result)
      const restTask = (await restJson(
        server,
        'GET',
        `/sessions/${String(structured.sessionId)}/tasks/${String(structured.taskId)}`,
      )) as { teamId?: string }
      assert.equal(restTask.teamId, teamId)
    } finally {
      await client.close()
    }
  })
})

test('session and task IDs that are not UUIDs are refused before any request is made', async () => {
  await withVoiceServer(async ({ descriptorPath }) => {
    const client = await connectFromDescriptor(descriptorPath)
    try {
      // `..` survives encodeURIComponent, and the URL parser would resolve it,
      // so a tool request could leave /sessions with the API token attached.
      for (const [name, args] of [
        ['get_task', { sessionId: '..', taskId: '..' }],
        ['cancel_task', { sessionId: '..', taskId: '00000000-0000-4000-8000-000000000001' }],
        ['list_tasks', { sessionId: '.' }],
        ['start_workflow', { sessionId: '..', workflowId: 'market-research', brief: 'x' }],
      ] as const) {
        await assert.rejects(
          client.callTool({ name, arguments: args }),
          (error: unknown) => error instanceof Error && /-32602/.test(error.message),
          `${name} must refuse ${JSON.stringify(args)}`,
        )
      }
    } finally {
      await client.close()
    }
  })
})
