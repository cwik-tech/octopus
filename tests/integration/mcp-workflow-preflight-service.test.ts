import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import {
  createMcpProviderSupportResolver,
  type McpProviderConnectionReader,
} from '../../domains/mcp/mcp-provider-support.js'
import { WorkflowMcpPreflightService } from '../../services/workflow-mcp-preflight-service.js'
import {
  McpSettingsService,
  type McpSecretCodec,
} from '../../services/mcp-settings-service.js'

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

test('workflow MCP preflight resolves a real server and seals concrete CLI model aliases', { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-preflight-'))
  const manager = new McpClientManager({ connectTimeoutMs: 3_000 })
  const settingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: codec,
    clientManager: manager,
  })
  const service = new WorkflowMcpPreflightService({
    repoRootPath,
    settingsService,
    providerSupportResolver: ({ provider, model }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
      ...(model === 'default' ? { resolvedModel: 'gpt-5.5' } : {}),
    }),
    now: () => new Date('2026-07-12T21:00:00.000Z'),
  })
  const workflowYaml = [
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

  try {
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
    await settingsService.setAgentGrant(
      'agents/writer',
      'documents-server',
      true,
    )

    const resolved = await service.resolve({
      workflowId: 'mcp-writing',
      workflowYaml,
    })

    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.errors, [])
    assert.equal(resolved.warnings.length, 1)
    assert.equal(requiredValue(resolved.warnings[0], 'tests/integration/mcp-workflow-preflight-service.test.ts:111').capability, 'calendar')
    assert.deepEqual(
      requiredValue(resolved.snapshot.steps[0], 'tests/integration/mcp-workflow-preflight-service.test.ts:113').matches.find(
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
    assert.equal(
      resolved.snapshot.scheduledAgents.find(
        (agent) => agent.agentPath === 'agents/writer',
      )?.model,
      'gpt-5.4',
    )
    assert.equal(resolved.snapshot.generatedAt, '2026-07-12T21:00:00.000Z')
    assert.doesNotMatch(
      JSON.stringify(resolved.snapshot),
      /stdio-server|transport|secret|https?:\/\//i,
    )

    await settingsService.setAgentGrant(
      'agents/writer',
      'documents-server',
      false,
    )
    const revoked = await service.resolve({
      workflowId: 'mcp-writing',
      workflowYaml,
    })
    assert.equal(revoked.ok, false)
    assert.equal(requiredValue(revoked.errors[0], 'tests/integration/mcp-workflow-preflight-service.test.ts:146').capability, 'documents')

    await settingsService.setAgentGrant(
      'agents/writer',
      'documents-server',
      true,
    )
    await manager.close('documents-server')
    assert.equal((await settingsService.getServer('documents-server'))?.status, 'connected')
    const staleSettingsOnly = await service.resolve({
      workflowId: 'mcp-writing',
      workflowYaml,
    })
    assert.equal(staleSettingsOnly.ok, false)
    assert.equal(requiredValue(staleSettingsOnly.errors[0], 'tests/integration/mcp-workflow-preflight-service.test.ts:160').capability, 'documents')
  } finally {
    await settingsService.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Deep Research preflight blocks an unsupported managed-browser provider and accepts a resolved CLI model', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-provider-preflight-'))
  const settingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: codec,
  })
  const workflowYaml = fs.readFileSync(
    path.join(repoRootPath, 'workflows', 'templates', 'deep-research-to-document.yaml'),
    'utf8',
  )

  try {
    const blockedService = new WorkflowMcpPreflightService({
      repoRootPath,
      settingsService,
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'unsupported',
        reasonCode: 'cli_model_unavailable',
      }),
    })
    const blocked = await blockedService.resolve({
      workflowId: 'deep-research-report',
      workflowYaml,
    })

    assert.equal(blocked.ok, false)
    assert.equal(blocked.errors.length, 1)
    assert.deepEqual(
      {
        code: blocked.errors[0]?.code,
        retryable: blocked.errors[0]?.retryable,
        stepId: blocked.errors[0]?.stepId,
        agentPath: blocked.errors[0]?.agentPath,
        provider: blocked.errors[0]?.provider,
        model: blocked.errors[0]?.model,
        tool: blocked.errors[0]?.tool,
      },
      {
        code: 'provider_tool_bridge_unavailable',
        retryable: true,
        stepId: 'research',
        agentPath: 'agents/web-researcher',
        provider: 'codex',
        model: 'gpt-5.5',
        tool: 'browser',
      },
    )
    assert.match(blocked.errors[0]?.message ?? '', /configured Codex CLI model/i)

    const readyProviderReader: McpProviderConnectionReader = {
      listConnections: async () => [],
      listCliAgents: async () => [{
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        available: true,
        enabled: true,
        path: '/fixture/codex',
        models: [
          { id: 'default', name: 'Default', enabled: false },
          { id: 'gpt-5.5', name: 'GPT-5.5', enabled: true },
        ],
        mcpBridge: { supported: true },
      }],
      snapshot: async () => ({
        connections: [],
        cliAgents: [],
        catalog: [],
        defaultModel: { provider: 'codex', model: 'gpt-5.5' },
        defaultModelState: {
          status: 'available' as const,
          provider: 'codex',
          model: 'gpt-5.5',
        },
        effortCapabilities: [],
        defaultEffort: 'medium' as const,
      }),
    }
    const readyService = new WorkflowMcpPreflightService({
      repoRootPath,
      settingsService,
      providerSupportResolver:
        createMcpProviderSupportResolver(readyProviderReader),
    })
    const ready = await readyService.resolve({
      workflowId: 'deep-research-report',
      workflowYaml,
    })

    assert.equal(ready.ok, true)
    assert.deepEqual(ready.errors, [])
    assert.equal(
      ready.scheduledAgents.find(
        (agent) => agent.agentPath === 'agents/web-researcher',
      )?.model,
      'gpt-5.5',
    )
  } finally {
    await settingsService.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow MCP preflight recursively resolves only explicitly scheduled nested teams with no requirements', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-nested-'))
  const workspacePath = path.join(directory, 'workspace')
  const rootTeamPath = path.join(directory, 'teams', 'root-team')
  const nestedTeamPath = path.join(directory, 'teams', 'nested-team')
  const nestedAgentPath = path.join(
    directory,
    'agents',
    'nested-writer',
    'nested-writer.md',
  )
  fs.mkdirSync(rootTeamPath, { recursive: true })
  fs.mkdirSync(nestedTeamPath, { recursive: true })
  fs.mkdirSync(path.dirname(nestedAgentPath), { recursive: true })
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'teams.yaml'),
    'root-team:\n  type: team\n  team_path: ./teams/root-team\n  output_artifact: nested-output.md\n',
  )
  fs.writeFileSync(
    nestedAgentPath,
    '---\nprovider: openai\nmodel: gpt-5.4-mini\n---\nNested writer.\n',
  )
  fs.writeFileSync(
    path.join(rootTeamPath, 'team.yaml'),
    teamYaml({
      name: 'root-team',
      agentName: 'nested-team',
      agentType: 'team',
      agentTarget: '../nested-team',
      outputArtifact: 'nested-output.md',
    }),
  )
  fs.writeFileSync(
    path.join(nestedTeamPath, 'team.yaml'),
    teamYaml({
      name: 'nested-team',
      agentName: 'nested-writer',
      agentType: 'agent',
      agentTarget: '../../agents/nested-writer/nested-writer.md',
      outputArtifact: 'nested-output.md',
    }),
  )
  assert.deepEqual(
    parseTeamConfig(path.join(rootTeamPath, 'team.yaml')).errors,
    [],
  )
  assert.deepEqual(
    parseTeamConfig(path.join(nestedTeamPath, 'team.yaml')).errors,
    [],
  )
  const settingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: codec,
  })
  const service = new WorkflowMcpPreflightService({
    repoRootPath: directory,
    settingsService,
  })

  try {
    const resolved = await service.resolve({
      workflowId: 'nested-workflow',
      workflowYaml: [
        'workflow:',
        '  id: nested-workflow',
        '  steps:',
        '    - id: nested-step',
        '      type: team',
        '      team: root-team',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: nested-output.md',
        '  output:',
        '    from_step: nested-step',
        '    artifact: nested-output.md',
        '',
      ].join('\n'),
    })

    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.errors, [])
    assert.deepEqual(resolved.warnings, [])
    assert.deepEqual(resolved.scheduledAgentPaths, ['agents/nested-writer'])
    assert.deepEqual(
      resolved.snapshot.scheduledAgentPaths,
      ['agents/nested-writer'],
    )
    assert.deepEqual(resolved.snapshot.scheduledAgents, [{
      agentPath: 'agents/nested-writer',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      supportState: 'supported',
    }])
  } finally {
    await settingsService.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow MCP preflight schedules only the explicitly selected hosted agent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-agent-'))
  const settingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: codec,
  })
  const service = new WorkflowMcpPreflightService({
    repoRootPath,
    settingsService,
  })

  try {
    const resolved = await service.resolve({
      workflowId: 'agent-workflow',
      workflowYaml: [
        'workflow:',
        '  id: agent-workflow',
        '  steps:',
        '    - id: draft',
        '      type: agent',
        '      team: writing-team',
        '      agent: writer',
        '      stage_type: chain',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: draft-result.md',
        '  output:',
        '    from_step: draft',
        '    artifact: draft-result.md',
        '',
      ].join('\n'),
    })

    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.scheduledAgentPaths, ['agents/writer'])
    assert.equal(resolved.snapshot.scheduledAgents.length, 1)
    assert.equal(resolved.snapshot.scheduledAgents[0]?.agentPath, 'agents/writer')
  } finally {
    await settingsService.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow MCP preflight skips deterministic publication transforms without losing callable agents', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-transform-'))
  const settingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: codec,
  })
  const service = new WorkflowMcpPreflightService({
    repoRootPath,
    settingsService,
  })

  try {
    const resolved = await service.resolve({
      workflowId: 'writing-with-publication',
      workflowYaml: [
        'workflow:',
        '  id: writing-with-publication',
        '  steps:',
        '    - id: draft',
        '      type: team',
        '      team: writing-team',
        '      input_artifact: incoming-brief.md',
        '      result_artifact: final-draft.md',
        '    - id: publish',
        '      type: transform',
        '      transform: markdown_to_docx',
        '      input_artifact: final-draft.md',
        '      result_artifact: final-report.md',
        '      result_artifacts:',
        '        - final-report.docx',
        '      recovery_policy: idempotent',
        '      handoff:',
        '        from_step: draft',
        '        from_artifact: final-draft.md',
        '        to_artifact: final-draft.md',
        '  output:',
        '    from_step: publish',
        '    artifact: final-report.md',
        '    secondary_artifacts:',
        '      - artifact: final-report.docx',
        '',
      ].join('\n'),
    })

    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.errors, [])
    assert.deepEqual(
      resolved.snapshot.steps.map((step) => step.stepId),
      ['draft'],
    )
    assert.ok(resolved.scheduledAgentPaths.includes('agents/writer'))
    assert.equal(
      resolved.scheduledAgentPaths.some((agentPath) =>
        agentPath.includes('pipeline-transform'),
      ),
      false,
    )
  } finally {
    await settingsService.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow MCP preflight rejects MCP requirements on deterministic transforms', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-transform-requirement-'))
  const settingsService = new McpSettingsService({
    storagePath: path.join(directory, 'mcp-settings.json'),
    secretCodec: codec,
  })
  const service = new WorkflowMcpPreflightService({
    repoRootPath,
    settingsService,
  })

  try {
    await assert.rejects(
      service.resolve({
        workflowId: 'invalid-transform-requirement',
        workflowYaml: [
          'workflow:',
          '  id: invalid-transform-requirement',
          '  steps:',
          '    - id: publish',
          '      type: transform',
          '      transform: markdown_to_docx',
          '      input_artifact: final-draft.md',
          '      result_artifact: final-report.md',
          '      mcp_requirements:',
          '        - capability: documents',
          '          access: write',
          '          necessity: required',
          '  output:',
          '    from_step: publish',
          '    artifact: final-report.md',
          '',
        ].join('\n'),
      }),
      /Workflow transform 'publish' cannot declare MCP requirements/u,
    )
  } finally {
    await settingsService.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function teamYaml(input: {
  name: string
  agentName: string
  agentType: 'agent' | 'team'
  agentTarget: string
  outputArtifact: string
}): string {
  return [
    'team:',
    `  name: ${input.name}`,
    '  description: Test team',
    '  version: 0.1.0',
    'defaults:',
    '  provider: openai',
    'workspace:',
    '  path: ./workspace',
    '  watch: false',
    'workflow:',
    '  entry_level: execute',
    '  invocation_modes:',
    '    - user',
    '    - team',
    '  output_contract:',
    `    completion_artifact: ${input.outputArtifact}`,
    'models:',
    '  strategic:',
    '    model: gpt-5.4-mini',
    '    thinking: medium',
    '    provider: openai',
    'agents:',
    `  - name: ${input.agentName}`,
    `    type: ${input.agentType}`,
    '    role: Test agent',
    '    tier: strategic',
    ...(input.agentType === 'agent'
      ? [
          `    agent_file: ${input.agentTarget}`,
          '    produces:',
          `      - path: ${input.outputArtifact}`,
        ]
      : [
          '    agent_file: ""',
          `    team_path: ${input.agentTarget}`,
          `    output_artifact: ${input.outputArtifact.replace('root', 'nested')}`,
        ]),
    'levels:',
    '  - id: execute',
    '    name: Execute',
    '    order: 0',
    '    stage:',
    '      type: routing',
    `      coordinator: ${input.agentName}`,
    '      config:',
    '        output:',
    `          format: ${input.outputArtifact}`,
    '          user_review: false',
    'gates:',
    '  - from: execute',
    '    to: done',
    '    condition:',
    '      type: artifact_exists',
    `      artifact: ${input.outputArtifact}`,
    '',
  ].join('\n')
}
