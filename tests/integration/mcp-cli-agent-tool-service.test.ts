import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import * as http from 'node:http'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import { browserToolModule } from '../../server/tools/browser.js'
import { researchWebToolModule } from '../../server/tools/research-web.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'
import {
  buildToolRegistry,
  providerAgentTools,
} from '../../server/tools/tool-registry.js'
import type {
  ProviderExecuteOptions,
  ProviderResult,
} from '../../providers/types.js'
import {
  BrowserManager,
  BrowserRuntimeError,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'
import {
  BROWSER_TOOL_NAME,
  type BrowserToolInput,
  type BrowserToolOutput,
} from '../../domains/browser/browser-types.js'
import { RESEARCH_WEB_TOOL_NAME } from '../../domains/acquisition/acquisition-types.js'
import { GENERATE_EXCEL_TOOL_NAME } from '../../domains/excel-generation/generate-excel-types.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import type { BuiltinAgentToolAdapter } from '../../domains/mcp/builtin-agent-tool-adapter.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { createMcpProviderSupportResolver } from '../../domains/mcp/mcp-provider-support.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { BrowserToolService } from '../../services/browser-tool-service.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import {
  McpAgentToolService,
  McpAgentToolServiceError,
} from '../../services/mcp-agent-tool-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { INSUFFICIENT_WEB_RESEARCH_RESPONSE } from '../../domains/browser/web-research-evidence.js'
import { parseWebEvidenceRolloutConfig } from '../../domains/browser/web-evidence-rollout.js'
import {
  reduceWebEvidenceValidationEvents,
  WEB_EVIDENCE_VALIDATION_STREAM_KIND,
} from '../../domains/browser/web-evidence-validation-journal.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { resolveWebEvidenceValidationRecorder } from '../../services/web-evidence-validation-recorder.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'
import { GENERATE_WORD_TOOL_NAME } from '../../domains/word-generation/generate-word-types.js'
import { YOUTUBE_TOOL_NAME } from '../../domains/youtube/youtube-types.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const repoRoot = process.cwd()
const mcpFixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'mcp',
  'stdio-server.mjs',
)

test('Codex direct research chat stays user-facing and rejects uncited Quick Scout answers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-direct-research-'))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const observedUrl = 'https://stores.example/detroit'
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(root, 'providers.json'),
  })
  const service = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService,
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: [observedResearchTool(observedUrl)],
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      const transport = new StreamableHTTPClientTransport(
        new URL(options.mcpBridge.url),
        {
          requestInit: {
            headers: {
              authorization: `Bearer ${options.mcpBridge.token}`,
            },
          },
        },
      )
      const client = new Client({
        name: 'pipeline-direct-research-fixture',
        version: '1.0.0',
      })
      try {
        await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
        const listed = await client.listTools(undefined, { timeout: 2_000 })
        const tool = listed.tools[0]
        assert.ok(tool)
        await client.callTool(
          { name: tool.name, arguments: { action: 'acquire' } },
          undefined,
          { timeout: 2_000 },
        )
      } finally {
        await client.close().catch(() => undefined)
      }

      if (options.agentName === 'web-researcher') {
        assert.equal(options.outputSchema, undefined)
        assert.equal(options.outputPath, undefined)
        return providerResult(`Detroit shoe store: ${observedUrl}`, options.model)
      }
      assert.equal(options.agentName, 'quick-scout')
      return providerResult('I found a Detroit shoe store.', options.model)
    },
  })

  try {
    const webAssignmentPath = path.join(root, 'web-assignment')
    fs.mkdirSync(webAssignmentPath)
    const webTurn = await service.runTurn({
      sessionId: 'session-direct-web',
      runId: 'run-direct-web',
      assignmentId: 'assignment-direct-web',
      activityScopeId: 'assignment-direct-web',
      agentPath: 'agents/web-researcher',
      provider: 'codex',
      model: 'gpt-test',
      thinking: 'medium',
      cwd: webAssignmentPath,
      systemPrompt: 'Answer the user directly with observed source links.',
      userMessage: 'Find shoe stores in Detroit.',
      researchQuestion: 'Find shoe stores in Detroit.',
      allowedServerIds: [],
    })
    assert.equal(webTurn.kind, 'completed')
    if (webTurn.kind !== 'completed') return
    assert.equal(webTurn.result.text, `Detroit shoe store: ${observedUrl}`)
    assert.doesNotMatch(webTurn.result.text, /"schemaVersion"/u)

    const quickAssignmentPath = path.join(root, 'quick-assignment')
    fs.mkdirSync(quickAssignmentPath)
    const quickTurn = await service.runTurn({
      sessionId: 'session-direct-quick',
      runId: 'run-direct-quick',
      assignmentId: 'assignment-direct-quick',
      activityScopeId: 'assignment-direct-quick',
      agentPath: 'agents/quick-scout',
      provider: 'codex',
      model: 'gpt-test',
      thinking: 'medium',
      cwd: quickAssignmentPath,
      systemPrompt: 'Answer the user directly with observed source links.',
      userMessage: 'Find shoe stores in Detroit.',
      researchQuestion: 'Find shoe stores in Detroit.',
      allowedServerIds: [],
    })
    assert.equal(quickTurn.kind, 'completed')
    if (quickTurn.kind !== 'completed') return
    assert.equal(quickTurn.result.text, INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  } finally {
    await settings.closeAll().catch(() => undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function observedResearchTool(url: string): BuiltinAgentToolAdapter {
  const namespacedName = 'research.web'
  return {
    name: namespacedName,
    tool: {
      serverId: 'builtin.research-web',
      serverName: 'Research Web',
      toolName: 'research_web',
      namespacedName,
      description: 'Returns one observed research source.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      risk: 'read-only',
      effect: serialCapabilityEffect('read-only'),
      requiresApproval: false,
    },
    isEnabledForAgent: (agentPath) =>
      agentPath === 'agents/web-researcher' || agentPath === 'agents/quick-scout',
    execute: async () => ({
      output: { ok: true, action: 'acquire', canonicalUrl: url },
      content: JSON.stringify({ ok: true, action: 'acquire', canonicalUrl: url }),
      isError: false,
      webObservation: {
        url,
        title: 'Detroit shoe store',
        text: 'A shoe store located in Detroit.',
      },
    }),
  }
}

function providerResult(text: string, model: string): ProviderResult {
  return {
    text,
    model,
    cost: 0,
    durationMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    contextTokens: 2,
  }
}

test('CLI provider turn uses the parent bridge and broker without exposing the source MCP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-agent-turn-'))
  const callsPath = path.join(directory, 'calls.jsonl')
  const assignmentPath = path.join(directory, 'assignment')
  fs.mkdirSync(assignmentPath, { recursive: true })

  const manager = new McpClientManager({
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  })
  const settings = new McpSettingsService({
    storagePath: path.join(directory, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: ({ context, serverId }) =>
      settings.isAgentGranted(context.agentPath, serverId),
    leaseResolver: (context) => leases.resolve(context),
  })

  let providerExecutions = 0
  let bridgeUrl = ''
  let capturedOptions: ProviderExecuteOptions | undefined
  const executeCliProvider = async (
    provider: string,
    options: ProviderExecuteOptions,
  ): Promise<ProviderResult> => {
    providerExecutions += 1
    capturedOptions = options
    assert.equal(provider, 'codex')
    assert.ok(options.mcpBridge)
    bridgeUrl = options.mcpBridge.url

    const transport = new StreamableHTTPClientTransport(
      new URL(options.mcpBridge.url),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${options.mcpBridge.token}`,
          },
        },
      },
    )
    const client = new Client({
      name: 'pipeline-cli-provider-fixture',
      version: '1.0.0',
    })
    try {
      await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
      const listed = await client.listTools(undefined, { timeout: 2_000 })
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        options.mcpBridge.proxyToolNames,
      )
      const toolName = listed.tools[0]?.name
      assert.ok(toolName)
      const called = await client.callTool(
        { name: toolName, arguments: { marker: 'cli-service-marker' } },
        undefined,
        { timeout: 2_000 },
      )
      const content = (called as { content?: unknown }).content
      assert.ok(Array.isArray(content))
      const proxyText = content.find(
        (item: unknown): item is { type: 'text'; text: string } => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return false
          }
          const record = item as Record<string, unknown>
          return record.type === 'text' && typeof record.text === 'string'
        },
      )?.text
      assert.ok(proxyText)
      const brokerResult = JSON.parse(proxyText) as {
        content: Array<{ type: string; text?: string }>
      }
      return {
        text: `cli-consumed:${brokerResult.content[0]?.text}`,
        model: options.model,
        cost: 0,
        durationMs: 10,
        inputTokens: 4,
        outputTokens: 3,
        contextTokens: 7,
      }
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  try {
    await settings.saveServer({
      id: 'cli-tools',
      name: 'CLI tools',
      capabilityAliases: [],
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpFixturePath],
        cwd: repoRoot,
        secretEnvironment: {
          MCP_FIXTURE_CALLS_PATH: { operation: 'replace', value: callsPath },
        },
      },
    })
    await settings.validateServer('cli-tools', {
      stdioTrustAcknowledged: true,
    })
    await settings.setAgentGrant('agents/cli-agent', 'cli-tools', true)

    const service = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(directory, 'providers.json'),
      }),
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'supported',
        mode: 'host-tool-bridge',
      }),
      cliProviderExecutor: executeCliProvider,
    })

    const result = await service.runTurn({
      sessionId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      assignmentId: '33333333-3333-4333-8333-333333333333',
      agentPath: 'agents/cli-agent',
      provider: 'codex',
      model: 'gpt-test',
      thinking: 'medium',
      cwd: assignmentPath,
      providerConfig: {
        sandbox: 'danger-full-access',
        base_url: 'https://worker-controlled.invalid',
        headers: { authorization: 'do-not-forward' },
      },
      systemPrompt: 'Use the available evidence tool.',
      userMessage: 'Return the marker.',
    })

    assert.equal(result.kind, 'completed')
    if (result.kind !== 'completed') return
    assert.equal(result.result.text, 'cli-consumed:echo-marker:cli-service-marker')
    assert.deepEqual(result.result.usage, {
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 7,
    })
    assert.equal(result.result.toolCallCount, 1)
    assert.equal(result.result.executedToolCallCount, 1)
    assert.equal(result.availableToolCount, 1)
    assert.equal(providerExecutions, 1)
    assert.equal(capturedOptions?.cwd, assignmentPath)
    assert.deepEqual(capturedOptions?.providerConfig, { sandbox: 'read-only' })
    assert.equal(capturedOptions?.outputPath, undefined)
    assert.equal(capturedOptions?.mcpBridge?.tokenEnvironmentVariable,
      'PIPELINE_MCP_CLI_BRIDGE_TOKEN')
    const [inventoryTool] = capturedOptions?.mcpBridge?.toolInventory ?? []
    assert.equal(inventoryTool?.proxyName,
      capturedOptions?.mcpBridge?.proxyToolNames[0])
    assert.equal(inventoryTool?.serverName, 'CLI tools')
    assert.equal(inventoryTool?.toolName, 'echo-marker')
    assert.equal(
      inventoryTool?.description,
      'Echoes a deterministic marker without changing external state.',
    )
    assert.equal(fs.readFileSync(callsPath, 'utf8').trim().split('\n').length, 1)
    await assert.rejects(fetch(bridgeUrl))

    await settings.setAgentGrant('agents/cli-agent', 'cli-tools', false)
    const afterRevoke = await service.runTurn({
      sessionId: '11111111-1111-4111-8111-111111111111',
      runId: '44444444-4444-4444-8444-444444444444',
      assignmentId: '55555555-5555-4555-8555-555555555555',
      agentPath: 'agents/cli-agent',
      provider: 'codex',
      model: 'gpt-test',
      thinking: 'low',
      cwd: assignmentPath,
      systemPrompt: 'Use the available evidence tool.',
      userMessage: 'Return the marker.',
    })
    assert.equal(afterRevoke.kind, 'no-tools')
    assert.equal(providerExecutions, 1)

    await settings.setAgentGrant('agents/cli-agent', 'cli-tools', true)
    for (const failure of [
      {
        provider: 'claude',
        detail: 'Not logged in · Please run /login',
        expected: /claude auth login/i,
        code: 'provider_failed',
      },
      {
        provider: 'kimi-cli',
        detail: 'Authentication required. Please run /login.',
        expected: /kimi login/i,
        code: 'provider_failed',
      },
      {
        provider: 'codex',
        detail: 'Unknown model requested',
        expected: /selected CLI model is unavailable/i,
        code: 'provider_failed',
      },
      {
        // A worker lane hit by an exhausted quota was told only "Provider CLI
        // execution failed.", which names nothing the operator can act on.
        // Its own code and reset are what let the Team process say more than
        // "provider_failed" once the message itself is left behind.
        provider: 'codex',
        detail:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
          'to purchase more credits or try again at Aug 19th, 2026 11:32 PM.',
        expected: /usage limit[\s\S]*Aug 19, 2026/i,
        code: 'provider_usage_limit',
        resetsAt: 'Aug 19, 2026 at 11:32 PM',
      },
    ]) {
      const failingService = new McpAgentToolService({
        broker,
        leaseStore: leases,
        providerSettingsService: new ProviderSettingsService({
          storagePath: path.join(directory, 'providers.json'),
        }),
        providerSupportResolver: ({ provider }) => ({
          provider,
          state: 'supported',
          mode: 'host-tool-bridge',
        }),
        cliProviderExecutor: async () => {
          throw new ProviderError({
            provider: failure.provider,
            message: failure.detail,
            retryable: false,
          })
        },
      })
      await assert.rejects(
        failingService.runTurn({
          sessionId: '11111111-1111-4111-8111-111111111111',
          runId: crypto.randomUUID(),
          assignmentId: crypto.randomUUID(),
          agentPath: 'agents/cli-agent',
          provider: failure.provider,
          model: 'default',
          thinking: 'low',
          cwd: assignmentPath,
          systemPrompt: 'Use the available evidence tool.',
          userMessage: 'Return the marker.',
        }),
        (error: unknown) =>
          error instanceof McpAgentToolServiceError &&
          failure.expected.test(error.message) &&
          error.code === failure.code &&
          error.resetsAt === failure.resetsAt,
      )
      assert.equal(leases.size, 0)
    }

    // A stall abort must stay identifiable after the worker boundary rewrites
    // the provider error. Without a distinct code it is indistinguishable from
    // any other worker failure, and the diagnostics can never say the lane was
    // killed for silence rather than for its own output.
    const stalledService = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(directory, 'providers.json'),
      }),
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'supported',
        mode: 'host-tool-bridge',
      }),
      cliProviderExecutor: async () => {
        throw new ProviderError({
          provider: 'codex',
          message:
            "Provider 'codex' emitted no protocol event for 130s and the silent turn was aborted.",
          kind: 'timeout',
          code: 'provider_stalled',
          retryable: true,
        })
      },
    })
    await assert.rejects(
      stalledService.runTurn({
        sessionId: '11111111-1111-4111-8111-111111111111',
        runId: crypto.randomUUID(),
        assignmentId: crypto.randomUUID(),
        agentPath: 'agents/cli-agent',
        provider: 'codex',
        model: 'default',
        thinking: 'low',
        cwd: assignmentPath,
        systemPrompt: 'Use the available evidence tool.',
        userMessage: 'Return the marker.',
      }),
      (error: unknown) =>
        error instanceof McpAgentToolServiceError &&
        error.code === 'provider_stalled' &&
        error.retryable === true,
    )
    assert.equal(leases.size, 0)

    // A truncated response needs the same treatment for the same reason: the
    // boundary maps every code it does not recognise to `provider_failed`, and
    // a lane that was cut off at its token ceiling is not the same fact as a
    // lane whose work failed on its merits.
    const truncatedService = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(directory, 'providers.json'),
      }),
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'supported',
        mode: 'host-tool-bridge',
      }),
      cliProviderExecutor: async () => {
        throw new ProviderError({
          provider: 'codex',
          message: 'returned a truncated response: the response stopped at max_tokens.',
          kind: 'process_failed',
          code: 'provider_truncated',
          retryable: false,
        })
      },
    })
    await assert.rejects(
      truncatedService.runTurn({
        sessionId: '11111111-1111-4111-8111-111111111111',
        runId: crypto.randomUUID(),
        assignmentId: crypto.randomUUID(),
        agentPath: 'agents/cli-agent',
        provider: 'codex',
        model: 'default',
        thinking: 'low',
        cwd: assignmentPath,
        systemPrompt: 'Use the available evidence tool.',
        userMessage: 'Return the marker.',
      }),
      (error: unknown) =>
        error instanceof McpAgentToolServiceError &&
        error.code === 'provider_truncated' &&
        error.retryable === false,
    )
    assert.equal(leases.size, 0)

    // The native tool-loop mode is the production path for OpenAI-compatible
    // providers on the MCP lane: it never calls providers/<name>.ts, so the
    // truncation check added there does not run. This drives the real service
    // against a real OpenAI-compatible endpoint returning a response cut off at
    // its token ceiling, and observes the error the service actually throws.
    const providerFixture = await startOpenAiToolLoopFixture(process.cwd())
    const originalBaseUrl = process.env.OPENAI_BASE_URL
    const originalApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_BASE_URL = `${providerFixture.url}/v1`
    process.env.OPENAI_API_KEY = 'tool-loop-test-key'
    try {
      const nativeLoopService = new McpAgentToolService({
        broker,
        leaseStore: leases,
        providerSettingsService: new ProviderSettingsService({
          storagePath: path.join(directory, 'providers.json'),
        }),
        providerSupportResolver: ({ provider }) => ({
          provider,
          state: 'supported',
          mode: 'native-tool-loop',
        }),
        cliProviderExecutor: async () => {
          throw new Error('the CLI executor must not run on the native tool-loop path')
        },
      })
      await assert.rejects(
        nativeLoopService.runTurn({
          sessionId: '11111111-1111-4111-8111-111111111111',
          runId: crypto.randomUUID(),
          assignmentId: crypto.randomUUID(),
          agentPath: 'agents/cli-agent',
          provider: 'openai',
          model: 'fixture/truncated',
          thinking: 'low',
          cwd: assignmentPath,
          systemPrompt: 'Use the available evidence tool.',
          userMessage: 'Return the marker.',
        }),
        (error: unknown) =>
          error instanceof McpAgentToolServiceError &&
          error.code === 'provider_truncated' &&
          error.retryable === false,
      )
      assert.equal(leases.size, 0)
    } finally {
      if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = originalBaseUrl
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalApiKey
      await providerFixture.close()
    }

  } finally {
    await settings.closeAll().catch(() => undefined)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('built-in registry preserves provider-facing tools and appends progressive skill loading', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-built-in-tool-order-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  fs.mkdirSync(workspacePath, { recursive: true })
  const agentDirectory = path.join(repoRootPath, 'agents', 'youtube-extractor')
  fs.mkdirSync(agentDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(agentDirectory, 'youtube-extractor.md'),
    [
      '---',
      'name: youtube-extractor',
      'tools: browser, youtube_extract, generate_word, generate_excel',
      'browser_restrict_domains: false',
      '---',
      '',
      '# YouTube Extractor',
    ].join('\n'),
  )
  const skillDirectory = path.join(
    agentDirectory,
    'skills',
    'transcript-analysis',
  )
  fs.mkdirSync(skillDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(skillDirectory, 'SKILL.md'),
    [
      '---',
      'name: transcript-analysis',
      'description: Analyze a captured transcript.',
      '---',
      '',
      '# Transcript analysis',
    ].join('\n'),
  )

  const browserManager = new BrowserManager({
    profilePath: path.join(root, 'browser-profile'),
    executablePath: path.join(root, 'missing-browser'),
  })
  const clientManager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager,
  })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager,
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const registry = buildToolRegistry({
    workspacePath,
    repoRootPath,
    browserManager,
    capabilityDispatcher: createCapabilityTestDispatcher(),
    moduleOptions: {
      youtube: { settingsOptions: { environment: {} } },
    },
  })
  const expectedOrder = [
    BROWSER_TOOL_NAME,
    YOUTUBE_TOOL_NAME,
    GENERATE_WORD_TOOL_NAME,
    GENERATE_EXCEL_TOOL_NAME,
    'load_skill',
    'create_file',
  ]
  let providerToolOrder: readonly string[] | undefined
  const service = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({
      storagePath: path.join(root, 'providers.json'),
    }),
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: providerAgentTools(registry),
    cliProviderExecutor: async (_provider, options) => {
      providerToolOrder =
        options.mcpBridge?.toolInventory?.map((tool) => tool.toolName)
      return {
        text: 'No tool call required.',
        model: options.model,
        cost: 0,
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        contextTokens: 2,
      }
    },
  })

  try {
    const result = await service.runTurn({
      sessionId: 'session-tool-order',
      runId: 'run-tool-order',
      assignmentId: 'assignment-tool-order',
      agentPath: 'agents/youtube-extractor',
      provider: 'codex',
      model: 'gpt-test',
      thinking: 'low',
      cwd: workspacePath,
      systemPrompt: 'Inspect the available tools.',
      userMessage: 'Return without calling a tool.',
      allowedServerIds: [],
    })
    assert.equal(result.kind, 'completed')
    assert.deepEqual(providerToolOrder, expectedOrder)
  } finally {
    await settings.closeAll().catch(() => undefined)
    await browserManager.close().catch(() => undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Codex default model alias keeps the managed Browser on the host-tool bridge', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-default-browser-')),
  )
  const originalPath = process.env.PATH
  const originalCliFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  const binDirectory = path.join(root, 'bin')
  fs.mkdirSync(binDirectory, { recursive: true })
  writeCodexDefaultAliasFixture(binDirectory)
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ''}`
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const identity = {
    sessionId: 'session-default-browser',
    runId: 'run-default-browser',
    assignmentId: 'assignment-default-browser',
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, identity)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })
  writeBrowserAgentPolicy(repoRootPath)

  const browserManager = new DefaultAliasBrowserManager(
    path.join(root, 'browser-profile'),
  )
  const browserToolService = new BrowserToolService({
    workspacePath,
    repoRootPath,
    manager: browserManager,
  })
  const leases = new McpRunLeaseStore()
  const capabilityRuntime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: (context) => leases.resolve(context),
    runtimeAuthority: {
      authorize: async () => {
        throw new Error('Runtime assignment authority is not used by this MCP test.')
      },
    },
  })
  const browserAgentTool = browserToolModule.build({
    capabilityDispatcher: capabilityRuntime.dispatcher,
    moduleOptions: {
      browser: {
        toolService: browserToolService,
      },
    },
  }).agentTool
  assert.ok(browserAgentTool)
  const clientManager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager,
  })
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager,
    grantResolver: ({ context, serverId }) =>
      settings.isAgentGranted(context.agentPath, serverId),
    leaseResolver: (context) => leases.resolve(context),
  })
  let observedBrowserOutput: BrowserToolOutput | undefined
  const providerSettingsPath = path.join(root, 'providers.json')
  fs.writeFileSync(providerSettingsPath, JSON.stringify({
    version: 3,
    connections: [],
    cliEnabled: { codex: true },
    cliModelEnabled: {
      codex: {
        default: false,
        'gpt-5.5': true,
      },
    },
    defaultModel: { provider: 'codex', model: 'gpt-5.5' },
  }))
  const providerSettingsService = new ProviderSettingsService({
    storagePath: providerSettingsPath,
  })

  const service = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService,
    providerSupportResolver: createMcpProviderSupportResolver(
      providerSettingsService,
    ),
    builtinAgentTools: [browserAgentTool],
    cliProviderExecutor: async (provider, options) => {
      assert.equal(provider, 'codex')
      assert.equal(options.model, 'gpt-5.5')
      assert.equal(
        options.outputPath,
        path.join(location.assignmentPath, '.runtime', 'worker-logs', 'T1'),
      )
      assert.equal(options.outputSchema?.type, 'object')
      assert.equal(options.outputSchema?.additionalProperties, false)
      assert.ok(options.mcpBridge)
      const toolInventory = options.mcpBridge.toolInventory
      assert.ok(toolInventory)
      assert.equal(toolInventory.length, 1)
      assert.equal(toolInventory[0]?.toolName, BROWSER_TOOL_NAME)

      const transport = new StreamableHTTPClientTransport(
        new URL(options.mcpBridge.url),
        {
          requestInit: {
            headers: {
              authorization: `Bearer ${options.mcpBridge.token}`,
            },
          },
        },
      )
      const client = new Client({
        name: 'pipeline-default-browser-fixture',
        version: '1.0.0',
      })
      try {
        await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
        const listed = await client.listTools(undefined, { timeout: 2_000 })
        assert.equal(listed.tools.length, 1)
        const browserTool = listed.tools[0]
        assert.ok(browserTool)
        const called = await client.callTool(
          {
            name: browserTool.name,
            arguments: {
              action: 'open',
              url: 'https://example.test/tarnow-restaurants',
            },
          },
          undefined,
          { timeout: 2_000 },
        )
        const content = (called as { content?: unknown }).content
        assert.ok(Array.isArray(content))
        const outputText = content.find(
          (item: unknown): item is { type: 'text'; text: string } => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false
            const record = item as Record<string, unknown>
            return record.type === 'text' && typeof record.text === 'string'
          },
        )?.text
        assert.ok(outputText)
        observedBrowserOutput = JSON.parse(outputText) as BrowserToolOutput
        assert.equal(observedBrowserOutput.ok, true)
        assert.ok(observedBrowserOutput.observationReceipt)
        return {
          text: 'Tarnow restaurant evidence: https://example.test/tarnow-restaurants',
          model: options.model,
          cost: 0,
          durationMs: 5,
          inputTokens: 2,
          outputTokens: 2,
          contextTokens: 4,
        }
      } finally {
        await client.close().catch(() => undefined)
      }
    },
  })

  try {
    const result = await service.runTurn({
      ...identity,
      activityScopeId: 'T1',
      taskId: 'T1',
      agentPath: 'agents/web-researcher',
      provider: 'codex',
      model: 'default',
      thinking: 'medium',
      cwd: location.assignmentPath,
      systemPrompt: 'Use the managed Browser for evidence.',
      userMessage: 'Find Tarnow restaurant evidence.',
      researchQuestion: 'What Tarnow restaurant evidence is available?',
      allowedServerIds: [],
    })

    assert.equal(result.kind, 'completed')
    if (result.kind !== 'completed') return
    assert.deepEqual(result.providerSupport, {
      provider: 'codex',
      state: 'supported',
      mode: 'host-tool-bridge',
    })
    assert.equal(result.availableToolCount, 1)
    assert.match(result.result.text, /example\.test\/tarnow-restaurants/)
    assert.ok(observedBrowserOutput?.observationReceipt)
    const activities = await browserToolService.listSession(identity.sessionId)
    assert.equal(activities.length, 1)
    assert.equal(activities[0]?.state, 'completed')
    assert.ok(activities[0]?.observationReceipt)
    assert.equal(leases.size, 0)

    const nonBrowsingService = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService,
      providerSupportResolver: createMcpProviderSupportResolver(
        providerSettingsService,
      ),
      builtinAgentTools: [browserAgentTool],
      cliProviderExecutor: async (_provider, options) => ({
        text: JSON.stringify({
          schemaVersion: 1,
          assignmentId: 'T2',
          taskId: 'T2',
          workerSpecHash: 'a'.repeat(64),
          question: 'What evidence is available?',
          shortAnswer: '',
          findings: [],
          sources: [],
          contradictions: [],
          unresolvedQuestions: ['No source was observed.'],
          stopReason: 'insufficient_evidence',
        }),
        model: options.model,
        cost: 0,
        durationMs: 5,
        inputTokens: 2,
        outputTokens: 2,
        contextTokens: 4,
      }),
    })
    await assert.rejects(
      nonBrowsingService.runTurn({
        ...identity,
        activityScopeId: 'T2',
        taskId: 'T2',
        agentPath: 'agents/web-researcher',
        provider: 'codex',
        model: 'default',
        thinking: 'medium',
        cwd: location.assignmentPath,
        systemPrompt: 'Use the managed Browser for evidence.',
        userMessage: 'Find evidence.',
        researchQuestion: 'What evidence is available?',
        allowedServerIds: [],
      }),
      (error: unknown) =>
        error instanceof McpAgentToolServiceError &&
        error.code === 'provider_failed' &&
        error.retryable === true &&
        /governed web capability result/i.test(error.message),
    )
    const noWebResultLog = fs.readFileSync(
      path.join(
        location.assignmentPath,
        '.runtime',
        'worker-logs',
        'T2',
        'validation.jsonl',
      ),
      'utf8',
    )
    assert.match(noWebResultLog, /"category":"no_web_capability_result"/)
    assert.doesNotMatch(noWebResultLog, /"text"|"response"|No source was observed/)

    const packetRepair = await nonBrowsingService.runTurn({
      ...identity,
      activityScopeId: 'T2-repair',
      taskId: 'T2',
      agentPath: 'agents/web-researcher',
      provider: 'codex',
      model: 'default',
      thinking: 'medium',
      cwd: location.assignmentPath,
      systemPrompt: 'Reuse the already validated evidence packet.',
      userMessage: 'Repair the packet without acquiring new evidence.',
      researchQuestion: 'What evidence is available?',
      governedWebEvidenceMode: 'reuse-existing',
      allowedServerIds: [],
    })
    assert.equal(packetRepair.kind, 'completed')
    assert.equal(leases.size, 0)
  } finally {
    await settings.closeAll().catch(() => undefined)
    await capabilityRuntime.close().catch(() => undefined)
    await browserManager.close().catch(() => undefined)
    restoreEnvironment('PATH', originalPath)
    restoreEnvironment('PIPELINE_CLI_PATH_FALLBACK', originalCliFallback)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** The page the managed browser is refused, named once for the assertion. */
const DENIED_BROWSER_PAGE_URL = 'https://denied.example/report'

/**
 * A managed browser whose driver reports that the source blocked the page.
 *
 * It raises `BrowserRuntimeError` rather than returning `ok: false`, because
 * those are different production paths: the browser tool service treats any
 * `ok: false` return from a driver as a receipt-integrity fault and reprojects
 * it as `internal`, while a raised runtime error keeps its own code all the way
 * to the provider. Only the raised form reaches the provider as the source
 * refusal this test is about.
 *
 * The substitution stops at Chrome itself. Everything above it — the browser
 * tool service, the real capability dispatcher, and the built-in adapter that
 * derives `isError` — is production code.
 */
class DeniedBrowserManager extends BrowserManager {
  constructor(profilePath: string) {
    super({ profilePath })
  }

  override async describeTarget(): Promise<undefined> {
    return undefined
  }

  override async execute(
    _scope: BrowserExecutionScope,
    _input: BrowserToolInput,
  ): Promise<BrowserToolOutput> {
    throw new BrowserRuntimeError(
      'source_blocked',
      'The source blocked the managed browser.',
      true,
      { url: DENIED_BROWSER_PAGE_URL },
    )
  }
}

/** Answer every request with 403, the way a source that refuses a reader does. */
async function startDenyingSourceServer(): Promise<{
  readonly url: string
  close(): Promise<void>
}> {
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><body>Forbidden</body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}/report`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function writeGovernedWebAgentPolicy(repoRootPath: string): void {
  const directory = path.join(repoRootPath, 'agents', 'web-researcher')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'web-researcher.md'),
    [
      '---',
      'name: web-researcher',
      'tools: browser, research_web',
      'browser_restrict_domains: false',
      'web_restrict_domains: false',
      '---',
      '',
      '# Web Researcher',
    ].join('\n'),
  )
}

function deepResearchEvidencePacket(taskId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    assignmentId: taskId,
    taskId,
    workerSpecHash: 'b'.repeat(64),
    question: 'Which sources document current coding-agent controls?',
    shortAnswer: '',
    findings: [],
    sources: [],
    contradictions: [],
    unresolvedQuestions: ['Every candidate source refused acquisition.'],
    stopReason: 'insufficient_evidence',
  })
}

test('Deep Research completes after either governed web tool returns a typed source failure', async (t) => {
  // Either governed route proves the provider received a governed web result.
  // A refused page is recoverable news about that source, not a broken
  // capability, so it must not become a terminal worker failure. Both routes
  // run through the real capability dispatcher and the real built-in adapter;
  // only the network itself is local. Each route is its own subtest so a broken
  // one cannot hide behind the other.
  for (const capabilityId of [RESEARCH_WEB_TOOL_NAME, BROWSER_TOOL_NAME]) {
    await t.test(capabilityId, async () => {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-governed-web-')),
      )
      const workspacePath = path.join(root, 'workspace')
      const repoRootPath = path.join(root, 'repo')
      writeGovernedWebAgentPolicy(repoRootPath)
      const identity = {
        sessionId: '77777777-7777-4777-8777-777777777777',
        runId: `run-governed-${capabilityId}`,
        assignmentId: `assignment-governed-${capabilityId}`,
      }
      const location = buildSessionRunAssignmentLocation(workspacePath, identity)
      assert.ok(location)
      fs.mkdirSync(location.assignmentPath, { recursive: true })
      const leases = new McpRunLeaseStore()
      const capabilityRuntime = new CapabilityDispatchRuntime({
        workspacePath,
        leaseResolver: (context) => leases.resolve(context),
        runtimeAuthority: {
          authorize: async () => {
            throw new Error('Runtime assignment authority is not used by this MCP test.')
          },
        },
      })
      const deniedSource = await startDenyingSourceServer()
      const browserManager = new DeniedBrowserManager(
        path.join(root, 'browser-profile'),
      )
      const governedWebTool = capabilityId === RESEARCH_WEB_TOOL_NAME
        ? researchWebToolModule.build({
          workspacePath,
          repoRootPath,
          capabilityDispatcher: capabilityRuntime.dispatcher,
          moduleOptions: {
            'research-web': {
              // The real acquisition service, with no managed browser behind
              // it, so a terminal direct denial is the whole ladder.
              toolService: new ResearchWebToolService({
                workspacePath,
                repoRootPath,
                settings: new AcquisitionSettingsService({ environment: {} }),
                allowHttpLocalhost: true,
              }),
            },
          },
        }).agentTool
        : browserToolModule.build({
          capabilityDispatcher: capabilityRuntime.dispatcher,
          moduleOptions: {
            browser: {
              toolService: new BrowserToolService({
                workspacePath,
                repoRootPath,
                manager: browserManager,
              }),
            },
          },
        }).agentTool
      assert.ok(governedWebTool)
      const toolArguments = capabilityId === RESEARCH_WEB_TOOL_NAME
        ? { action: 'acquire', url: deniedSource.url }
        : { action: 'open', url: DENIED_BROWSER_PAGE_URL }
      // The exact refusal each route projects. Asserting the code, not merely
      // that some error exists, is what stops this passing on an unrelated
      // failure path such as a receipt-integrity fault.
      const expectedErrorCode = capabilityId === RESEARCH_WEB_TOOL_NAME
        ? 'access_denied'
        : 'source_blocked'

      const clientManager = new McpClientManager()
      const settings = new McpSettingsService({
        storagePath: path.join(root, 'mcps.json'),
        secretCodec: {
          encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
          decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
        },
        clientManager,
      })
      const broker = new McpParentBroker({
        lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
        settingsService: settings,
        clientManager,
        grantResolver: () => false,
        leaseResolver: (context) => leases.resolve(context),
      })
      let observedCapabilityOutput: GovernedWebToolOutputView | undefined
      const service = new McpAgentToolService({
        broker,
        leaseStore: leases,
        providerSettingsService: new ProviderSettingsService({
          storagePath: path.join(root, 'providers.json'),
        }),
        providerSupportResolver: ({ provider }) => ({
          provider,
          state: 'supported',
          mode: 'host-tool-bridge',
        }),
        builtinAgentTools: [governedWebTool],
        cliProviderExecutor: async (_provider, options) => {
          assert.ok(options.mcpBridge)
          const transport = new StreamableHTTPClientTransport(
            new URL(options.mcpBridge.url),
            {
              requestInit: {
                headers: { authorization: `Bearer ${options.mcpBridge.token}` },
              },
            },
          )
          const client = new Client({
            name: 'pipeline-governed-web-fixture',
            version: '1.0.0',
          })
          try {
            await client.connect(new ExactOptionalMcpTransport(transport), {
              timeout: 5_000,
            })
            const listed = await client.listTools(undefined, { timeout: 5_000 })
            const proxyName = listed.tools[0]?.name
            assert.ok(proxyName)
            const called = await client.callTool(
              { name: proxyName, arguments: toolArguments },
              undefined,
              { timeout: 20_000 },
            )
            observedCapabilityOutput = readGovernedWebToolOutput(called)
          } finally {
            await client.close().catch(() => undefined)
          }
          return providerResult(deepResearchEvidencePacket('T7'), options.model)
        },
      })

      try {
        const result = await service.runTurn({
          ...identity,
          activityScopeId: 'T7',
          taskId: 'T7',
          agentPath: 'agents/web-researcher',
          provider: 'codex',
          model: 'gpt-test',
          thinking: 'medium',
          cwd: location.assignmentPath,
          systemPrompt: 'Collect governed web evidence.',
          userMessage: 'Collect the evidence.',
          researchQuestion:
            'Which sources document current coding-agent controls?',
          allowedServerIds: [],
        })

        // Production classified the refusal, not the test: the capability
        // answered, and what it answered was this source failure.
        assert.equal(observedCapabilityOutput?.ok, false)
        assert.equal(observedCapabilityOutput?.error?.code, expectedErrorCode)
        assert.equal(
          result.kind,
          'completed',
          `${capabilityId} returned a resolved typed result and must complete the turn`,
        )
        if (result.kind !== 'completed') return
        assert.equal(result.result.text, deepResearchEvidencePacket('T7'))
        assert.equal(leases.size, 0)
      } finally {
        await settings.closeAll().catch(() => undefined)
        await capabilityRuntime.close().catch(() => undefined)
        await browserManager.close().catch(() => undefined)
        await deniedSource.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

interface GovernedWebToolOutputView {
  readonly ok?: unknown
  readonly error?: { readonly code?: unknown }
}

/** Read the tool output the bridge returned, without trusting its shape. */
function readGovernedWebToolOutput(
  called: unknown,
): GovernedWebToolOutputView | undefined {
  const content = (called as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const text = content.find(
    (item: unknown): item is { type: 'text'; text: string } => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const record = item as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
    },
  )?.text
  if (text === undefined) return undefined
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  const error = record.error
  return {
    ok: record.ok,
    ...(error && typeof error === 'object' && !Array.isArray(error)
      ? { error: { code: (error as Record<string, unknown>).code } }
      : {}),
  }
}

class DefaultAliasBrowserManager extends BrowserManager {
  constructor(profilePath: string) {
    super({ profilePath })
  }

  override async describeTarget(): Promise<undefined> {
    return undefined
  }

  override async execute(
    scope: BrowserExecutionScope,
    input: BrowserToolInput,
  ): Promise<BrowserToolOutput> {
    const contentId = 'default-alias-browser-content'
    const text = 'Tarnow restaurant evidence from the managed browser.'
    const contentDirectory = path.join(scope.assignmentPath, 'browser-content')
    fs.mkdirSync(contentDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(contentDirectory, `${contentId}.txt`),
      text,
      { mode: 0o600 },
    )
    return {
      ok: true,
      action: input.action,
      url: 'https://example.test/tarnow-restaurants',
      title: 'Tarnow restaurants',
      text,
      content: {
        id: contentId,
        sizeBytes: Buffer.byteLength(text),
        chunkCount: 1,
      },
    }
  }
}

function writeBrowserAgentPolicy(repoRootPath: string): void {
  const directory = path.join(repoRootPath, 'agents', 'web-researcher')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'web-researcher.md'),
    [
      '---',
      'name: web-researcher',
      'tools: browser',
      'browser_restrict_domains: false',
      '---',
      '',
      '# Web Researcher',
    ].join('\n'),
  )
}

function writeCodexDefaultAliasFixture(binDirectory: string): void {
  const executable = path.join(binDirectory, 'codex')
  fs.writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex fixture 1.0.0"; exit 0; fi',
      'if [ "$1 $2" = "exec --help" ]; then echo "--config --disable --ephemeral --ignore-rules --strict-config --ignore-user-config"; exit 0; fi',
      'if [ "$1 $2 $3" = "mcp add --help" ]; then echo "--url --bearer-token-env-var"; exit 0; fi',
      'if [ "$1 $2" = "debug models" ]; then echo \'' +
        '{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","context_window":128000}]}' +
        '\'; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
import { ExactOptionalMcpTransport } from '../../domains/mcp/mcp-transport-adapter.js'

interface CapturedWebEvidenceValidation {
  readonly turnId: string
  readonly stage: string
  readonly mode: string
  readonly providerKind: string
  readonly providerRoute: string
  readonly observedUrlCount: number
  readonly citedUrlCount: number
  readonly unobservedUrlCount: number
  readonly legacyDecision: string
  readonly decision: string
  readonly displayedDiffersFromCandidate: boolean
  readonly persistedDiffersFromCandidate: boolean
  readonly enforcementWouldDiffer: boolean
  readonly durationMs: number
}

function makeWebEvidenceOption(
  raw: Parameters<typeof parseWebEvidenceRolloutConfig>[0],
  captured: CapturedWebEvidenceValidation[],
) {
  return {
    config: parseWebEvidenceRolloutConfig(raw),
    resolveRecorder: async () => ({
      recordValidation: async (input: CapturedWebEvidenceValidation) => {
        captured.push(input)
      },
      release: async () => undefined,
    }),
  }
}

function researchWebSearchAcquireTool(input: {
  readonly discoveryUrl: string
  readonly acquired: Readonly<Record<string, { title: string; text: string }>>
}): BuiltinAgentToolAdapter {
  const namespacedName = 'research_web'
  const searchResults = [
    ...Object.entries(input.acquired).map(([url, observation]) => ({
      provider: 'brave',
      title: observation.title,
      url,
      canonicalUrl: url,
    })),
    {
      provider: 'brave',
      title: 'Ann Arbor Observer',
      url: input.discoveryUrl,
      canonicalUrl: input.discoveryUrl,
    },
  ]
  return {
    name: namespacedName,
    tool: {
      serverId: 'builtin.research-web',
      serverName: 'Research Web',
      toolName: 'research_web',
      namespacedName,
      description: 'Searches and acquires research sources.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'acquire'] },
          query: { type: 'string' },
          url: { type: 'string' },
          maximumResults: { type: 'number' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      risk: 'read-only',
      effect: serialCapabilityEffect('read-only'),
      requiresApproval: false,
    },
    isEnabledForAgent: (agentPath) =>
      agentPath === 'agents/web-researcher' || agentPath === 'agents/quick-scout',
    execute: async ({ input: toolInput }) => {
      const action = (toolInput as { action?: unknown }).action
      if (action === 'search') {
        const output = { ok: true, action: 'search', results: searchResults }
        return {
          output,
          content: JSON.stringify(output),
          isError: false,
        }
      }
      const url = (toolInput as { url?: unknown }).url
      const observation = typeof url === 'string'
        ? input.acquired[url]
        : undefined
      if (typeof url !== 'string' || !observation) {
        return {
          output: { ok: false },
          content: JSON.stringify({ ok: false }),
          isError: true,
        }
      }
      const output = { ok: true, action: 'acquire', canonicalUrl: url }
      return {
        output,
        content: JSON.stringify(output),
        isError: false,
        webObservation: { url, ...observation },
      }
    },
  }
}

async function makeResearchWebServiceFixture(t: {
  after: (fn: () => unknown) => void
}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-web-evidence-')),
  )
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  t.after(() => settings.closeAll().catch(() => undefined))
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const providerFixture = await startOpenAiToolLoopFixture(process.cwd())
  t.after(() => providerFixture.close())
  const originalBaseUrl = process.env.OPENAI_BASE_URL
  const originalApiKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = `${providerFixture.url}/v1`
  process.env.OPENAI_API_KEY = 'tool-loop-test-key'
  t.after(() => {
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalBaseUrl
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
  })
  const discoveryUrl = 'https://annarborobserver.com/ice-cream/'
  const acquired = {
    'https://sources.example/ann-arbor-ice-cream': {
      title: 'Ann Arbor Ice Cream Source',
      text: 'Ann Arbor ice cream options from a local creamery.',
    },
    'https://dairy.example/washtenaw': {
      title: 'Washtenaw Dairy',
      text: 'Ann Arbor ice cream options from a local dairy.',
    },
  }
  const makeService = (
    webEvidence: NonNullable<
      ConstructorParameters<typeof McpAgentToolService>[0]['webEvidence']
    >,
  ) =>
    new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(root, 'providers.json'),
      }),
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'supported',
        mode: 'native-tool-loop',
      }),
      builtinAgentTools: [researchWebSearchAcquireTool({ discoveryUrl, acquired })],
      cliProviderExecutor: async () => {
        throw new Error('the CLI executor must not run on the native tool-loop path')
      },
      webEvidence,
    })
  const runResearchTurn = (
    service: McpAgentToolService,
    onFinalRoundText?: (text: string) => void,
    userMessage = 'What are current ice cream options in Ann Arbor?',
    onFinalTextDelta?: (text: string) => void,
  ) =>
    service.runTurn({
      sessionId: 'session-web-evidence',
      runId: crypto.randomUUID(),
      assignmentId: crypto.randomUUID(),
      activityScopeId: 'scope-web-evidence',
      agentPath: 'agents/quick-scout',
      provider: 'openai',
      model: 'fixture/research-web',
      thinking: 'low',
      cwd: root,
      systemPrompt: 'Answer the user directly with observed source links.',
      userMessage,
      researchQuestion: userMessage,
      allowedServerIds: [],
      ...(onFinalRoundText ? { onFinalRoundText } : {}),
      ...(onFinalTextDelta ? { onFinalTextDelta } : {}),
    })
  return { discoveryUrl, makeService, runResearchTurn }
}

test('enforced web evidence publishes only the post-validation answer on the native route', async (t) => {
  const { discoveryUrl, makeService, runResearchTurn } =
    await makeResearchWebServiceFixture(t)
  const captured: CapturedWebEvidenceValidation[] = []
  const service = makeService(
    makeWebEvidenceOption({ links: 'enforce' }, captured),
  )
  const displayed: string[] = []
  const deltas: string[] = []

  const result = await runResearchTurn(
    service,
    (text) => displayed.push(text),
    undefined,
    (text) => deltas.push(text),
  )

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  // The provider cited two acquired pages and one discovery-only URL. The
  // candidate fails closed, and the display observer hears exactly one
  // publication — the validated response, never the raw candidate. The live
  // observer hears nothing: an answer is not streamed before it is validated.
  assert.equal(result.result.text, INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  assert.deepEqual(displayed, [INSUFFICIENT_WEB_RESEARCH_RESPONSE])
  assert.deepEqual(deltas, [], 'no live delta before validation')
  assert.equal(captured.length, 1)
  assert.match(captured[0]?.turnId ?? '', /.+/)
  assert.deepEqual(
    { ...captured[0], turnId: '<turn>', durationMs: '<duration>' },
    {
      turnId: '<turn>',
      stage: 'links',
      mode: 'enforce',
      providerKind: 'openai',
      providerRoute: 'mcp-native',
      observedUrlCount: 2,
      citedUrlCount: 3,
      unobservedUrlCount: 1,
      legacyDecision: 'accepted',
      decision: 'unobserved_url',
      displayedDiffersFromCandidate: true,
      persistedDiffersFromCandidate: true,
      enforcementWouldDiffer: true,
      durationMs: '<duration>',
    },
  )
  assert.ok(discoveryUrl)
})

test('shadow web evidence preserves the current answer and records the would-be difference', async (t) => {
  const { discoveryUrl, makeService, runResearchTurn } =
    await makeResearchWebServiceFixture(t)
  const captured: CapturedWebEvidenceValidation[] = []
  const service = makeService(
    makeWebEvidenceOption({ links: 'shadow' }, captured),
  )
  const displayed: string[] = []
  const deltas: string[] = []

  const result = await runResearchTurn(
    service,
    (text) => displayed.push(text),
    undefined,
    (text) => deltas.push(text),
  )

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  // Shadow must not alter the visible or persisted answer: the legacy guard
  // accepted this candidate, so the user keeps it, discovery-only URL and all.
  assert.match(result.result.text, /BRAVE_PATH_CONFIRMED/)
  assert.match(result.result.text, new RegExp(discoveryUrl.replace(/[/.]/g, '\\$&')))
  assert.equal(displayed.length, 1)
  assert.equal(displayed[0], result.result.text)
  // Shadow streams the candidate as it arrives, in more than one piece.
  assert.ok(deltas.length > 1, `the answer streams in several deltas: ${JSON.stringify(deltas)}`)
  assert.equal(deltas.join(''), result.result.text)
  // But the telemetry says what enforcement would have done.
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.mode, 'shadow')
  assert.equal(captured[0]?.decision, 'unobserved_url')
  assert.equal(captured[0]?.legacyDecision, 'accepted')
  assert.equal(captured[0]?.enforcementWouldDiffer, true)
  assert.equal(captured[0]?.displayedDiffersFromCandidate, false)
  assert.equal(captured[0]?.persistedDiffersFromCandidate, false)
})

test('shadow telemetry reports what the display stream actually showed, separately from what persisted', async (t) => {
  const { makeService, runResearchTurn } = await makeResearchWebServiceFixture(t)
  const captured: CapturedWebEvidenceValidation[] = []
  const service = makeService(
    makeWebEvidenceOption({ links: 'shadow' }, captured),
  )
  const displayed: string[] = []
  const deltas: string[] = []

  // TRAILING_INVITATION makes the fixture end its answer with a follow-up
  // offer, which the legacy guard strips: the persisted text then differs
  // from the candidate, while the display stream already showed the candidate.
  const result = await runResearchTurn(
    service,
    (text) => displayed.push(text),
    'What are current ice cream options in Ann Arbor? TRAILING_INVITATION',
    (text) => deltas.push(text),
  )

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  // Shadow user behavior is unchanged: the display saw the raw candidate,
  // invitation and all, and persistence kept the legacy guard's answer.
  assert.equal(displayed.length, 1)
  assert.match(displayed[0] ?? '', /If you want, I can compare more/)
  // The candidate reached the display stream in several deltas; the record
  // below is about all of them together.
  assert.ok(deltas.length > 1, `the answer streams in several deltas: ${JSON.stringify(deltas)}`)
  assert.equal(deltas.join(''), displayed[0])
  assert.doesNotMatch(result.result.text, /If you want/)
  assert.match(result.result.text, /BRAVE_PATH_CONFIRMED/)
  // The display-stream metric must be about the display stream: it showed the
  // candidate itself, so it did not differ — even though persistence did.
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.displayedDiffersFromCandidate, false)
  assert.equal(captured[0]?.persistedDiffersFromCandidate, true)
})

test('enforced web evidence on the CLI route replaces an answer citing an unobserved URL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-web-evidence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  t.after(() => settings.closeAll().catch(() => undefined))
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const observedUrl = 'https://stores.example/detroit'
  const discoveryUrl = 'https://search.example/detroit-stores'
  const captured: CapturedWebEvidenceValidation[] = []
  const service = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({
      storagePath: path.join(root, 'providers.json'),
    }),
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: [observedResearchTool(observedUrl)],
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      const transport = new StreamableHTTPClientTransport(
        new URL(options.mcpBridge.url),
        {
          requestInit: {
            headers: { authorization: `Bearer ${options.mcpBridge.token}` },
          },
        },
      )
      const client = new Client({
        name: 'pipeline-web-evidence-cli-fixture',
        version: '1.0.0',
      })
      try {
        await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
        const listed = await client.listTools(undefined, { timeout: 2_000 })
        const tool = listed.tools[0]
        assert.ok(tool)
        await client.callTool(
          { name: tool.name, arguments: { action: 'acquire' } },
          undefined,
          { timeout: 2_000 },
        )
      } finally {
        await client.close().catch(() => undefined)
      }
      return providerResult(
        `Detroit shoe store: ${observedUrl} and ${discoveryUrl}`,
        options.model,
      )
    },
    webEvidence: makeWebEvidenceOption({ links: 'enforce' }, captured),
  })

  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath)
  const displayed: string[] = []
  const result = await service.runTurn({
    sessionId: 'session-cli-web-evidence',
    runId: crypto.randomUUID(),
    assignmentId: crypto.randomUUID(),
    activityScopeId: 'scope-cli-web-evidence',
    agentPath: 'agents/quick-scout',
    provider: 'codex',
    model: 'gpt-test',
    thinking: 'medium',
    cwd: assignmentPath,
    systemPrompt: 'Answer the user directly with observed source links.',
    userMessage: 'Find shoe stores in Detroit.',
    researchQuestion: 'Find shoe stores in Detroit.',
    allowedServerIds: [],
    onFinalRoundText: (text) => displayed.push(text),
  })

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  assert.equal(result.result.text, INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  // The CLI route has no final-round observer; the one display publication is
  // the chat boundary's, from the same validated text that is persisted.
  assert.deepEqual(displayed, [])
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.providerRoute, 'mcp-cli')
  assert.equal(captured[0]?.decision, 'unobserved_url')
  assert.equal(captured[0]?.mode, 'enforce')
})

test('explicit off rollout config keeps the current guard and records no telemetry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cli-web-evidence-off-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  t.after(() => settings.closeAll().catch(() => undefined))
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const observedUrl = 'https://stores.example/detroit'
  const captured: CapturedWebEvidenceValidation[] = []
  const service = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({
      storagePath: path.join(root, 'providers.json'),
    }),
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: [observedResearchTool(observedUrl)],
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      const transport = new StreamableHTTPClientTransport(
        new URL(options.mcpBridge.url),
        {
          requestInit: {
            headers: { authorization: `Bearer ${options.mcpBridge.token}` },
          },
        },
      )
      const client = new Client({
        name: 'pipeline-web-evidence-off-fixture',
        version: '1.0.0',
      })
      try {
        await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
        const listed = await client.listTools(undefined, { timeout: 2_000 })
        const tool = listed.tools[0]
        assert.ok(tool)
        await client.callTool(
          { name: tool.name, arguments: { action: 'acquire' } },
          undefined,
          { timeout: 2_000 },
        )
      } finally {
        await client.close().catch(() => undefined)
      }
      return providerResult(`Detroit shoe store: ${observedUrl}`, options.model)
    },
    webEvidence: makeWebEvidenceOption({ links: 'off' }, captured),
  })

  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath)
  const result = await service.runTurn({
    sessionId: 'session-cli-web-evidence-off',
    runId: crypto.randomUUID(),
    assignmentId: crypto.randomUUID(),
    activityScopeId: 'scope-cli-web-evidence-off',
    agentPath: 'agents/web-researcher',
    provider: 'codex',
    model: 'gpt-test',
    thinking: 'medium',
    cwd: assignmentPath,
    systemPrompt: 'Answer the user directly with observed source links.',
    userMessage: 'Find shoe stores in Detroit.',
    researchQuestion: 'Find shoe stores in Detroit.',
    allowedServerIds: [],
  })

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  assert.equal(result.result.text, `Detroit shoe store: ${observedUrl}`)
  assert.equal(captured.length, 0, 'off mode records no validation telemetry')
})

test('an undefined recorder under enforcement is surfaced as incomplete telemetry, not silently ignored', async (t) => {
  const { makeService: _makeService, runResearchTurn: _run } =
    await makeResearchWebServiceFixture(t)
  const displayed: string[] = []
  const warnings: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    warnings.push(String(chunk))
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  t.after(() => {
    process.stderr.write = originalWrite
  })

  const service = _makeService({
    config: parseWebEvidenceRolloutConfig({ links: 'enforce' }),
    resolveRecorder: async () => undefined,
  })
  const result = await _run(service, (text) => displayed.push(text))

  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  // The verdict is unchanged — telemetry must never expose an unsafe answer —
  // but the missing recorder is loud: silent absence reads as a cohort with
  // zero rejections.
  assert.equal(result.result.text, INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  assert.deepEqual(displayed, [INSUFFICIENT_WEB_RESEARCH_RESPONSE])
  assert.ok(
    warnings.some((warning) => warning.includes('web-evidence-validation')),
    'an undefined recorder must be logged as incomplete rollout evidence',
  )
})

test('two validations in one assignment record two distinct journal events', async (t) => {
  // The worker route passes the long-lived workflow runId unchanged, so two
  // turns in one assignment share session/run/assignment identity. Each
  // validation is its own fact and must land as its own event — a collision
  // would silently cost the second one its rollout evidence.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-web-evidence-turns-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const scope = {
    sessionId: 'session-worker',
    runId: 'run-worker',
    assignmentId: 'assignment-worker',
  }
  fs.mkdirSync(
    path.join(
      workspacePath,
      'sessions',
      scope.sessionId,
      'runs',
      scope.runId,
      'assignments',
      scope.assignmentId,
    ),
    { recursive: true },
  )
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  t.after(() => registry.close())

  const manager = new McpClientManager()
  const settings = new McpSettingsService({
    storagePath: path.join(root, 'mcps.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
    clientManager: manager,
  })
  t.after(() => settings.closeAll().catch(() => undefined))
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({
    lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
    settingsService: settings,
    clientManager: manager,
    grantResolver: () => false,
    leaseResolver: (context) => leases.resolve(context),
  })
  const observedUrl = 'https://stores.example/detroit'
  const discoveryUrl = 'https://search.example/detroit-stores'
  const answers = [
    `Detroit shoe store: ${observedUrl} and ${discoveryUrl}`,
    `Detroit shoe store: ${observedUrl}`,
  ]
  const service = new McpAgentToolService({
    broker,
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({
      storagePath: path.join(root, 'providers.json'),
    }),
    providerSupportResolver: ({ provider }) => ({
      provider,
      state: 'supported',
      mode: 'host-tool-bridge',
    }),
    builtinAgentTools: [observedResearchTool(observedUrl)],
    cliProviderExecutor: async (_provider, options) => {
      assert.ok(options.mcpBridge)
      const transport = new StreamableHTTPClientTransport(
        new URL(options.mcpBridge.url),
        {
          requestInit: {
            headers: { authorization: `Bearer ${options.mcpBridge.token}` },
          },
        },
      )
      const client = new Client({
        name: 'pipeline-web-evidence-turns-fixture',
        version: '1.0.0',
      })
      try {
        await client.connect(new ExactOptionalMcpTransport(transport), { timeout: 2_000 })
        const listed = await client.listTools(undefined, { timeout: 2_000 })
        const tool = listed.tools[0]
        assert.ok(tool)
        await client.callTool(
          { name: tool.name, arguments: { action: 'acquire' } },
          undefined,
          { timeout: 2_000 },
        )
      } finally {
        await client.close().catch(() => undefined)
      }
      const answer = answers.shift()
      assert.ok(answer, 'the fixture expected exactly two turns')
      return providerResult(answer, options.model)
    },
    webEvidence: {
      config: parseWebEvidenceRolloutConfig({ links: 'enforce' }),
      resolveRecorder: (input) =>
        resolveWebEvidenceValidationRecorder({
          registry,
          scope: input.scope,
          agentPath: input.agentPath,
          requestId: input.requestId,
          processIdentity: 'web-evidence-test',
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    },
  })

  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath)
  const decisions: string[] = []
  for (let turn = 0; turn < 2; turn += 1) {
    const result = await service.runTurn({
      ...scope,
      activityScopeId: scope.assignmentId,
      agentPath: 'agents/quick-scout',
      provider: 'codex',
      model: 'gpt-test',
      thinking: 'medium',
      cwd: assignmentPath,
      systemPrompt: 'Answer the user directly with observed source links.',
      userMessage: 'Find shoe stores in Detroit.',
      researchQuestion: 'Find shoe stores in Detroit.',
      allowedServerIds: [],
    })
    assert.equal(result.kind, 'completed')
    if (result.kind !== 'completed') return
    decisions.push(result.result.text)
  }
  // Both verdicts landed: the first turn failed closed, the second was accepted.
  assert.equal(decisions[0], INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  assert.match(decisions[1] ?? '', new RegExp(observedUrl.replace(/[/.]/g, '\\$&')))

  const lease = await registry.acquireJournalHandle({
    context: {
      contractVersion: 1,
      requestId: 'request-web-evidence-turns-read',
      ...scope,
      agentPath: 'agents/quick-scout',
      authority: { kind: 'runtime-assignment', processIdentity: 'web-evidence-test' },
    },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  })
  assert.ok(lease)
  const stream = await lease.journal.scanStream(
    WEB_EVIDENCE_VALIDATION_STREAM_KIND,
    scope.assignmentId,
  )
  await lease.release()
  const eventIds = stream.events.map((event) => event.eventId)
  assert.equal(new Set(eventIds).size, 2, 'each validation needs its own event identity')
  assert.deepEqual(reduceWebEvidenceValidationEvents(stream.events), {
    recordedCount: 2,
    acceptedCount: 1,
    insufficientCount: 1,
    wouldDifferCount: 1,
    invalidCount: 0,
    byDecision: { unobserved_url: 1, accepted: 1 },
  })
})
