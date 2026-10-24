import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import type { CapabilityDispatchEvent } from '../../contracts/capability-dispatch.js'
import { configuredProviderName } from '../../domains/provider/provider-settings.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { skillLoaderToolModule } from '../../server/tools/skill-loader.js'
import { startOpenAiToolLoopFixture } from '../support/openai-tool-loop-fixture.js'

const SESSION_ID = 'journey-fanout-session'
const RUN_ID = 'journey-fanout-run'

interface JourneyFixture {
  readonly repoRoot: string
  readonly workspace: string
  readonly assignmentIds: readonly string[]
  evidencePathFor(assignmentId: string): string
  readonly skillCalls: readonly {
    readonly id: string
    readonly name: string
    readonly arguments: { readonly source: string; readonly sha256: string }
  }[]
  readonly broker: McpParentBroker
  readonly leaseStore: McpRunLeaseStore
  readonly providerSettings: ProviderSettingsService
  readonly provider: string
  readonly skillTool: NonNullable<
    ReturnType<typeof skillLoaderToolModule.build>['agentTool']
  >
  readonly close: () => Promise<void>
}

test('a governed native turn overlaps eligible skill loads end to end', async (context) => {
  const fixture = await makeJourneyFixture(context, ['journey-assignment'])
  try {
    const parallel = await runJourneyTurn(fixture, {
      pool: undefined,
      assignmentId: 'journey-assignment',
    })
    const dispatches = readDispatches(fixture.evidencePathFor('journey-assignment'))

    const startedIds = dispatches
      .filter((event) => event.type === 'capability.dispatch.started')
      .map((event) => event.dispatchId)
    assert.equal(startedIds.length, 2)
    assert.equal(
      dispatches.filter((event) => isTerminalEvent(event)).length,
      2,
      'each dispatch must write exactly one terminal event',
    )
    const [firstId, secondId] = startedIds
    assert.ok(firstId && secondId)
    // The per-assignment evidence writer serializes appends, so file order is
    // a faithful linearization of event order: genuine overlap means the
    // second dispatch's started record precedes the first dispatch's terminal.
    const secondStartedAt = dispatches.findIndex(
      (event) => event.type === 'capability.dispatch.started' &&
        event.dispatchId === secondId,
    )
    const firstTerminalAt = dispatches.findIndex(
      (event) => isTerminalEvent(event) && event.dispatchId === firstId,
    )
    assert.ok(
      secondStartedAt < firstTerminalAt,
      `eligible governed dispatches must overlap through the real stack: ` +
        `second started at record ${secondStartedAt}, first terminal at ${firstTerminalAt}`,
    )
    assert.equal(parallel.kind, 'completed')
    if (parallel.kind === 'completed') {
      assert.equal(parallel.result.text, 'fanout complete')
    }
    for (const line of fs.readFileSync(
      fixture.evidencePathFor('journey-assignment'),
      'utf-8',
    ).split('\n')) {
      if (!line.trim()) continue
      JSON.parse(line)
      assert.doesNotMatch(line, /"arguments"/)
      assert.doesNotMatch(line, /SKILL\.md/)
    }
  } finally {
    await fixture.close()
  }
})

test('a serial twin produces identical governed outputs through the same journey', async (context) => {
  const fixture = await makeJourneyFixture(context, [
    'journey-assignment-parallel',
    'journey-assignment-serial',
  ])
  try {
    const parallel = await runJourneyTurn(fixture, {
      pool: undefined,
      assignmentId: 'journey-assignment-parallel',
    })
    const serial = await runJourneyTurn(fixture, {
      pool: 1,
      assignmentId: 'journey-assignment-serial',
    })

    assert.equal(parallel.kind, 'completed')
    assert.equal(serial.kind, 'completed')
    if (parallel.kind !== 'completed' || serial.kind !== 'completed') return
    assert.equal(parallel.result.text, serial.result.text)
    assert.equal(parallel.result.toolCallCount, serial.result.toolCallCount)
    assert.equal(
      parallel.result.executedToolCallCount,
      serial.result.executedToolCallCount,
    )
    assert.deepEqual(
      completedArgumentDigests(
        readDispatches(fixture.evidencePathFor('journey-assignment-parallel')),
      ),
      completedArgumentDigests(
        readDispatches(fixture.evidencePathFor('journey-assignment-serial')),
      ),
    )

    const dispatches = readDispatches(
      fixture.evidencePathFor('journey-assignment-serial'),
    )
    const serialStarted = dispatches.filter(
      (event) => event.type === 'capability.dispatch.started',
    )
    const serialTerminals = dispatches.filter((event) => isTerminalEvent(event))
    assert.equal(serialStarted.length, 2)
    assert.equal(serialTerminals.length, 2)
    // File order linearizes event order: in the serial twin the second
    // dispatch must start only after the first dispatch's terminal record.
    const secondSerialStart = dispatches.findIndex(
      (event) =>
        event.type === 'capability.dispatch.started' &&
        event.dispatchId === serialStarted[1]?.dispatchId,
    )
    const firstSerialTerminal = dispatches.findIndex(
      (event) =>
        isTerminalEvent(event) &&
        event.dispatchId === serialStarted[0]?.dispatchId,
    )
    assert.ok(
      secondSerialStart > firstSerialTerminal,
      `the serial twin must not overlap: second start at record ${secondSerialStart}, first terminal at ${firstSerialTerminal}`,
    )
  } finally {
    await fixture.close()
  }
})

type JourneyTurnResult = Awaited<ReturnType<McpAgentToolService['runTurn']>>

async function runJourneyTurn(
  fixture: JourneyFixture,
  options: {
    readonly pool: number | undefined
    readonly assignmentId: string
  },
): Promise<JourneyTurnResult> {
  const service = new McpAgentToolService({
    broker: fixture.broker,
    leaseStore: fixture.leaseStore,
    providerSettingsService: fixture.providerSettings,
    providerSupportResolver: () => ({
      provider: fixture.provider,
      state: 'supported',
      mode: 'native-tool-loop',
    }),
    builtinAgentTools: [fixture.skillTool],
    ...whenDefined(options.pool, (pool) => ({
      maxConcurrentToolCalls: pool,
    })),
  })
  return service.runTurn({
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: options.assignmentId,
    agentPath: 'agents/analyst',
    provider: fixture.provider,
    model: 'fixture/fanout',
    thinking: 'low',
    systemPrompt: 'Load both skills in one turn.',
    userMessage: 'Load the analysis and review skills.',
  })
}

async function makeJourneyFixture(
  context: { after(hook: () => Promise<void> | void): unknown },
  assignmentIds: readonly string[],
): Promise<JourneyFixture> {
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-journey-repo-')),
  )
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-journey-workspace-')),
  )
  const evidencePathFor = (assignmentId: string): string => path.join(
    workspace,
    'sessions',
    SESSION_ID,
    'runs',
    RUN_ID,
    'assignments',
    assignmentId,
    'logs',
    'capability-dispatch-events.jsonl',
  )
  for (const assignmentId of assignmentIds) {
    fs.mkdirSync(path.dirname(evidencePathFor(assignmentId)), { recursive: true })
  }

  const skillCalls = ['analysis', 'review'].map((name) => {
    const skillPath = path.join(
      repoRoot,
      'agents',
      'analyst',
      'skills',
      name,
      'SKILL.md',
    )
    const content = `# ${name} skill\n\nFollow the ${name} checklist.\n`
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    fs.writeFileSync(skillPath, content)
    return {
      id: `journey-call-${name}`,
      name: 'mcp__pipeline_skills__load_skill',
      arguments: {
        source: skillPath,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    }
  })

  const providerFixture = await startOpenAiToolLoopFixture(process.cwd(), 'openai-tool-loop-server.mjs', {
    env: {
      PROVIDER_FANOUT_SCRIPT: JSON.stringify({
        calls: skillCalls,
        finalText: 'fanout complete',
      }),
    },
  })
  const clientManager = new McpClientManager({
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  })
  const leaseStore = new McpRunLeaseStore()
  const settings = new McpSettingsService({
    storagePath: path.join(workspace, 'mcps.json'),
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
    grantResolver: () => true,
    leaseResolver: (mcpContext) => leaseStore.resolve(mcpContext),
  })
  const providerSettings = new ProviderSettingsService({
    storagePath: path.join(workspace, 'providers.json'),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
  })
  const runtime = new CapabilityDispatchRuntime({
    workspacePath: workspace,
    leaseResolver: (leaseContext) => leaseStore.resolve(leaseContext),
    runtimeAuthority: {
      authorize: async () => {
        throw new Error('Runtime authority must not be reached in this journey.')
      },
    },
  })
  const contribution = skillLoaderToolModule.build({
    repoRootPath: repoRoot,
    capabilityDispatcher: runtime.dispatcher,
  })
  assert.ok(contribution.agentTool)
  const skillTool = contribution.agentTool

  const connection = await providerSettings.saveConnection({
    kind: 'openai-compatible',
    name: 'Fanout journey fixture',
    baseUrl: `${providerFixture.url}/v1`,
    apiKey: 'fanout-journey-key',
    enabled: true,
  })
  await providerSettings.validateConnection(connection.id)
  await providerSettings.setModelEnabled(connection.id, 'fixture/fanout', true)
  const provider = configuredProviderName(connection.id)

  const close = async (): Promise<void> => {
    await settings.closeAll()
    await runtime.close()
    await providerFixture.close()
    fs.rmSync(repoRoot, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  }
  context.after(() => close())
  return {
    repoRoot,
    workspace,
    assignmentIds,
    evidencePathFor,
    skillCalls,
    broker,
    leaseStore,
    providerSettings,
    provider,
    skillTool,
    close,
  }
}

function readDispatches(evidencePath: string): CapabilityDispatchEvent[] {
  const content = fs.readFileSync(evidencePath, 'utf-8')
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CapabilityDispatchEvent)
}

function isTerminalEvent(event: CapabilityDispatchEvent): boolean {
  return event.type === 'capability.dispatch.completed' ||
    event.type === 'capability.dispatch.rejected' ||
    event.type === 'capability.dispatch.cancelled' ||
    event.type === 'capability.dispatch.failed' ||
    event.type === 'capability.dispatch.indeterminate'
}

function completedArgumentDigests(
  events: readonly CapabilityDispatchEvent[],
): string[] {
  return events
    .filter((event) => event.type === 'capability.dispatch.completed')
    .map((event) => event.argumentDigest)
    .sort()
}

function whenDefined<T, R>(
  value: T | undefined,
  map: (defined: T) => R,
): R | undefined {
  return value === undefined ? undefined : map(value)
}
