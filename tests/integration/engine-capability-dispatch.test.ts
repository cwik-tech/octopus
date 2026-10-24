import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  defineTool,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { whenDefined } from '../../core/optional-properties.js'

import type {
  CapabilityAdapter,
  CapabilityBudgetPort,
  CapabilityDispatchEvent,
  CapabilityExecutionContext,
} from '../../contracts/capability-dispatch.js'
import type { DelegationStatusSnapshot } from '../../core/types.js'
import type {
  BaseEngineContext,
  ChainStageConfig,
  RuntimeState,
  PipelineStageConfig,
  TeamConfig,
  TeamRegistryEntry,
} from '../../core/types.js'
import {
  LEVEL_STATUS,
  STAGE_LIFECYCLE_STATUS,
  STAGE_TYPE,
} from '../../core/constants.js'
import { recordDelegationLifecycle } from '../../domains/delegation/delegation-lifecycle.js'
import { createSpawnTeamTool } from '../../engines/spawn-tools.js'
import { createSpawnWorkflowTool } from '../../engines/spawn-workflows.js'
import { createPipelineTool } from '../../engines/pipeline.js'
import { createChainTool } from '../../engines/chain.js'
import {
  DELEGATION_ENGINE_TOOL_NAMES,
  ENGINE_TOOL_CAPABILITY_IDS,
  STANDARD_ENGINE_TOOL_NAMES,
  createDelegationToolAdapterFactory,
  createEngineToolAdapterFactory,
  type DelegationCapabilityOutcome,
} from '../../services/engine-capability-adapter.js'
import {
  TeamRuntimeToolDispatchError,
  governTeamRuntimeTool,
} from '../../team-runtime/capability-tool-adapter.js'
import {
  TeamRuntimeCapabilityBudgetPort,
  isTeamRuntimeEngineCapabilityMetered,
} from '../../team-runtime/capability-budget-port.js'
import { BudgetLedger } from '../../core/budget-ledger.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import type { WorkflowRegistryEntry } from '../../workflows/types.js'
import { initProviders } from '../../providers/index.js'
import { dispatchWithFailurePolicy } from '../../domains/agent-execution/failure-policy.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const PARAMETERS = Type.Object({ value: Type.String() })
const MODEL_SOURCE = {
  kind: 'pi-host' as const,
  id: 'team-runtime:pi-model',
  version: '1',
}
const RUNTIME_SOURCE = {
  kind: 'engine' as const,
  id: 'team-runtime:runtime-autostart',
  version: '1',
}

test('every named engine tool keeps its wire result while crossing common dispatch', async () => {
  const events: CapabilityDispatchEvent[] = []
  const dispatcher = createCapabilityTestDispatcher(events)
  const expectedToolNames = [
    'set_roster',
    'create_brief',
    'converse',
    'dispatch',
    'handoff',
    'broadcast',
    'submit_for_review',
  ]

  assert.deepEqual(STANDARD_ENGINE_TOOL_NAMES, expectedToolNames)
  assert.ok(
    [...STANDARD_ENGINE_TOOL_NAMES, ...DELEGATION_ENGINE_TOOL_NAMES].every(
      (toolName) =>
        isTeamRuntimeEngineCapabilityMetered(
          ENGINE_TOOL_CAPABILITY_IDS[toolName],
        ),
    ),
    'all nine named engine capabilities must use the production budget port',
  )
  for (const [index, toolName] of STANDARD_ENGINE_TOOL_NAMES.entries()) {
    const expected = {
      content: [{ type: 'text' as const, text: `${toolName}:alpha` }],
      details: { toolName, retained: true },
    }
    const rawTool = defineTool({
      name: toolName,
      label: toolName,
      description: `Integration fixture for ${toolName}.`,
      parameters: PARAMETERS,
      async execute() {
        return expected
      },
    })
    const governed = governTeamRuntimeTool({
      tool: rawTool,
      dispatcher,
      getContext: () => makeContext(index),
      modelSource: MODEL_SOURCE,
      runtimeSource: RUNTIME_SOURCE,
      adapterFactory: createEngineToolAdapterFactory({ toolName }),
    })

    const result = await governed.invoke({
      channel: index % 2 === 0 ? 'model' : 'runtime',
      toolCallId: `engine-tool-call-${index}`,
      input: { value: 'alpha' },
      extensionContext: emptyExtensionContext(),
    })

    assert.equal(result, expected)
  }

  const started = events.filter((event) =>
    event.type === 'capability.dispatch.started'
  )
  assert.deepEqual(
    started.map((event) => event.capabilityId),
    STANDARD_ENGINE_TOOL_NAMES.map((name) => ENGINE_TOOL_CAPABILITY_IDS[name]),
  )
  assert.ok(started.every((event) => event.effect?.kind === 'mutating'))
})

test('serialized ordinary engine cost deltas start at executor entry', async () => {
  const firstExecuting = deferred<void>()
  const releaseFirst = deferred<void>()
  const budgetHarness = makeSerializedMeteredBudget()
  let totalCostUsd = 0
  const rawTool = defineTool({
    name: 'dispatch',
    label: 'Dispatch',
    description: 'Runs serialized cost-bearing engine work.',
    parameters: PARAMETERS,
    async execute(_toolCallId, params) {
      if (params.value === 'first') {
        firstExecuting.resolve()
        await releaseFirst.promise
      }
      await runShortChild()
      totalCostUsd += params.value === 'first' ? 1 : 2
      return toolResult(params.value)
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], {
      budget: budgetHarness.budget,
    }),
    getContext: () => makeContext(10),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createEngineToolAdapterFactory({
      toolName: 'dispatch',
      readTotalCostUsd: () => totalCostUsd,
    }),
  })

  const first = governed.invoke({
    channel: 'model',
    toolCallId: 'serialized-engine-cost-first',
    input: { value: 'first' },
    extensionContext: emptyExtensionContext(),
  })
  await firstExecuting.promise
  const second = governed.invoke({
    channel: 'model',
    toolCallId: 'serialized-engine-cost-second',
    input: { value: 'second' },
    extensionContext: emptyExtensionContext(),
  })
  await budgetHarness.secondPreflightEntered
  releaseFirst.resolve()

  await Promise.all([first, second])
  assert.deepEqual(budgetHarness.actualCosts, [1, 2])
})

test('exhausted halt budget rejects dispatch before the real pipeline mutates its run-owned plan', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const sourcePlanPath = path.join(assignmentPath, 'source-plan.md')
  const sourcePlan = `
# Plan: Budget boundary
**Status:** draft

### S1: Execution

#### T1: Must remain pending
- **Agent:** writer
- **Status:** pending
- **Validate:** false
- **Depends on:** none
- **Gate:** false
- **Result file:** output/result.md
`
  await writeFile(sourcePlanPath, sourcePlan, 'utf8')
  const ledger = new BudgetLedger({ capUsd: 1, policy: 'halt' })
  const { context, state } = makePipelineBudgetContext({
    assignmentPath,
    sourcePlanPath,
    totalCostUsd: 1,
    ledger,
  })
  const budgetPort = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => state.totalCost,
    isMetered: isTeamRuntimeEngineCapabilityMetered,
  })
  const governed = governTeamRuntimeTool({
    tool: createPipelineTool(context),
    dispatcher: createCapabilityTestDispatcher([], { budget: budgetPort }),
    budgetAdoptionScope: budgetPort,
    getContext: () => makeContext(11),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createEngineToolAdapterFactory({
      toolName: 'dispatch',
      readTotalCostUsd: () => state.totalCost,
    }),
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'exhausted-pipeline-dispatch',
      input: { task_id: 'T1' },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) =>
      error instanceof TeamRuntimeToolDispatchError &&
      error.status === 'rejected' &&
      error.code === 'budget_exceeded',
  )

  assert.equal(
    state.levelStates.get('execution')?.engineState,
    null,
    'the raw pipeline executor must not initialize engine state',
  )
  assert.equal(await readFile(sourcePlanPath, 'utf8'), sourcePlan)
  await assert.rejects(
    access(path.join(assignmentPath, '.runtime', 'pipeline', 'execution', 'plan.md')),
  )
})

test('exhausted halt budget rejects handoff before the real chain mutates state or writes its brief', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const ledger = new BudgetLedger({ capUsd: 1, policy: 'halt' })
  const { context, state } = makeChainBudgetContext({
    assignmentPath,
    totalCostUsd: 1,
    ledger,
  })
  const budgetPort = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => state.totalCost,
    isMetered: isTeamRuntimeEngineCapabilityMetered,
  })
  const governed = governTeamRuntimeTool({
    tool: createChainTool(context),
    dispatcher: createCapabilityTestDispatcher([], { budget: budgetPort }),
    budgetAdoptionScope: budgetPort,
    getContext: () => makeContext(12),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createEngineToolAdapterFactory({
      toolName: 'handoff',
      readTotalCostUsd: () => state.totalCost,
    }),
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'exhausted-chain-handoff',
      input: { action: 'start', message: 'Do not execute this chain.' },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) =>
      error instanceof TeamRuntimeToolDispatchError &&
      error.status === 'rejected' &&
      error.code === 'budget_exceeded',
  )

  assert.equal(
    state.levelStates.get('chain')?.engineState,
    null,
    'the raw chain executor must not initialize engine state',
  )
  await assert.rejects(access(path.join(assignmentPath, 'brief.md')))
})

test('non-exhausted handoff adopts the outer reservation while a real provider child completes', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const binPath = path.join(assignmentPath, 'bin')
  const piPath = path.join(binPath, 'pi')
  await mkdir(binPath, { recursive: true })
  await writeFile(
    piPath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'local-budget-fixture',
    usage: {
      input: 10,
      output: 20,
      totalTokens: 30,
      cost: { total: 2 }
    },
    content: [{ type: 'text', text: '# Completed locally' }]
  }
}) + '\\n')
// A real Pi run ends on agent_settled, not on message_end.
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`,
    'utf8',
  )
  await chmod(piPath, 0o755)

  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const { context, state } = makeChainBudgetContext({
    assignmentPath,
    totalCostUsd: 1,
    ledger,
  })
  const writer = context.agents.get('writer')
  if (!writer) throw new Error('Expected the local writer fixture.')
  writer.provider = 'pi'
  const budgetPort = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => state.totalCost,
    isMetered: isTeamRuntimeEngineCapabilityMetered,
  })
  context.adoptCapabilityBudget = (toolCallId) => budgetPort.adopt(toolCallId)
  const governed = governTeamRuntimeTool({
    tool: createChainTool(context),
    dispatcher: createCapabilityTestDispatcher([], { budget: budgetPort }),
    budgetAdoptionScope: budgetPort,
    getContext: () => makeContext(13),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createEngineToolAdapterFactory({
      toolName: 'handoff',
      readTotalCostUsd: () => state.totalCost,
    }),
  })

  initProviders()
  const previousPath = process.env.PATH
  process.env.PATH = `${binPath}${path.delimiter}${previousPath ?? ''}`
  try {
    const result = await withTimeout(
      governed.invoke({
        channel: 'model',
        toolCallId: 'adopted-chain-handoff',
        input: { action: 'start', message: 'Complete one local chain step.' },
        extensionContext: emptyExtensionContext(),
      }),
      5_000,
      'governed handoff deadlocked on its own dispatcher reservation',
    )

    assert.match(
      result.content[0]?.type === 'text' ? result.content[0].text : '',
      /Chain Complete/,
    )
    assert.equal(state.totalCost, 3)
    assert.equal(ledger.reservedUsd, 0)
  } finally {
    process.env.PATH = previousPath
  }
})

test('concurrent adopted child dispatches re-read committed cost before a second real provider starts', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const binPath = path.join(assignmentPath, 'bin')
  const piPath = path.join(binPath, 'pi')
  const startsPath = path.join(assignmentPath, 'provider-starts.txt')
  await mkdir(binPath, { recursive: true })
  await writeFile(
    piPath,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(startsPath)}, 'started\\n')
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'local-budget-fanout',
    usage: {
      input: 10,
      output: 20,
      totalTokens: 30,
      cost: { total: 2 }
    },
    content: [{ type: 'text', text: 'child complete' }]
  }
}) + '\\n')
// A real Pi run ends on agent_settled, not on message_end.
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`,
    'utf8',
  )
  await chmod(piPath, 0o755)

  const state = makeRuntimeState()
  state.totalCost = 1
  const ledger = new BudgetLedger({ capUsd: 3, policy: 'halt' })
  const budgetPort = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => state.totalCost,
    isMetered: isTeamRuntimeEngineCapabilityMetered,
  })
  const rawTool = defineTool({
    name: 'broadcast',
    label: 'Budgeted broadcast',
    description: 'Runs two child dispatches under one governed envelope.',
    parameters: PARAMETERS,
    async execute(toolCallId, _params, signal) {
      const budgetAdmission = budgetPort.adopt(toolCallId)
      if (!budgetAdmission) {
        throw new Error('Expected the dispatcher-owned broadcast admission.')
      }
      const runChild = (name: string) => dispatchWithFailurePolicy({
        agent: { ...makeLoadedAgent(name, assignmentPath), provider: 'pi' },
        rosterEntry: { type: 'agent' },
        finalPrompt: 'Complete the local fixture.',
        userMessage: `Run ${name}.`,
        state,
        workspacePath: assignmentPath,
        outputPath: assignmentPath,
        metrics: undefined,
        ...whenDefined(signal, (definedSignal) => ({ signal: definedSignal })),
        triggerTool: 'broadcast',
        teamName: 'budget-fanout-team',
        fromName: 'coordinator',
        policy: { policy: 'halt', maxRetries: 0 },
        levelId: 'broadcast',
        stageType: STAGE_TYPE.BROADCAST,
        sessionId: state.sessionId,
        errorLogPath: assignmentPath,
        budgetLedger: ledger,
        totalCost: state.totalCost,
        budgetAdmission,
      })
      const results = await Promise.allSettled([
        runChild('first-child'),
        runChild('second-child'),
      ])
      return {
        content: [{
          type: 'text' as const,
          text: results.map((result) => result.status).join(','),
        }],
        details: undefined,
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], { budget: budgetPort }),
    budgetAdoptionScope: budgetPort,
    getContext: () => makeContext(14),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createEngineToolAdapterFactory({
      toolName: 'broadcast',
      readTotalCostUsd: () => state.totalCost,
    }),
  })

  initProviders()
  const previousPath = process.env.PATH
  process.env.PATH = `${binPath}${path.delimiter}${previousPath ?? ''}`
  try {
    const result = await withTimeout(
      governed.invoke({
        channel: 'model',
        toolCallId: 'adopted-budget-fanout',
        input: { value: 'fan-out' },
        extensionContext: emptyExtensionContext(),
      }),
      5_000,
      'adopted fan-out deadlocked on the outer dispatcher reservation',
    )

    assert.equal(
      result.content[0]?.type === 'text' ? result.content[0].text : '',
      'fulfilled,rejected',
    )
    assert.equal((await readFile(startsPath, 'utf8')).trim(), 'started')
    assert.equal(state.totalCost, 3)
    assert.equal(ledger.reservedUsd, 0)
  } finally {
    process.env.PATH = previousPath
  }
})

test('delegation reserves budget before a real child starts and settles its terminal cost', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const events: CapabilityDispatchEvent[] = []
  const order: string[] = []
  let totalCostUsd = 1.25
  let settledCostUsd: number | undefined
  const dispatcher = createCapabilityTestDispatcher(events, {
    budget: {
      preflight: async () => ({ kind: 'metered', estimateUsd: 0.5 }),
      reserve: async () => {
        order.push('budget-reserved')
        return { reservationId: 'delegation-reservation-1' }
      },
      settle: async ({ actualCostUsd }) => {
        order.push('budget-settled')
        settledCostUsd = actualCostUsd
        return {
          costTracked: true,
          budgetOverrun: false,
          ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
        }
      },
      release: async () => {
        order.push('budget-released')
      },
    },
  })
  const expected = {
    content: [{ type: 'text' as const, text: 'delegation complete' }],
    details: { child: 'child-terminal-1' },
  }
  const rawTool = defineTool({
    name: 'spawn_team',
    label: 'Spawn team',
    description: 'Runs one real child process.',
    parameters: PARAMETERS,
    async execute() {
      recordLifecycle(assignmentPath, 'delegation-terminal-1', 'queued')
      recordLifecycle(assignmentPath, 'delegation-terminal-1', 'running')
      order.push('child-started')
      await runShortChild()
      totalCostUsd = 1.6
      recordLifecycle(assignmentPath, 'delegation-terminal-1', 'completed')
      order.push('child-terminal')
      return expected
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher,
    getContext: () => makeContext(20),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDelegationToolAdapterFactory({
      toolName: 'spawn_team',
      assignmentPath,
      readTotalCostUsd: () => totalCostUsd,
    }),
  })

  const result = await governed.invoke({
    channel: 'model',
    toolCallId: 'delegation-terminal-call-1',
    input: { value: 'alpha' },
    extensionContext: emptyExtensionContext(),
  })

  assert.equal(result, expected)
  assert.deepEqual(order, [
    'budget-reserved',
    'child-started',
    'child-terminal',
    'budget-settled',
    'budget-released',
  ])
  assert.ok(settledCostUsd !== undefined)
  assert.ok(Math.abs(settledCostUsd - 0.35) < 0.000_001)
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
    ],
  )
})

test('serialized delegation calls bind lifecycle at executor entry and retain the lane through child execution', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const firstChildRunning = deferred<void>()
  const releaseFirst = deferred<void>()
  const secondPrepared = deferred<void>()
  const secondQueued = deferred<void>()
  const serialScheduler = new PerAuthorityCapabilityExecutionScheduler()
  let preflightCount = 0
  let schedulerCalls = 0
  let secondExecuted = false
  const dispatcher = createCapabilityTestDispatcher([], {
    budget: {
      preflight: async () => {
        preflightCount += 1
        if (preflightCount === 2) secondPrepared.resolve()
        return { kind: 'not-metered' }
      },
      reserve: async () => {
        throw new Error('A not-metered delegation must not reserve budget.')
      },
      settle: async () => {
        throw new Error('A not-metered delegation must not settle budget.')
      },
      release: async () => undefined,
    },
    scheduler: {
      run: async (input) => {
        schedulerCalls += 1
        if (schedulerCalls === 2) secondQueued.resolve()
        return serialScheduler.run(input)
      },
    },
  })
  const rawTool = defineTool({
    name: 'spawn_team',
    label: 'Spawn team',
    description: 'Runs serialized child processes.',
    parameters: PARAMETERS,
    async execute(_toolCallId, params) {
      const delegationId = `delegation-${params.value}`
      recordLifecycle(assignmentPath, delegationId, 'queued')
      recordLifecycle(assignmentPath, delegationId, 'running')
      if (params.value === 'first') {
        firstChildRunning.resolve()
        await releaseFirst.promise
      } else {
        secondExecuted = true
      }
      await runShortChild()
      recordLifecycle(assignmentPath, delegationId, 'completed')
      return toolResult(params.value)
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher,
    getContext: () => makeContext(21),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDelegationToolAdapterFactory({
      toolName: 'spawn_team',
      assignmentPath,
    }),
  })

  const first = governed.invoke({
    channel: 'model',
    toolCallId: 'serialized-delegation-first',
    input: { value: 'first' },
    extensionContext: emptyExtensionContext(),
  })
  await firstChildRunning.promise
  const second = governed.invoke({
    channel: 'model',
    toolCallId: 'serialized-delegation-second',
    input: { value: 'second' },
    extensionContext: emptyExtensionContext(),
  })
  await secondPrepared.promise
  await secondQueued.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(secondExecuted, false)
  releaseFirst.resolve()

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(secondExecuted, true)
  assert.equal(firstResult.content[0]?.type === 'text' ? firstResult.content[0].text : '', 'first')
  assert.equal(secondResult.content[0]?.type === 'text' ? secondResult.content[0].text : '', 'second')
})

test('serialized delegation cost deltas start at executor entry', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const firstExecuting = deferred<void>()
  const releaseFirst = deferred<void>()
  const budgetHarness = makeSerializedMeteredBudget()
  let totalCostUsd = 0
  const rawTool = defineTool({
    name: 'spawn_team',
    label: 'Spawn team',
    description: 'Runs serialized cost-bearing child work.',
    parameters: PARAMETERS,
    async execute(_toolCallId, params) {
      if (params.value === 'first') {
        firstExecuting.resolve()
        await releaseFirst.promise
      }
      const delegationId = `delegation-cost-${params.value}`
      recordLifecycle(assignmentPath, delegationId, 'queued')
      recordLifecycle(assignmentPath, delegationId, 'running')
      await runShortChild()
      totalCostUsd += params.value === 'first' ? 1 : 2
      recordLifecycle(assignmentPath, delegationId, 'completed')
      return toolResult(params.value)
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], {
      budget: budgetHarness.budget,
    }),
    getContext: () => makeContext(22),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDelegationToolAdapterFactory({
      toolName: 'spawn_team',
      assignmentPath,
      readTotalCostUsd: () => totalCostUsd,
    }),
  })

  const first = governed.invoke({
    channel: 'model',
    toolCallId: 'serialized-delegation-cost-first',
    input: { value: 'first' },
    extensionContext: emptyExtensionContext(),
  })
  await firstExecuting.promise
  const second = governed.invoke({
    channel: 'model',
    toolCallId: 'serialized-delegation-cost-second',
    input: { value: 'second' },
    extensionContext: emptyExtensionContext(),
  })
  await budgetHarness.secondPreflightEntered
  releaseFirst.resolve()

  await Promise.all([first, second])
  assert.deepEqual(budgetHarness.actualCosts, [1, 2])
})

test('governed spawn_team adopts one dispatcher-owned ledger reservation', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const childTeamPath = path.join(assignmentPath, 'child-team')
  const childOutputPath = path.join(childTeamPath, 'output', 'research.md')
  await mkdir(path.dirname(childOutputPath), { recursive: true })
  await writeChildTeamConfig(childTeamPath)

  const state = makeRuntimeState()
  state.totalCost = 1
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const budgetPort = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => state.totalCost,
    isMetered: (capabilityId) =>
      capabilityId === ENGINE_TOOL_CAPABILITY_IDS.spawn_team,
  })
  const events: CapabilityDispatchEvent[] = []
  const activeSpawnCountRef = { count: 0 }
  let childRuns = 0
  let reservedDuringChild = 0
  const entry: TeamRegistryEntry = {
    name: 'research-team',
    type: 'team',
    team_path: childTeamPath,
    input_artifact: 'incoming-brief.md',
    output_artifact: 'output/research.md',
  }
  const rawTool = createSpawnTeamTool({
    teamName: 'parent-team',
    teamConfig: makeTeamConfig(path.join(assignmentPath, 'workspace')),
    teamRegistry: new Map([[entry.name, entry]]),
    permissions: { spawn_teams: true },
    levelId: 'intake',
    outputPath: assignmentPath,
    state,
    budgetLedger: ledger,
    activeSpawnCountRef,
    adoptCapabilityBudget: (toolCallId) => budgetPort.adopt(toolCallId),
  }, {
    runTeamImpl: async (options) => {
      childRuns += 1
      reservedDuringChild = ledger.reservedUsd
      await runShortChild()
      await writeFile(
        childOutputPath,
        '---\nartifact_type: "report"\nstatus: "completed"\n---\n# Research\n\nDone.',
        'utf8',
      )
      const childSessionId = options.childSessionId
      if (!childSessionId) throw new Error('Expected child session identity.')
      const childAssignmentPath = path.join(
        assignmentPath,
        'workspace',
        'assignments',
        childSessionId,
      )
      await mkdir(childAssignmentPath, { recursive: true })
      return {
        text: '# Research\n\nDone.',
        cost: 2,
        durationMs: 10,
        artifactPath: childOutputPath,
        assignmentPath: childAssignmentPath,
        childSessionId,
        ...whenDefined(
          options.requestedResultType,
          (requestedResultType) => ({ requestedResultType }),
        ),
        status: 'completed',
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(events, { budget: budgetPort }),
    budgetAdoptionScope: budgetPort,
    getContext: () => makeContext(25),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDelegationToolAdapterFactory({
      toolName: 'spawn_team',
      assignmentPath,
      readTotalCostUsd: () => state.totalCost,
    }),
  })

  const result = await withTimeout(
    governed.invoke({
      channel: 'model',
      toolCallId: 'governed-spawn-team-call-1',
      input: {
        team: 'research-team',
        brief: 'Run the real child fixture.',
      },
      extensionContext: emptyExtensionContext(),
    }),
    1_000,
    'governed spawn_team deadlocked on a second ledger reservation',
  )

  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /research-team/)
  assert.equal(childRuns, 1)
  assert.equal(reservedDuringChild, 9)
  assert.equal(ledger.reservedUsd, 0)
  assert.equal(activeSpawnCountRef.count, 0)
  assert.equal(state.totalCost, 3)
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'capability.dispatch.requested',
      'capability.dispatch.started',
      'capability.dispatch.completed',
    ],
  )
})

test('governed spawn_workflow adopts one dispatcher-owned ledger reservation', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const primaryArtifact = path.join(assignmentPath, 'workflow-output.md')
  const state = makeRuntimeState()
  state.totalCost = 2
  const ledger = new BudgetLedger({ capUsd: 10, policy: 'halt' })
  const budgetPort = new TeamRuntimeCapabilityBudgetPort({
    ledger,
    readTotalCostUsd: () => state.totalCost,
    isMetered: (capabilityId) =>
      capabilityId === ENGINE_TOOL_CAPABILITY_IDS.spawn_workflow,
  })
  const activeSpawnCountRef = { count: 0 }
  let workflowRuns = 0
  let reservedDuringChild = 0
  const workflowEntry: WorkflowRegistryEntry = {
    name: 'research-workflow',
    template_path: path.join(assignmentPath, 'workflow.yaml'),
    description: 'Real-process workflow integration fixture.',
    tags: ['test'],
  }
  const rawTool = createSpawnWorkflowTool({
    teamName: 'parent-team',
    teamConfig: makeTeamConfig(path.join(assignmentPath, 'workspace')),
    teamRegistry: new Map(),
    workflowRegistry: new Map([[workflowEntry.name, workflowEntry]]),
    permissions: { spawn_teams: true },
    levelId: 'intake',
    outputPath: assignmentPath,
    state,
    budgetLedger: ledger,
    activeSpawnCountRef,
    adoptCapabilityBudget: (toolCallId) => budgetPort.adopt(toolCallId),
  }, {
    runWorkflowImpl: async () => {
      workflowRuns += 1
      reservedDuringChild = ledger.reservedUsd
      await runShortChild()
      await writeFile(primaryArtifact, '# Workflow result\n', 'utf8')
      return {
        workflowId: workflowEntry.name,
        status: 'completed',
        primaryArtifact,
        requestedResultType: 'artifact:workflow-output.md',
        totalCost: 1.5,
        summary: 'Workflow completed through a real child process.',
        steps: [],
      }
    },
  })
  const governed = governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher([], { budget: budgetPort }),
    budgetAdoptionScope: budgetPort,
    getContext: () => makeContext(26),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDelegationToolAdapterFactory({
      toolName: 'spawn_workflow',
      assignmentPath,
      readTotalCostUsd: () => state.totalCost,
    }),
  })

  await withTimeout(
    governed.invoke({
      channel: 'model',
      toolCallId: 'governed-spawn-workflow-call-1',
      input: {
        workflow: workflowEntry.name,
        brief: 'Run the real workflow child fixture.',
      },
      extensionContext: emptyExtensionContext(),
    }),
    1_000,
    'governed spawn_workflow deadlocked on a second ledger reservation',
  )

  assert.equal(workflowRuns, 1)
  assert.equal(reservedDuringChild, 8)
  assert.equal(ledger.reservedUsd, 0)
  assert.equal(activeSpawnCountRef.count, 0)
  assert.equal(state.totalCost, 3.5)
})

test('delegation rejects a successful raw return when no child started', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const governed = makeDelegationHarness({
    assignmentPath,
    toolName: 'spawn_team',
    execute: async () => toolResult('raw returned before child start'),
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'delegation-not-started-call-1',
      input: { value: 'alpha' },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) => hasDelegationOutcome(
      error,
      'child-not-started',
      'completion_fence_failed',
    ),
  )
})

test('delegation preserves a child failed terminal state after the child started', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const governed = makeDelegationHarness({
    assignmentPath,
    toolName: 'spawn_team',
    execute: async () => {
      recordLifecycle(assignmentPath, 'delegation-failed-1', 'queued')
      recordLifecycle(assignmentPath, 'delegation-failed-1', 'running')
      await runShortChild()
      recordLifecycle(assignmentPath, 'delegation-failed-1', 'failed')
      return toolResult('raw returned after child failure')
    },
  })

  await assert.rejects(
    governed.invoke({
      channel: 'model',
      toolCallId: 'delegation-failed-call-1',
      input: { value: 'alpha' },
      extensionContext: emptyExtensionContext(),
    }),
    (error: unknown) =>
      error instanceof TeamRuntimeToolDispatchError &&
      error.status === 'indeterminate' &&
      error.code === 'result_acceptance_failed' &&
      isDelegationOutcome(error.detail) &&
      error.detail.outcome === 'child-terminal' &&
      error.detail.terminalStatus === 'failed',
  )
})

test('delegation distinguishes caller cancellation before child start', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const entered = deferred<void>()
  const controller = new AbortController()
  const governed = makeDelegationHarness({
    assignmentPath,
    toolName: 'spawn_workflow',
    execute: async (signal) => {
      entered.resolve()
      await waitForAbort(signal)
      return toolResult('raw returned after cancellation')
    },
  })

  const invocation = governed.invoke({
    channel: 'model',
    toolCallId: 'delegation-cancelled-call-1',
    input: { value: 'alpha' },
    signal: controller.signal,
    extensionContext: emptyExtensionContext(),
  })
  await entered.promise
  controller.abort(new DOMException('Caller cancelled.', 'AbortError'))

  await assert.rejects(
    invocation,
    (error: unknown) => hasDelegationOutcome(
      error,
      'caller-cancelled',
      'completion_fence_failed',
    ),
  )
})

test('delegation reports uncertain state when cancellation leaves a real child nonterminal', async (t) => {
  const assignmentPath = await makeAssignment(t)
  const entered = deferred<void>()
  const controller = new AbortController()
  let child: ChildProcess | undefined
  const factory = createDelegationToolAdapterFactory({
    toolName: 'spawn_team',
    assignmentPath,
  })
  const adapter: CapabilityAdapter = {
    capabilityId: factory.capabilityId,
    prepare: async (input) => factory.createPreparedExecution({
      signal: input.signal,
      argumentNames: Object.keys(input.arguments).sort(),
      executeRaw: async (signal) => {
        recordLifecycle(assignmentPath, 'delegation-uncertain-1', 'queued')
        recordLifecycle(assignmentPath, 'delegation-uncertain-1', 'running')
        child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "process.stdout.write('ready\\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        const childStdout = child.stdout
        if (!childStdout) {
          throw new Error('Expected the delegation child stdout pipe.')
        }
        await once(childStdout, 'data')
        entered.resolve()
        await waitForAbort(signal)
        child.kill('SIGTERM')
        throw new DOMException('Caller cancelled.', 'AbortError')
      },
    }),
  }

  try {
    const invocation = createCapabilityTestDispatcher().dispatch({
      context: makeContext(31),
      invocation: {
        capabilityId: factory.capabilityId,
        source: MODEL_SOURCE,
        toolCallId: 'delegation-uncertain-call-1',
        input: { value: 'alpha' },
      },
      adapter,
      signal: controller.signal,
    })
    await entered.promise
    controller.abort(new DOMException('Caller cancelled.', 'AbortError'))

    const result = await invocation
    assert.equal(result.status, 'indeterminate')
    if (result.status === 'indeterminate') {
      assert.equal(result.code, 'capability_execution_indeterminate')
      assert.ok(isDelegationOutcome(result.detail))
      assert.equal(result.detail.outcome, 'child-state-uncertain')
    }
  } finally {
    await stopChild(child)
  }
})

function makeDelegationHarness(input: {
  readonly assignmentPath: string
  readonly toolName: (typeof DELEGATION_ENGINE_TOOL_NAMES)[number]
  execute(signal: AbortSignal): Promise<ReturnType<typeof toolResult>>
}) {
  const rawTool = defineTool({
    name: input.toolName,
    label: input.toolName,
    description: `Integration fixture for ${input.toolName}.`,
    parameters: PARAMETERS,
    async execute(_toolCallId, _params, signal) {
      return input.execute(signal ?? new AbortController().signal)
    },
  })
  return governTeamRuntimeTool({
    tool: rawTool,
    dispatcher: createCapabilityTestDispatcher(),
    getContext: () => makeContext(30),
    modelSource: MODEL_SOURCE,
    runtimeSource: RUNTIME_SOURCE,
    adapterFactory: createDelegationToolAdapterFactory({
      toolName: input.toolName,
      assignmentPath: input.assignmentPath,
    }),
  })
}

function makeContext(index: number): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: `request-engine-${index}`,
    sessionId: `session-engine-${index}`,
    runId: `run-engine-${index}`,
    assignmentId: `assignment-engine-${index}`,
    taskId: `task-engine-${index}`,
    agentPath: 'agents/coordinator',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: `process-engine-${index}`,
    },
  }
}

function makeRuntimeState(): RuntimeState {
  return {
    sessionId: 'engine-capability-session',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: 'engine-capability-root',
  }
}

function makePipelineBudgetContext(input: {
  readonly assignmentPath: string
  readonly sourcePlanPath: string
  readonly totalCostUsd: number
  readonly ledger: BudgetLedger
}): {
  readonly context: BaseEngineContext<PipelineStageConfig>
  readonly state: RuntimeState
} {
  const levelId = 'execution'
  const state = makeEngineBudgetState(levelId, input.totalCostUsd)
  const config: PipelineStageConfig = {
    type: STAGE_TYPE.PIPELINE,
    coordinator: 'coordinator',
    participants: ['writer'],
    config: {
      plan_file: input.sourcePlanPath,
      execution_mode: 'serial',
      parallel: false,
      gate: { type: 'all_tasks_terminal', strictness: 'hard' },
      output_contract: { artifacts: [] },
    },
  }
  return {
    state,
    context: {
      teamName: 'budget-pipeline-team',
      teamConfig: makeTeamConfig(input.assignmentPath),
      config,
      levelId,
      teamRootPath: input.assignmentPath,
      agents: new Map([['writer', makeLoadedAgent('writer', input.assignmentPath)]]),
      rosterEntries: new Map([['writer', { type: 'agent' as const }]]),
      state,
      workspacePath: input.assignmentPath,
      outputPath: input.assignmentPath,
      inputFilesContent: '',
      agentMetrics: new Map(),
      budgetLedger: input.ledger,
    },
  }
}

function makeChainBudgetContext(input: {
  readonly assignmentPath: string
  readonly totalCostUsd: number
  readonly ledger: BudgetLedger
}): {
  readonly context: BaseEngineContext<ChainStageConfig>
  readonly state: RuntimeState
} {
  const levelId = 'chain'
  const state = makeEngineBudgetState(levelId, input.totalCostUsd)
  const config: ChainStageConfig = {
    type: STAGE_TYPE.CHAIN,
    coordinator: 'coordinator',
    sequence: ['writer'],
    config: {
      output: { format: 'output/result.md', user_review: false },
    },
  }
  return {
    state,
    context: {
      teamName: 'budget-chain-team',
      teamConfig: makeTeamConfig(input.assignmentPath),
      config,
      levelId,
      teamRootPath: input.assignmentPath,
      agents: new Map([['writer', makeLoadedAgent('writer', input.assignmentPath)]]),
      rosterEntries: new Map([['writer', { type: 'agent' as const }]]),
      state,
      workspacePath: input.assignmentPath,
      outputPath: input.assignmentPath,
      inputFilesContent: '',
      agentMetrics: new Map(),
      budgetLedger: input.ledger,
    },
  }
}

function makeEngineBudgetState(
  levelId: string,
  totalCostUsd: number,
): RuntimeState {
  return {
    ...makeRuntimeState(),
    totalCost: totalCostUsd,
    levelStates: new Map([[
      levelId,
      {
        status: LEVEL_STATUS.ACTIVE,
        stageStatus: STAGE_LIFECYCLE_STATUS.READY,
        loopbackCount: 0,
        engineState: null,
      },
    ]]),
  }
}

function makeLoadedAgent(name: string, agentDir: string) {
  return {
    name,
    model: 'test-model',
    thinking: 'low' as const,
    systemPrompt: 'Complete the assigned work.',
    experienceContent: '',
    experienceEnabled: false,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir,
    color: 1,
    provider: 'test-provider',
  }
}

function makeTeamConfig(workspacePath: string): TeamConfig {
  return {
    team: {
      name: 'parent-team',
      description: 'Engine capability integration fixture.',
      version: '1.0.0',
    },
    workspace: { path: workspacePath, watch: false },
    agents: [],
    levels: [],
    gates: [],
    composition: {
      spawn_limits: {
        maxDepth: 3,
        maxConcurrent: 1,
        maxTotalBudgetUsd: 10,
      },
    },
  }
}

async function writeChildTeamConfig(childTeamPath: string): Promise<void> {
  await mkdir(childTeamPath, { recursive: true })
  await writeFile(path.join(childTeamPath, 'worker.md'), '# Worker\n', 'utf8')
  await writeFile(path.join(childTeamPath, 'team.yaml'), `
team:
  name: child-team
  description: Child fixture
  version: '1.0.0'
workspace:
  path: ./workspace
  watch: false
workflow:
  entry_level: build
  invocation_modes: [team]
  capabilities: [research]
  input_contract:
    artifacts:
      - path: incoming-brief.md
        required: true
  output_contract:
    artifacts:
      - path: output/research.md
        required: true
    completion_artifact: output/research.md
models:
  orchestration: { model: test, thinking: high }
  strategic: { model: test, thinking: medium }
  execution: { model: test, thinking: low }
agents:
  - name: worker
    type: agent
    role: worker
    tier: execution
    agent_file: ./worker.md
    produces:
      - path: output/research.md
levels:
  - id: build
    name: Build
    order: 0
    stage:
      type: chain
      sequence: [worker]
      config:
        output:
          format: output/research.md
          user_review: false
gates: []
`, 'utf8')
}

function toolResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  }
}

function recordLifecycle(
  assignmentPath: string,
  delegationId: string,
  status: DelegationStatusSnapshot['status'],
): void {
  recordDelegationLifecycle(assignmentPath, {
    jobId: delegationId,
    delegationId,
    fromTeam: 'parent-team',
    fromLevel: 'level-1',
    fromAgent: 'coordinator',
    toTeam: 'child-team',
    requestedResultType: 'artifact:final.md',
    childSessionId: `child-${delegationId}`,
    startedAt: '2026-08-14T12:00:00.000Z',
    lastEventAt: new Date().toISOString(),
    status,
  })
}

async function runShortChild(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', 'setTimeout(() => process.exit(0), 5)'],
    { stdio: 'ignore' },
  )
  const [code] = await once(child, 'exit')
  assert.equal(code, 0)
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGKILL')
  await once(child, 'exit')
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function makeSerializedMeteredBudget(): {
  readonly budget: CapabilityBudgetPort
  readonly secondPreflightEntered: Promise<void>
  readonly actualCosts: Array<number | undefined>
} {
  let preflightCount = 0
  let reservationCount = 0
  const firstReleased = deferred<void>()
  const secondPreflight = deferred<void>()
  const actualCosts: Array<number | undefined> = []
  const budget: CapabilityBudgetPort = {
    preflight: async () => {
      preflightCount += 1
      if (preflightCount === 2) secondPreflight.resolve()
      return { kind: 'metered', estimateUsd: 3 }
    },
    reserve: async () => {
      reservationCount += 1
      if (reservationCount === 2) {
        await firstReleased.promise
      }
      return { reservationId: `serialized-budget-${reservationCount}` }
    },
    settle: async ({ actualCostUsd }) => {
      actualCosts.push(actualCostUsd)
      return {
        costTracked: true,
        budgetOverrun: false,
        ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
      }
    },
    release: async ({ reservationId }) => {
      if (reservationId === 'serialized-budget-1') firstReleased.resolve()
    },
  }
  return {
    budget,
    secondPreflightEntered: secondPreflight.promise,
    actualCosts,
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

function hasDelegationOutcome(
  error: unknown,
  outcome: DelegationCapabilityOutcome['outcome'],
  code: string,
): boolean {
  return error instanceof TeamRuntimeToolDispatchError &&
    error.status === 'indeterminate' &&
    error.code === code &&
    isDelegationOutcome(error.detail) &&
    error.detail.outcome === outcome
}

function isDelegationOutcome(value: unknown): value is DelegationCapabilityOutcome {
  return value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'delegation-execution' &&
    'outcome' in value &&
    typeof value.outcome === 'string'
}

async function makeAssignment(t: test.TestContext): Promise<string> {
  const assignmentPath = await mkdtemp(path.join(os.tmpdir(), 'pipeline-delegation-capability-'))
  t.after(async () => {
    await rm(assignmentPath, { recursive: true, force: true })
  })
  return assignmentPath
}

function emptyExtensionContext(): ExtensionContext {
  return Object.create(null)
}
