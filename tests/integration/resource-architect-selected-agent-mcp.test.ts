import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ResourceArchitectPlan } from '../../contracts/resource-architect.js'
import { McpAgentGrantsService } from '../../services/mcp-agent-grants-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import {
  runResourceArchitectTurnService,
  type ResourceArchitectStorePort,
} from '../../services/resource-architect-service.js'
import {
  startFakeChatCompletionsServer,
  type FakeChatCompletionsServer,
} from '../support/fake-chat-completions-server.js'
import {
  SELECTED_AGENT,
  SELECTED_PACKAGE_MARKERS,
  selectedPackageBlock,
  writeSelectedAgentPackage,
} from '../support/selected-agent-package-fixture.js'

/**
 * Connection configuration the settings store holds for these servers. The
 * Tools tab never shows any of it, so none of it may reach a model.
 */
const CONNECTION_SECRETS = [
  'secret-bin/ledger-mcp',
  '--ledger-profile',
  'secret-args-profile',
  'secret-working-directory',
  'LEDGER_API_TOKEN',
  'CIPHERTEXT-ENV-SECRET',
  'mcp.example.test',
  'secret-http-path',
  'x-api-key',
  'CIPHERTEXT-HEADER-SECRET',
  'auth.example.test',
  'secret-oauth-client-id',
  'secret.scope.read',
  'refresh_token',
  'CIPHERTEXT-OAUTH-SECRET',
] as const

/**
 * The store resolves a stdio command and working directory to real paths when
 * it loads, so both exist under the fixture directory.
 */
function settingsWithConnectionSecrets(directory: string): unknown {
  return {
    version: 1,
    servers: [
      {
        id: 'ledger-tools',
        name: 'Ledger Tools',
        enabled: true,
        capabilityAliases: [],
        transport: {
          type: 'stdio',
          command: path.join(directory, 'secret-bin', 'ledger-mcp'),
          args: ['--ledger-profile', 'secret-args-profile'],
          cwd: path.join(directory, 'secret-working-directory'),
          encryptedEnvironment: {
            LEDGER_API_TOKEN: { format: 'opaque-platform-ciphertext', ciphertext: 'CIPHERTEXT-ENV-SECRET' },
          },
        },
        status: 'disconnected',
        capabilities: { logging: false },
      },
      {
        id: 'filing-cabinet',
        name: 'Filing Cabinet',
        enabled: true,
        capabilityAliases: [],
        transport: {
          type: 'streamable-http',
          url: 'https://mcp.example.test/secret-http-path',
          encryptedHeaders: {
            'X-Api-Key': { format: 'opaque-platform-ciphertext', ciphertext: 'CIPHERTEXT-HEADER-SECRET' },
          },
          authentication: {
            type: 'oauth',
            authorizationServerUrl: 'https://auth.example.test/secret-oauth-server',
            clientId: 'secret-oauth-client-id',
            scopes: ['secret.scope.read'],
            status: 'authorized',
            encryptedCredentials: {
              refresh_token: { format: 'opaque-platform-ciphertext', ciphertext: 'CIPHERTEXT-OAUTH-SECRET' },
            },
          },
        },
        status: 'connected',
        capabilities: { logging: false },
      },
      {
        id: 'retired',
        name: 'Retired Server',
        enabled: false,
        capabilityAliases: [],
        transport: { type: 'streamable-http', url: 'https://retired.example.test/mcp', encryptedHeaders: {}, authentication: { type: 'none' } },
        status: 'disabled',
        capabilities: { logging: false },
      },
    ],
    agentGrants: [
      { agentPath: `agents/${SELECTED_AGENT}`, serverId: 'ledger-tools', enabled: true },
      { agentPath: `agents/${SELECTED_AGENT}`, serverId: 'retired', enabled: true },
    ],
  }
}

interface Fixture {
  readonly repoRoot: string
  readonly storagePath: string
  readonly grants: McpAgentGrantsService
  readonly provider: FakeChatCompletionsServer
  /** One Agent Architect conversation turn with the selected Agent open. */
  turn(): Promise<void>
}

async function withSelectedAgentMcp(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-selected-mcp-'))
  const repoRoot = path.join(directory, 'project')
  const storagePath = path.join(directory, 'user-data', 'mcp-settings.json')
  writeArchitectConfig(repoRoot)
  writeSelectedAgentPackage(repoRoot)
  fs.mkdirSync(path.dirname(storagePath), { recursive: true })
  fs.mkdirSync(path.join(directory, 'secret-bin'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'secret-bin', 'ledger-mcp'), '#!/bin/sh\n', { mode: 0o755 })
  fs.mkdirSync(path.join(directory, 'secret-working-directory'), { recursive: true })
  fs.writeFileSync(storagePath, `${JSON.stringify(settingsWithConnectionSecrets(directory), null, 2)}\n`)
  // The real settings store and grant service the Tools tab reads. The default
  // provider-support resolver answers from the provider name for the pairs used
  // here without any external call, so no boundary is replaced.
  const settingsService = new McpSettingsService({ storagePath })
  const grants = new McpAgentGrantsService({ repoRootPath: repoRoot, settingsService })
  const provider = await startFakeChatCompletionsServer({ script: [{ content: 'Answered from the package.' }] })
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'synthetic-test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = `${provider.url}/v1/chat/completions`
  let turns = 0
  try {
    await run({
      repoRoot,
      storagePath,
      grants,
      provider,
      turn: async () => {
        turns += 1
        await runResourceArchitectTurnService({
          repoRootPath: repoRoot,
          store: new EmptyStore(),
          operation: 'conversation',
          reviewEnabled: false,
          history: [{ role: 'user', text: 'Which MCP servers can this Agent use?' }],
          currentPlan: null,
          selectedResource: { kind: 'agent', id: SELECTED_AGENT },
          mcpAgentGrants: grants,
          jobId: `selected-mcp-turn-${turns}`,
        })
      },
    })
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    await settingsService.closeAll()
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function mcpRow(row: Awaited<ReturnType<McpAgentGrantsService['listServers']>>[number]): string {
  const yes = (value: boolean): string => (value ? 'yes' : 'no')
  return `- ${row.name} (id: ${row.id}, transport: ${row.transport}, status: ${row.status}, ` +
    `enabled: ${yes(row.enabled)}, granted: ${yes(row.granted)}, compatible: ${yes(row.compatible)}`
}

test('the selected Agent reaches the architect with the MCP rows its Tools tab shows and none of their connection configuration', async () => {
  await withSelectedAgentMcp(async ({ grants, provider, turn }) => {
    const toolsTab = await grants.listServers(SELECTED_AGENT)
    assert.deepEqual(
      toolsTab.map((row) => [row.name, row.granted, row.compatible]),
      [['Filing Cabinet', false, true], ['Ledger Tools', true, true]],
      'the Tools tab lists the globally enabled servers and this Agent\'s grant',
    )

    await turn()

    const [request] = provider.requests
    assert.ok(request, 'the architect was asked')
    const block = selectedPackageBlock(request.systemPrompt ?? '')
    assert.ok(block, 'the selected package reached the architect')
    for (const row of toolsTab) {
      assert.ok(block.includes(mcpRow(row)), `the Tools tab row for ${row.name} reached the architect`)
    }
    assert.ok(!block.includes('Retired Server'), 'a globally disabled server is not offered')
    const wholeRequest = JSON.stringify(request.body).toLowerCase()
    for (const secret of CONNECTION_SECRETS) {
      assert.ok(!wholeRequest.includes(secret.toLowerCase()), `${secret} stayed out of the provider request`)
    }
  })
})

test('an MCP row the selected Agent cannot use carries the refusal reason the Tools tab shows', async () => {
  await withSelectedAgentMcp(async ({ repoRoot, grants, provider, turn }) => {
    const personaPath = path.join(repoRoot, 'agents', SELECTED_AGENT, `${SELECTED_AGENT}.md`)
    fs.writeFileSync(
      personaPath,
      fs.readFileSync(personaPath, 'utf8').replace('provider: openai\nmodel: gpt-5.4', 'provider: gemini\nmodel: gemini-pro'),
    )
    const toolsTab = await grants.listServers(SELECTED_AGENT)
    const refused = toolsTab.find((row) => row.name === 'Ledger Tools')
    assert.ok(refused, 'the Tools tab still lists the granted server')
    assert.equal(refused.compatible, false)
    assert.ok(refused.reason, 'the Tools tab states why the Agent cannot use it')

    await turn()

    const block = selectedPackageBlock(provider.requests[0]?.systemPrompt ?? '')
    assert.ok(block?.includes(mcpRow(refused)), 'the refused row reached the architect')
    assert.ok(block?.includes(`reason: ${refused.reason}`), 'with the reason the Tools tab shows')
  })
})

test('unreadable MCP settings leave a named context warning while the saved package still arrives', async () => {
  await withSelectedAgentMcp(async ({ storagePath, provider, turn }) => {
    fs.writeFileSync(storagePath, '{ this is not JSON')

    await turn()

    const system = provider.requests[0]?.systemPrompt ?? ''
    assert.match(system, new RegExp(`Context warning: the MCP grant state for ${SELECTED_AGENT} could not be read \\(MCP settings file is invalid\\.\\)`))
    assert.ok(selectedPackageBlock(system)?.includes(SELECTED_PACKAGE_MARKERS.skill))
  })
})

// The timeout only bounds a hung run; the test waits on the turn's own rejection.
test('Stop ends a turn that is still waiting for the selected Agent\'s MCP grant state', { timeout: 10_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-selected-mcp-stop-'))
  const repoRoot = path.join(directory, 'project')
  writeArchitectConfig(repoRoot)
  writeSelectedAgentPackage(repoRoot)
  // Stands in for a grant read held up by provider-support probing, which can
  // spawn local CLIs. It never settles, so only Stop can end the turn.
  let reportAsked: () => void = () => undefined
  const asked = new Promise<void>((resolve) => { reportAsked = resolve })
  const stalledGrants = {
    listServers: (): Promise<never> => {
      reportAsked()
      return new Promise<never>(() => undefined)
    },
  }
  const stop = new AbortController()
  try {
    const turn = runResourceArchitectTurnService({
      repoRootPath: repoRoot,
      store: new EmptyStore(),
      operation: 'conversation',
      reviewEnabled: false,
      history: [{ role: 'user', text: 'Which MCP servers can this Agent use?' }],
      currentPlan: null,
      selectedResource: { kind: 'agent', id: SELECTED_AGENT },
      mcpAgentGrants: stalledGrants,
      jobId: 'selected-mcp-stop',
      signal: stop.signal,
      // The turn deadline is not under test; Stop is.
      createTurnTimeoutSignal: () => new AbortController().signal,
    })
    await asked
    stop.abort()

    await assert.rejects(turn, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

class EmptyStore implements ResourceArchitectStorePort {
  async savePlan(_plan: ResourceArchitectPlan): Promise<void> {}
  async getPlan(): Promise<null> { return null }
  claimPlan(): () => void { return () => undefined }
  async saveJob(): Promise<void> {}
  async getJob(): Promise<null> { return null }
  async listJobs(): Promise<[]> { return [] }
}

function writeArchitectConfig(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, 'teams', 'resource-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'resource-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'resource-architect', 'team.yaml'),
    'agents:\n  - agent_file: ../../agents/resource-architect/resource-architect.md\n',
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'resource-architect', 'resource-architect.md'),
    '---\nprovider: openai\nmodel: test-model\nthinking: medium\n---\n\nHelp the user design Agents and Teams.\n',
  )
}
