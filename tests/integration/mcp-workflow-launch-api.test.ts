import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { SessionTaskRunnerLauncher } from '../../domains/sessions/session-task-launcher.js'

const repoRootPath = process.cwd()
const fixturePath = path.join(
  repoRootPath,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)
const codec: McpSecretCodec = {
  encrypt(value) {
    return Buffer.from(value, 'utf8').toString('base64')
  },
  decrypt(value) {
    return Buffer.from(value, 'base64').toString('utf8')
  },
}

test('sessions API blocks unmet MCP requirements before launch and retries the same plan after a real grant', { timeout: 20_000 }, async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-api-'))
  const workflowPath = path.join(workspacePath, 'mcp-workflow.yaml')
  const registryPath = path.join(workspacePath, 'workflows.yaml')
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = '1'
  fs.writeFileSync(workflowPath, workflowYaml())
  fs.writeFileSync(
    registryPath,
    `mcp-writing:\n  template_path: ${JSON.stringify(workflowPath)}\n`,
  )

  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const settingsService = new McpSettingsService({
    storagePath: path.join(workspacePath, 'mcp-settings.json'),
    secretCodec: codec,
    clientManager: manager,
  })
  await settingsService.saveServer({
    id: 'documents-server',
    name: 'Document tools',
    capabilityAliases: [{ capability: 'documents', access: 'any' }],
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      cwd: repoRootPath,
    },
  })
  await settingsService.validateServer('documents-server', {
    stdioTrustAcknowledged: true,
  })

  const sessionStore = new FileSystemSessionStore(workspacePath)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        throw new Error('Top-level run launcher is not used by this test')
      },
    },
    taskLauncher: new SessionTaskRunnerLauncher(repoRootPath),
    sessionStore,
    workflowsRegistryPath: registryPath,
    repoRootPath,
    workspacePath,
    mcpSettingsService: settingsService,
    mcpProviderSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
  })

  try {
    const createResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'MCP launch' }),
    })
    assert.equal(createResponse.status, 201)
    const session = await createResponse.json() as { id: string }

    const blockedResponse = await fetch(
      `${server.url}/sessions/${session.id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'mcp-writing',
          brief: 'Draft a concise warehouse automation strategy memo.',
        }),
      },
    )
    assert.equal(blockedResponse.status, 409)
    const blocked = await blockedResponse.json() as {
      retryable: boolean
      diagnostics: Array<{
        stepId: string
        capability: string
        access: string[]
        necessity: string
        eligibleAgentPaths: string[]
      }>
      plan: { id: string; status: string }
    }
    assert.equal(blocked.retryable, true)
    assert.equal(blocked.plan.status, 'ready')
    assert.equal(blocked.diagnostics.length, 1)
    assert.deepEqual(blocked.diagnostics[0], {
      code: 'mcp_requirement_unmet',
      retryable: true,
      stepId: 'draft',
      capability: 'documents',
      access: ['read', 'write'],
      necessity: 'required',
      eligibleAgentPaths: [
        'agents/brief-builder',
        'agents/editor',
        'agents/writer',
      ],
      message:
        "Step 'draft' has no eligible scheduled agent with required read+write access to MCP capability 'documents'. Eligible agent paths: agents/brief-builder, agents/editor, agents/writer.",
    })
    const blockedTasksResponse = await fetch(
      `${server.url}/sessions/${session.id}/tasks`,
    )
    const blockedTasks = await blockedTasksResponse.json() as { tasks: unknown[] }
    assert.deepEqual(blockedTasks.tasks, [])
    const persistedBlockedPlan = await sessionStore.getRunPlan(session.id)
    assert.equal(persistedBlockedPlan?.id, blocked.plan.id)
    assert.equal(persistedBlockedPlan?.status, 'ready')

    await settingsService.setAgentGrant(
      'agents/writer',
      'documents-server',
      true,
    )
    const launchedResponse = await fetch(
      `${server.url}/sessions/${session.id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'mcp-writing' }),
      },
    )
    assert.equal(launchedResponse.status, 202)
    const task = await launchedResponse.json() as {
      id: string
      runPath: string
      runPlanId: string
      mcpResolutionPath: string
      mcpWarnings: Array<{ capability: string; necessity: string }>
    }
    assert.equal(task.runPlanId, blocked.plan.id)
    assert.equal(task.mcpWarnings.length, 1)
    assert.equal(requiredValue(task.mcpWarnings[0], 'tests/integration/mcp-workflow-launch-api.test.ts:170').capability, 'calendar')
    assert.equal(requiredValue(task.mcpWarnings[0], 'tests/integration/mcp-workflow-launch-api.test.ts:171').necessity, 'optional')
    assert.equal(fs.existsSync(task.mcpResolutionPath), true)
    assert.equal(fs.statSync(task.mcpResolutionPath).mode & 0o222, 0)

    const resolution = JSON.parse(
      fs.readFileSync(task.mcpResolutionPath, 'utf8'),
    ) as {
      authorization: { state: string; brokerRechecksAtCallTime: boolean }
      scheduledAgentPaths: string[]
      scheduledAgents: Array<{
        agentPath: string
        provider: string
        model: string
        supportState: string
      }>
      steps: Array<{
        matches: Array<{
          capability: string
          candidates: Array<{ serverId: string; agentPath: string }>
        }>
      }>
    }
    assert.deepEqual(resolution.authorization, {
      state: 'non-authoritative',
      brokerRechecksAtCallTime: true,
    })
    assert.deepEqual(resolution.scheduledAgentPaths, [
      'agents/brief-builder',
      'agents/editor',
      'agents/writer',
    ])
    assert.ok(
      resolution.scheduledAgents.some(
        (agent) =>
          agent.agentPath === 'agents/writer' &&
          agent.provider === 'codex' &&
          agent.model === 'gpt-5.4' &&
          agent.supportState === 'supported',
      ),
    )
    assert.deepEqual(
      requiredValue(resolution.steps[0], 'tests/integration/mcp-workflow-launch-api.test.ts:212').matches.find(
        (match) => match.capability === 'documents',
      )?.candidates,
      [{
        serverId: 'documents-server',
        serverName: 'Document tools',
        agentPath: 'agents/writer',
        provider: 'codex',
        state: 'supported',
      }],
    )
    assert.doesNotMatch(
      JSON.stringify(resolution),
      /stdio-server|transport|secret|https?:\/\//i,
    )
    const runRecord = JSON.parse(
      fs.readFileSync(path.join(task.runPath, 'run.json'), 'utf8'),
    ) as { paths: { mcpResolution: string } }
    assert.equal(runRecord.paths.mcpResolution, 'mcp-resolution.json')
  } finally {
    await server.close().catch(() => undefined)
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun
    }
    await fs.promises.rm(workspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  }
})

function workflowYaml(): string {
  return [
    'workflow:',
    '  id: mcp-writing',
    '  mcp_requirements:',
    '    - capability: documents',
    '      access: read',
    '      necessity: required',
    '  steps:',
    '    - id: draft',
    '      type: team',
    '      team: writing-team',
    '      input_artifact: incoming-brief.md',
    '      result_artifact: final-draft.md',
    '      mcp_requirements:',
    '        - capability: documents',
    '          access: write',
    '          necessity: required',
    '        - capability: calendar',
    '          access: write',
    '          necessity: optional',
    '  output:',
    '    from_step: draft',
    '    artifact: final-draft.md',
    '',
  ].join('\n')
}
