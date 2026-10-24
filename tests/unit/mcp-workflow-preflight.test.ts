import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateMcpWorkflowPreflight,
  McpWorkflowPreflightValidationError,
  resolveEffectiveMcpWorkflowRequirements,
} from '../../domains/mcp/mcp-workflow-preflight.js'

test('effective MCP requirements preserve read/write conjunction and required dominance', () => {
  const effective = resolveEffectiveMcpWorkflowRequirements({
    workflowRequirements: [
      { capability: 'calendar', access: 'any', necessity: 'optional' },
      { capability: 'documents', access: 'read', necessity: 'optional' },
    ],
    steps: [{
      stepId: 'draft',
      requirements: [
        { capability: 'calendar', access: 'write', necessity: 'required' },
        { capability: 'documents', access: 'write', necessity: 'required' },
      ],
    }],
  })

  assert.deepEqual(effective.workflowRequirements, [
    { capability: 'calendar', access: ['any'], necessity: 'optional' },
    { capability: 'documents', access: ['read'], necessity: 'optional' },
  ])
  assert.deepEqual(effective.steps, [{
    stepId: 'draft',
    effectiveRequirements: [
      { capability: 'calendar', access: ['write'], necessity: 'required' },
      {
        capability: 'documents',
        access: ['read', 'write'],
        necessity: 'required',
      },
    ],
  }])
})

test('read and write must be satisfied by one granted live server alias', () => {
  const base = {
    workflowId: 'document-workflow',
    generatedAt: '2026-07-12T20:00:00.000Z',
    workflowRequirements: [
      { capability: 'documents', access: 'read' as const, necessity: 'required' as const },
    ],
    steps: [{
      stepId: 'draft',
      requirements: [
        { capability: 'documents', access: 'write' as const, necessity: 'required' as const },
      ],
      scheduledAgents: [{
        agentPath: 'agents/writer',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        supportState: 'supported' as const,
      }],
    }],
    grants: [
      { agentPath: 'agents/writer', serverId: 'read-server', enabled: true },
      { agentPath: 'agents/writer', serverId: 'write-server', enabled: true },
      { agentPath: 'agents/writer', serverId: 'combined-server', enabled: true },
    ],
  }

  const splitServers = evaluateMcpWorkflowPreflight({
    ...base,
    servers: [
      activeServer('read-server', 'Reader', 'read'),
      activeServer('write-server', 'Writer', 'write'),
    ],
  })
  assert.equal(splitServers.ok, false)
  assert.equal(splitServers.errors.length, 1)
  assert.deepEqual(requiredValue(splitServers.errors[0], 'tests/unit/mcp-workflow-preflight.test.ts:77').access, ['read', 'write'])
  assert.deepEqual(requiredValue(requiredValue(splitServers.snapshot.steps[0], 'tests/unit/mcp-workflow-preflight.test.ts:78').matches[0], 'tests/unit/mcp-workflow-preflight.test.ts:79').candidates, [])

  const combined = evaluateMcpWorkflowPreflight({
    ...base,
    servers: [
      activeServer('read-server', 'Reader', 'read'),
      activeServer('write-server', 'Writer', 'write'),
      activeServer('combined-server', 'Combined', 'any'),
    ],
  })
  assert.equal(combined.ok, true)
  assert.deepEqual(combined.errors, [])
  assert.deepEqual(requiredValue(requiredValue(combined.snapshot.steps[0], 'tests/unit/mcp-workflow-preflight.test.ts:90').matches[0], 'tests/unit/mcp-workflow-preflight.test.ts:91').candidates, [{
    serverId: 'combined-server',
    serverName: 'Combined',
    agentPath: 'agents/writer',
    provider: 'openai',
    state: 'supported',
  }])
  assert.deepEqual(requiredValue(requiredValue(combined.snapshot.steps[0], 'tests/unit/mcp-workflow-preflight.test.ts:97').matches[0], 'tests/unit/mcp-workflow-preflight.test.ts:98').owner, {
    agentPath: 'agents/writer',
    provider: 'openai',
  })
})

test('required capability ownership is deterministic while optional capabilities remain unowned', () => {
  const result = evaluateMcpWorkflowPreflight({
    workflowId: 'multi-agent-workflow',
    generatedAt: '2026-07-12T20:00:00.000Z',
    steps: [{
      stepId: 'collect',
      requirements: [
        { capability: 'documents', access: 'read', necessity: 'required' },
        { capability: 'calendar', access: 'read', necessity: 'optional' },
      ],
      scheduledAgents: [
        {
          agentPath: 'agents/zeta',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          supportState: 'supported',
        },
        {
          agentPath: 'agents/alpha',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          supportState: 'supported',
        },
      ],
    }],
    servers: [
      activeServer('documents-server', 'Documents', 'read'),
      activeServer('calendar-server', 'Calendar', 'read', 'calendar'),
    ],
    grants: [
      { agentPath: 'agents/zeta', serverId: 'documents-server', enabled: true },
      { agentPath: 'agents/alpha', serverId: 'documents-server', enabled: true },
      { agentPath: 'agents/zeta', serverId: 'calendar-server', enabled: true },
      { agentPath: 'agents/alpha', serverId: 'calendar-server', enabled: true },
    ],
  })

  assert.equal(result.ok, true)
  const requiredMatch = requiredValue(result.snapshot.steps[0], 'tests/unit/mcp-workflow-preflight.test.ts:141').matches.find(
    (match) => match.capability === 'documents',
  )
  const optionalMatch = requiredValue(result.snapshot.steps[0], 'tests/unit/mcp-workflow-preflight.test.ts:144').matches.find(
    (match) => match.capability === 'calendar',
  )
  assert.deepEqual(requiredMatch?.owner, {
    agentPath: 'agents/alpha',
    provider: 'openai',
  })
  assert.equal(optionalMatch?.owner, null)
})

test('preflight separates retryable required gaps from optional warnings', () => {
  const result = evaluateMcpWorkflowPreflight({
    workflowId: 'research-workflow',
    generatedAt: '2026-07-12T20:00:00.000Z',
    workflowRequirements: [],
    steps: [{
      stepId: 'research',
      requirements: [
        { capability: 'search', access: 'read', necessity: 'required' },
        { capability: 'calendar', access: 'write', necessity: 'optional' },
      ],
      scheduledAgents: [
        {
          agentPath: 'agents/researcher',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          supportState: 'supported',
        },
        {
          agentPath: 'agents/legacy',
          provider: 'anthropic',
          model: 'claude-legacy',
          supportState: 'unsupported',
        },
      ],
    }],
    servers: [
      {
        ...activeServer('search-server', 'Search', 'read', 'search'),
        live: false,
      },
      activeServer('calendar-server', 'Calendar', 'write', 'calendar'),
    ],
    grants: [],
  })

  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
  assert.equal(result.warnings.length, 1)
  assert.deepEqual(result.errors[0], {
    code: 'mcp_requirement_unmet',
    retryable: true,
    stepId: 'research',
    capability: 'search',
    access: ['read'],
    necessity: 'required',
    eligibleAgentPaths: ['agents/researcher'],
    message:
      "Step 'research' has no eligible scheduled agent with required read access to MCP capability 'search'. Eligible agent paths: agents/researcher.",
  })
  assert.equal(requiredValue(result.warnings[0], 'tests/unit/mcp-workflow-preflight.test.ts:204').capability, 'calendar')
  assert.equal(requiredValue(result.warnings[0], 'tests/unit/mcp-workflow-preflight.test.ts:205').necessity, 'optional')
  assert.equal(result.snapshot.authorization.state, 'non-authoritative')
  assert.equal(result.snapshot.authorization.brokerRechecksAtCallTime, true)
  assert.deepEqual(result.scheduledAgentPaths, [
    'agents/legacy',
    'agents/researcher',
  ])
  assert.deepEqual(result.scheduledAgents, [
    {
      agentPath: 'agents/legacy',
      provider: 'anthropic',
      model: 'claude-legacy',
      supportState: 'unsupported',
    },
    {
      agentPath: 'agents/researcher',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      supportState: 'supported',
    },
  ])
  assert.deepEqual(result.snapshot.scheduledAgentPaths, result.scheduledAgentPaths)
  assert.deepEqual(result.snapshot.scheduledAgents, result.scheduledAgents)
  assert.deepEqual(result.snapshot.warnings, result.warnings)
  assert.doesNotMatch(JSON.stringify(result.errors), /server|https?:\/\/|secret/i)
})

test('preflight requires provider readiness only for agents that need managed provider tools', () => {
  const blocked = evaluateMcpWorkflowPreflight({
    workflowId: 'deep-research-report',
    generatedAt: '2026-07-18T15:00:00.000Z',
    steps: [{
      stepId: 'research',
      scheduledAgents: [
        {
          agentPath: 'agents/research-planner',
          provider: 'codex',
          model: 'default',
          supportState: 'unsupported',
        },
        {
          agentPath: 'agents/web-researcher',
          provider: 'codex',
          model: 'default',
          supportState: 'unsupported',
          requiredProviderTools: ['browser'],
          providerSupportReasonCode: 'cli_model_unavailable',
          providerSupportMessage:
            'Enable this agent’s configured Codex CLI model before granting MCP access.',
        },
      ],
    }],
    servers: [],
    grants: [],
  })

  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.errors, [{
    code: 'provider_tool_bridge_unavailable',
    retryable: true,
    stepId: 'research',
    agentPath: 'agents/web-researcher',
    provider: 'codex',
    model: 'default',
    tool: 'browser',
    reasonCode: 'cli_model_unavailable',
    message:
      "Step 'research' cannot launch agent 'agents/web-researcher' with managed tool 'browser'. Enable this agent’s configured Codex CLI model before granting MCP access.",
  }])
  assert.deepEqual(blocked.scheduledAgents, [
    {
      agentPath: 'agents/research-planner',
      provider: 'codex',
      model: 'default',
      supportState: 'unsupported',
    },
    {
      agentPath: 'agents/web-researcher',
      provider: 'codex',
      model: 'default',
      supportState: 'unsupported',
    },
  ])

  const ready = evaluateMcpWorkflowPreflight({
    workflowId: 'deep-research-report',
    generatedAt: '2026-07-18T15:00:00.000Z',
    steps: [{
      stepId: 'research',
      scheduledAgents: [{
        agentPath: 'agents/web-researcher',
        provider: 'codex',
        model: 'gpt-5.5',
        supportState: 'supported',
        requiredProviderTools: ['browser'],
      }],
    }],
    servers: [],
    grants: [],
  })

  assert.equal(ready.ok, true)
  assert.deepEqual(ready.errors, [])
})

test('preflight rejects more than 256 scheduled agent paths without truncation', () => {
  assert.throws(
    () => evaluateMcpWorkflowPreflight({
      workflowId: 'oversized-workflow',
      generatedAt: '2026-07-12T20:00:00.000Z',
      workflowRequirements: [],
      steps: [{
        stepId: 'oversized-step',
        requirements: [],
        scheduledAgents: Array.from({ length: 257 }, (_, index) => ({
          agentPath: `agents/agent-${String(index).padStart(3, '0')}`,
          provider: 'openai',
          model: 'gpt-5.4-mini',
          supportState: 'supported' as const,
        })),
      }],
      servers: [],
      grants: [],
    }),
    (error) =>
      error instanceof McpWorkflowPreflightValidationError &&
      error.code === 'scheduled_agent_limit_exceeded' &&
      error.message === 'Workflow schedules 257 MCP agent paths; the maximum is 256.',
  )
})

function activeServer(
  serverId: string,
  serverName: string,
  access: 'read' | 'write' | 'any',
  capability = 'documents',
) {
  return {
    serverId,
    serverName,
    enabled: true,
    status: 'connected' as const,
    live: true,
    capabilityAliases: [{ capability, access }],
  }
}
