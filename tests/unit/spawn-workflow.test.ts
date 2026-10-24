import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createSpawnWorkflowTool } from '../../engines/spawn-workflows.js'
import type { RuntimeState, TeamConfig, TeamRegistryEntry } from '../../core/types.js'
import type { WorkflowRegistryEntry } from '../../workflows/types.js'
import { summarizeWorkflowResult } from '../../workflows/results.js'
import { BudgetLedger } from '../../core/budget-ledger.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import { buildSessionRunAssignmentLocation, type RunAssignmentLocation } from '../../domains/run/run-location.js'

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-workflow-test-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function createState(): RuntimeState {
  return {
    sessionId: 'test-session',
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
    rootSessionId: 'root-session',
    
  }
}

function createTeamConfig(): TeamConfig {
  return {
    team: { name: 'reception-desk', description: 'test', version: '0.1.0' },
    workspace: { path: '/tmp/workspace', watch: false },
    agents: [],
    levels: [],
    gates: [],
    composition: {
      spawn_limits: {
        maxDepth: 3,
        maxConcurrent: 1,
        maxTotalBudgetUsd: 50,
      },
    },
  }
}

test('spawn_workflow writes workflow request and routing decision for sequential workflow execution', async () => {
  await withTempDir(async (dir) => {
    const workflowDir = path.join(dir, 'workflows')
    fs.mkdirSync(workflowDir, { recursive: true })
    const templatePath = path.join(workflowDir, 'discussion-to-writing.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: discussion-to-writing
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
      handoff:
        from_step: discuss
        from_artifact: output/decomposition-plan.md
        to_artifact: incoming-brief.md
  output:
    from_step: write
    artifact: final-draft.md
`)

    const workflowEntry: WorkflowRegistryEntry = {
      name: 'discussion-to-writing',
      template_path: templatePath,
      description: 'Test workflow',
      tags: ['discussion', 'writing'],
    }
    const teamRegistry = new Map<string, TeamRegistryEntry>([
      ['problem-thinking-board', { name: 'problem-thinking-board', type: 'team', team_path: path.join(dir, 'problem-thinking-board') }],
      ['writing-team', { name: 'writing-team', type: 'team', team_path: path.join(dir, 'writing-team') }],
    ])
    const assignmentLocation = buildSessionRunAssignmentLocation('/tmp/workspace', {
      sessionId: 'product-session',
      runId: 'root-session',
      assignmentId: 'test-session',
    })
    assert.ok(assignmentLocation)
    let capturedAssignmentLocation: RunAssignmentLocation | undefined

    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry,
      workflowRegistry: new Map([[workflowEntry.name, workflowEntry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      stageType: 'routing',
      outputPath: dir,
      state: createState(),
      assignmentLocation,
      activeSpawnCountRef: { count: 0 },
      getCurrentCoordinatorRunId: () => 1,
    }, {
      runWorkflowImpl: async (options) => {
        capturedAssignmentLocation = options.assignmentLocation
        return {
        workflowId: 'discussion-to-writing',
        status: 'completed',
        primaryArtifact: path.join(dir, 'final-draft.md'),
        requestedResultType: 'artifact:final-draft.md',
        totalCost: 1.7,
        summary: 'Workflow completed successfully.',
        steps: [
          {
            stepId: 'discuss',
            team: 'problem-thinking-board',
            status: 'completed',
            artifactPath: path.join(dir, 'output', 'decomposition-plan.md'),
            requestedResultType: 'artifact:output/decomposition-plan.md',
            assignmentPath: path.join(dir, 'workspace', 'assignments', 'discussion'),
            childSessionId: 'discussion',
            summary: 'Discussion complete.',
            cost: 0.7,
          },
          {
            stepId: 'write',
            team: 'writing-team',
            status: 'completed',
            artifactPath: path.join(dir, 'final-draft.md'),
            requestedResultType: 'artifact:final-draft.md',
            assignmentPath: path.join(dir, 'workspace', 'assignments', 'writing'),
            childSessionId: 'writing',
            summary: 'Draft ready.',
            cost: 1,
          },
        ],
        }
      },
    })

    const result = await tool.execute(
      'call-1',
      { workflow: 'discussion-to-writing', brief: 'Think this through, then write it.', rationale: 'Needs analysis then writing.' },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    const text = (result.content?.[0] as { text?: string })?.text ?? ''
    assert.match(text, /Workflow completed: discussion-to-writing/)
    assert.match(text, /Status: completed/)
    assert.ok(fs.existsSync(path.join(dir, 'workflow-discussion-to-writing-request.md')))
    assert.ok(fs.existsSync(path.join(dir, 'workflow-discussion-to-writing-result.md')))
    assert.ok(fs.existsSync(path.join(dir, 'routing-decision.md')))
    assert.match(fs.readFileSync(path.join(dir, 'routing-decision.md'), 'utf8'), /Workflow: discussion-to-writing/)
    assert.match(fs.readFileSync(path.join(dir, 'routing-decision.md'), 'utf8'), /Workflow status: completed/)
    assert.match(fs.readFileSync(path.join(dir, 'workflow-discussion-to-writing-result.md'), 'utf8'), /### discuss/)
    assert.match(fs.readFileSync(path.join(dir, 'workflow-discussion-to-writing-result.md'), 'utf8'), /### write/)
    assert.deepEqual(capturedAssignmentLocation, assignmentLocation)
  })
})

test('spawn_workflow rejects a missing workflow id instead of invoking a matcher fallback', async () => {
  await withTempDir(async (dir) => {
    const entry: WorkflowRegistryEntry = {
      name: 'discussion-to-writing',
      template_path: path.join(dir, 'unused.yaml'),
      tags: ['discussion', 'writing'],
    }
    let workflowCalls = 0
    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map(),
      workflowRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runWorkflowImpl: async () => {
        workflowCalls += 1
        throw new Error('must not run')
      },
    })

    assert.ok((tool.parameters as { required?: string[] }).required?.includes('workflow'))
    await assert.rejects(
      tool.execute(
        'missing-workflow-id',
        { brief: 'Discuss this, then write a report.' },
        undefined as any,
        undefined as any,
        undefined as any,
      ),
      /requires an exact workflow id/i,
    )
    assert.equal(workflowCalls, 0)
    assert.equal(fs.readdirSync(dir).length, 0)
  })
})

test('spawn_workflow executes the exact workflow id even when the brief resembles another workflow', async () => {
  await withTempDir(async (dir) => {
    const requested: WorkflowRegistryEntry = {
      name: 'executive-summary',
      template_path: path.join(dir, 'summary.yaml'),
      tags: ['summary'],
    }
    const lexicalMatch: WorkflowRegistryEntry = {
      name: 'venture-diligence',
      template_path: path.join(dir, 'diligence.yaml'),
      tags: ['venture', 'diligence'],
    }
    const executed: string[] = []
    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map(),
      workflowRegistry: new Map([
        [requested.name, requested],
        [lexicalMatch.name, lexicalMatch],
      ]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runWorkflowImpl: async ({ workflowEntry }) => {
        executed.push(workflowEntry.name)
        return {
          workflowId: workflowEntry.name,
          status: 'completed',
          totalCost: 0,
          summary: 'Done.',
          steps: [],
        }
      },
    })

    await tool.execute(
      'exact-workflow-id',
      {
        workflow: requested.name,
        brief: 'Screen this venture investment and perform diligence.',
      },
      undefined as any,
      undefined as any,
      undefined as any,
    )

    assert.deepEqual(executed, [requested.name])
  })
})

test('summarizeWorkflowResult surfaces terminal failure reason instead of only the team name', () => {
  const text = summarizeWorkflowResult({
    workflowId: 'discussion-to-writing',
    status: 'failed',
    
    requestedResultType: 'artifact:output/decomposition-plan.md',
    totalCost: 0.5,
    summary: '',
    steps: [
      {
        stepId: 'discuss',
        team: 'problem-thinking-board',
        status: 'failed',
        
        requestedResultType: 'artifact:output/decomposition-plan.md',
        assignmentPath: '/tmp/workspace/assignments/discussion',
        childSessionId: 'discussion',
        summary: "The workflow failed: the discussion-to-writing workflow stopped at the discussion step, and the terminal step returned problem-thinking-board.",
        cost: 0.5,
      },
    ],
  })

  assert.match(text, /Workflow 'discussion-to-writing' finished with status failed/)
  assert.match(text, /Terminal step 'discuss' \(problem-thinking-board\) status: failed\./)
  assert.match(text, /Reason: The workflow failed: the discussion-to-writing workflow stopped at the discussion step/)
})

test('spawn_workflow rejects an exhausted hard budget before workflow execution', async () => {
  await withTempDir(async (dir) => {
    const state = createState()
    state.totalCost = 1
    let workflowCalls = 0
    const entry: WorkflowRegistryEntry = {
      name: 'budgeted-workflow',
      template_path: path.join(dir, 'unused.yaml'),
    }
    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map(),
      workflowRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state,
      budgetLedger: new BudgetLedger({ capUsd: 1, policy: 'halt' }),
      activeSpawnCountRef: { count: 0 },
    }, {
      runWorkflowImpl: async () => {
        workflowCalls += 1
        throw new Error('must not run')
      },
    })

    await assert.rejects(
      tool.execute('budget-call', {
        workflow: entry.name,
        brief: 'Run the budgeted workflow.',
      }, undefined as any, undefined as any, undefined as any),
      /budget exceeded/i,
    )
    assert.equal(workflowCalls, 0)
    assert.equal(fs.readdirSync(dir).length, 0)
  })
})

test('concurrent spawn_workflow calls do not share one stale hard-budget balance', async () => {
  await withTempDir(async (dir) => {
    const state = createState()
    const teamConfig = createTeamConfig()
    teamConfig.composition!.spawn_limits!.maxConcurrent = 2
    const ledger = new BudgetLedger({ capUsd: 1, policy: 'halt' })
    const entry: WorkflowRegistryEntry = {
      name: 'serialized-workflow',
      template_path: path.join(dir, 'unused.yaml'),
    }
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let workflowCalls = 0
    const seenBudgets: Array<number | undefined> = []
    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig,
      teamRegistry: new Map(),
      workflowRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state,
      budgetLedger: ledger,
      activeSpawnCountRef: { count: 0 },
    }, {
      runWorkflowImpl: async (options) => {
        workflowCalls += 1
        seenBudgets.push(options.budgetUsd)
        markFirstStarted()
        await firstMayFinish
        return {
          workflowId: entry.name,
          status: 'completed',
          totalCost: 1,
          summary: 'Done.',
          steps: [],
        }
      },
    })

    const first = tool.execute('first-budget-call', {
      workflow: entry.name,
      brief: 'First workflow.',
    }, undefined as any, undefined as any, undefined as any)
    await firstStarted
    const second = tool.execute('second-budget-call', {
      workflow: entry.name,
      brief: 'Second workflow.',
    }, undefined as any, undefined as any, undefined as any)
    const secondRejected = assert.rejects(second, /budget exceeded/i)
    releaseFirst()

    await first
    await secondRejected
    assert.equal(workflowCalls, 1)
    assert.deepEqual(seenBudgets, [1])
    assert.equal(ledger.reservedUsd, 0)
  })
})

test('spawn_workflow warn policy reports the cap but still dispatches', async () => {
  await withTempDir(async (dir) => {
    const state = createState()
    state.totalCost = 1
    const entry: WorkflowRegistryEntry = {
      name: 'warn-workflow',
      template_path: path.join(dir, 'unused.yaml'),
    }
    let workflowCalls = 0
    let receivedBudget: number | undefined
    const originalConsoleError = console.error
    const warnings: string[] = []
    console.error = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
    try {
      const tool = createSpawnWorkflowTool({
        teamName: 'reception-desk',
        teamConfig: createTeamConfig(),
        teamRegistry: new Map(),
        workflowRegistry: new Map([[entry.name, entry]]),
        permissions: { spawn_teams: true },
        levelId: 'intake',
        outputPath: dir,
        state,
        budgetLedger: new BudgetLedger({ capUsd: 1, policy: 'warn' }),
        activeSpawnCountRef: { count: 0 },
      }, {
        runWorkflowImpl: async (options) => {
          workflowCalls += 1
          receivedBudget = options.budgetUsd
          return {
            workflowId: entry.name,
            status: 'completed',
            totalCost: 0.1,
            summary: 'Done with warning policy.',
            steps: [],
          }
        },
      })

      await tool.execute('warn-call', {
        workflow: entry.name,
        brief: 'Continue despite the warning cap.',
      }, undefined as any, undefined as any, undefined as any)
    } finally {
      console.error = originalConsoleError
    }

    assert.equal(workflowCalls, 1)
    assert.equal(receivedBudget, 0)
    assert.ok(warnings.some((warning) => /Continuing \(policy: warn\)/.test(warning)))
  })
})

test('spawn_workflow enforces depth and concurrency limits before workflow execution', async () => {
  await withTempDir(async (dir) => {
    const entry: WorkflowRegistryEntry = {
      name: 'limited-workflow',
      template_path: path.join(dir, 'unused.yaml'),
    }
    const makeTool = (state: RuntimeState, activeSpawnCount: number) =>
      createSpawnWorkflowTool({
        teamName: 'reception-desk',
        teamConfig: createTeamConfig(),
        teamRegistry: new Map(),
        workflowRegistry: new Map([[entry.name, entry]]),
        permissions: { spawn_teams: true },
        levelId: 'intake',
        outputPath: dir,
        state,
        activeSpawnCountRef: { count: activeSpawnCount },
      }, {
        runWorkflowImpl: async () => {
          throw new Error('must not run')
        },
      })

    const deepState = createState()
    deepState.spawnDepth = 3
    await assert.rejects(
      makeTool(deepState, 0).execute('depth-call', {
        workflow: entry.name,
        brief: 'Run too deeply.',
      }, undefined as any, undefined as any, undefined as any),
      /max spawn depth/i,
    )

    await assert.rejects(
      makeTool(createState(), 1).execute('concurrency-call', {
        workflow: entry.name,
        brief: 'Run concurrently.',
      }, undefined as any, undefined as any, undefined as any),
      /max concurrent/i,
    )
  })
})

test('spawn_workflow atomically reserves maxConcurrent before awaiting execution', async () => {
  await withTempDir(async (dir) => {
    const entry: WorkflowRegistryEntry = {
      name: 'single-slot-workflow',
      template_path: path.join(dir, 'unused.yaml'),
    }
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let calls = 0
    const activeSpawnCountRef = { count: 0 }
    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map(),
      workflowRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef,
    }, {
      runWorkflowImpl: async () => {
        calls += 1
        markStarted()
        await firstMayFinish
        return {
          workflowId: entry.name,
          status: 'completed',
          totalCost: 0,
          summary: 'Done.',
          steps: [],
        }
      },
    })

    const first = tool.execute('first-slot', {
      workflow: entry.name,
      brief: 'First.',
    }, undefined as any, undefined as any, undefined as any)
    await started
    const secondRejected = assert.rejects(
      tool.execute('second-slot', {
        workflow: entry.name,
        brief: 'Second.',
      }, undefined as any, undefined as any, undefined as any),
      /max concurrent/i,
    )
    assert.equal(activeSpawnCountRef.count, 1)
    releaseFirst()
    await first
    await secondRejected
    assert.equal(calls, 1)
    assert.equal(activeSpawnCountRef.count, 0)
  })
})

test('spawn_workflow preserves a blocked terminal lifecycle state', async () => {
  await withTempDir(async (dir) => {
    const entry: WorkflowRegistryEntry = {
      name: 'blocked-workflow',
      template_path: path.join(dir, 'unused.yaml'),
    }
    const tool = createSpawnWorkflowTool({
      teamName: 'reception-desk',
      teamConfig: createTeamConfig(),
      teamRegistry: new Map(),
      workflowRegistry: new Map([[entry.name, entry]]),
      permissions: { spawn_teams: true },
      levelId: 'intake',
      outputPath: dir,
      state: createState(),
      activeSpawnCountRef: { count: 0 },
    }, {
      runWorkflowImpl: async () => ({
        workflowId: entry.name,
        status: 'blocked',
        totalCost: 0,
        summary: 'Approval required.',
        steps: [],
      }),
    })

    await assert.rejects(
      tool.execute('blocked-call', {
        workflow: entry.name,
        brief: 'Run until approval is needed.',
      }, undefined as any, undefined as any, undefined as any),
      /Approval required/,
    )
    const lifecycleState = JSON.parse(
      fs.readFileSync(getAssignmentLogPath(dir, 'delegation-state.json'), 'utf8'),
    ) as Record<string, { status?: string }>
    assert.equal(Object.values(lifecycleState)[0]?.status, 'blocked')
  })
})
