/**
 * A step that fails by *returning* must earn its offer like one that throws.
 *
 * `runTeam` does not throw when a child team fails. It resolves with
 * `succeeded: false`, and `inferStatusFromChildResult` turns that into a
 * `failed` step. At the baseline for this work, commit `31607b44`, the
 * model-choice decision lived only inside the runner's `catch` around the step
 * dispatch, so the ordinary shape of a team-step failure — the returned one —
 * never reached it, and a user whose Agent could not run on its own pinned pair
 * was simply told the run failed. Both shapes now go through
 * `offerModelChoiceBeforeTerminal`.
 *
 * The decision also has to happen *before* the step's failure receipt is
 * written. On a later execution the runner reads the child's completion
 * receipt first, and a failed one is committed and returned terminal without
 * dispatching, so an offer made after that write is one the user could approve
 * and the runner could never run.
 *
 * Driven through the real runner, the real durable state store and the real
 * evaluator, against a real spawned child. The child performs a real dispatch
 * for an Agent pinned to a configured connection that does not exist, so the
 * adapter refuses before it sends anything and records that refusal itself.
 * Nothing about the failure is hand-written: substituting a throwing team
 * implementation, as the sibling suites do, is exactly the shape this defect
 * hides behind.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import type { WorkflowRunOutcome } from '../../workflows/types.js'
import type { TeamRegistryEntry } from '../../core/types.js'

initProviders()

/** The Agent's own pinned pair. Deliberately unregistered, so it cannot run. */
const PINNED = { provider: 'connection:missing-connection', model: 'pinned-model' }
/** Also unregistered: no test here may reach a network. */
const APP_DEFAULT = { provider: 'connection:missing-default', model: 'default-model' }

/** `.tests-dist`, so the spawned child can load the same compiled production code. */
const DIST_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

/** The step each completion receipt under the run belongs to. */
function receiptStepIds(root: string): string[] {
  return findCompletionReceipts(root)
    .map((receiptPath) => {
      const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
      return (parsed as { stepId?: string }).stepId ?? ''
    })
    .sort()
}

/** Every completion receipt anywhere under the run, however it is nested. */
function findCompletionReceipts(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.name === 'completion-receipt.json') found.push(target)
    }
  }
  walk(root)
  return found
}

/** The run's durable state, read back the way a reopened run would read it. */
function readDurableState(
  workspace: string,
  rootRunId: string,
): { status: string; steps: { stepId: string; status: string; modelChoice?: unknown }[] } {
  const statePath = path.join(
    workspace,
    'assignments',
    rootRunId,
    '.runtime',
    'workflow-state.json',
  )
  const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const record = parsed as { state?: unknown }
  return (record.state ?? parsed) as ReturnType<typeof readDurableState>
}

/**
 * A child that dispatches for real and then ends without its artifact.
 *
 * Stands in for the Pi runtime only as a launcher: the dispatch it performs is
 * the production one, so the run log it leaves behind is written by the code
 * that writes it in a real run. Ending without the output artifact is how a
 * real child reports failure to `runTeam` — by returning, never by throwing.
 */
function writeChildRuntime(
  root: string,
  selection: { provider: string; model: string; source: 'agent' | 'app-default' },
): string {
  const directory = path.join(root, 'fake-pi')
  fs.mkdirSync(directory, { recursive: true })
  const scriptPath = path.join(directory, 'pi')
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const dist = process.env.PIPELINE_RETURNED_FAILURE_DIST_ROOT
const load = (relative) =>
  import(pathToFileURL(path.join(dist, relative)).href)

async function main() {
  // A predecessor step succeeds for real: it writes its output artifact and
  // ends, which is what makes its completion something a later suspension can
  // be shown to preserve.
  const succeedStep = process.env.PIPELINE_RETURNED_FAILURE_SUCCEED_STEP
  if (succeedStep && process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID === succeedStep) {
    const output = path.join(
      process.cwd(),
      process.env.TEAM_OUTPUT_ARTIFACT || 'final-draft.md',
    )
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, '# Research findings.')
    return
  }
  const providers = await load('providers/index.js')
  const configured = await load('providers/configured-provider.js')
  const runner = await load('domains/agent-execution/agent-runner.js')
  providers.initProviders()
  // Nothing is registered, so the pinned connection cannot resolve and the
  // adapter refuses before building a request.
  configured.setConfiguredProviderConnections([])
  await runner
    .dispatchToAgentOrTeam({
      agent: {
        name: 'writer',
        model: ${JSON.stringify(selection.model)},
        thinking: 'low',
        tools: [],
        systemPrompt: 'Write the requested draft.',
        experienceContent: '',
        experienceEnabled: false,
        skillsContent: '',
        knowledgeContent: '',
        agentDir: '',
        color: 1,
        provider: ${JSON.stringify(selection.provider)},
        providerConfig: {},
        selection: {
          provider: ${JSON.stringify(selection.provider)},
          model: ${JSON.stringify(selection.model)},
          source: ${JSON.stringify(selection.source)},
          reason: ${JSON.stringify(
            selection.source === 'agent' ? 'explicit-agent-choice' : 'agent-default',
          )},
        },
      },
      rosterEntry: { type: 'agent' },
      finalPrompt: 'Write the requested draft.',
      userMessage: 'Draft a recommendation.',
      state: {
        sessionId: process.env.TEAM_SESSION_ID || 'child',
        currentLevelIndex: 0,
        levelStates: new Map(),
        totalCost: 0,
        startTime: 0,
        timerStarted: false,
        endTime: null,
        spawnDepth: Number(process.env.TEAM_SPAWN_DEPTH || '1'),
      },
      workspacePath: process.cwd(),
      outputPath: process.cwd(),
      metrics: undefined,
      logicalInvocationId:
        process.env.TEAM_RUNTIME_WORKFLOW_STEP_ID || 'write',
    })
    .catch(() => undefined)
  // No output artifact is written. The parent learns of the failure from the
  // resolved result, which is the path under test.
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(String((error && error.stack) || error) + '\\n')
    process.exit(1)
  },
)
`,
    { mode: 0o755 },
  )
  return directory
}

function writeFixture(
  workspace: string,
  options: {
    pinned?: boolean
    stepType?: 'team' | 'agent'
    recoveryPolicy?: 'safe_retry' | 'idempotent' | 'manual' | 'never_retry'
    predecessor?: boolean
  } = {},
): {
  templatePath: string
  teamPath: string
} {
  const teamPath = path.join(workspace, 'teams', 'lonely-writer')
  const agentDir = path.join(workspace, 'agents', 'writer')
  fs.mkdirSync(teamPath, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'writer.md'),
    [
      '---',
      // An inheriting Agent names no pair at all, so the application default
      // is what runs and there is no Agent choice to displace.
      ...(options.pinned === false
        ? []
        : [`provider: ${PINNED.provider}`, `model: ${PINNED.model}`]),
      'thinking: low',
      '---',
      '',
      'Write the requested draft.',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    [
      'team:',
      '  name: lonely-writer',
      '  description: One writer',
      '  version: 0.1.0',
      'workspace:',
      '  path: ./workspace',
      '  watch: false',
      'workflow:',
      '  entry_level: execute',
      '  invocation_modes:',
      '    - user',
      '    - team',
      '  output_contract:',
      '    completion_artifact: final-draft.md',
      'agents:',
      '  - name: writer',
      '    type: agent',
      '    role: Writer',
      '    tier: strategic',
      '    agent_file: ../../agents/writer/writer.md',
      '    produces:',
      '      - path: final-draft.md',
      'levels:',
      '  - id: execute',
      '    name: Execute',
      '    order: 0',
      '    agents:',
      '      - writer',
      '    stage:',
      '      type: pipeline',
      '      config:',
      '        output:',
      '          format: final-draft.md',
      '          user_review: false',
      '',
    ].join('\n'),
  )
  const templatePath = path.join(workspace, 'team-step.yaml')
  fs.writeFileSync(
    templatePath,
    [
      'workflow:',
      '  id: team-step-workflow',
      '  steps:',
      ...(options.predecessor
        ? [
            '    - id: research',
            '      type: team',
            '      team: lonely-writer',
            '      input_artifact: incoming-brief.md',
            '      result_artifact: final-draft.md',
          ]
        : []),
      '    - id: write',
      `      type: ${options.stepType ?? 'team'}`,
      '      team: lonely-writer',
      ...(options.stepType === 'agent'
        ? ['      agent: writer', '      stage_type: pipeline']
        : []),
      ...(options.recoveryPolicy
        ? [`      recovery_policy: ${options.recoveryPolicy}`]
        : []),
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      ...(options.predecessor
        ? [
            '      handoff:',
            '        from_step: research',
            '        from_artifact: final-draft.md',
            '        to_artifact: incoming-brief.md',
          ]
        : []),
      '  output:',
      '    from_step: write',
      '    artifact: final-draft.md',
      '',
    ].join('\n'),
  )
  return { templatePath, teamPath }
}

test('a team step that fails by returning still earns its model-choice offer', async () => {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-returned-failure-')),
  )
  fs.mkdirSync(path.join(workspace, 'assignments', 'root-returned-failure'), {
    recursive: true,
  })
  const { templatePath, teamPath } = writeFixture(workspace)
  const fakePiDirectory = writeChildRuntime(workspace, {
    ...PINNED,
    source: 'agent',
  })
  const entry: TeamRegistryEntry = {
    name: 'lonely-writer',
    type: 'team',
    team_path: teamPath,
    output_artifact: 'final-draft.md',
  }

  const environmentNames = [
    'PATH',
    'TEAM_RUNTIME_PI_CLI_PATH',
    'PIPELINE_RETURNED_FAILURE_DIST_ROOT',
  ] as const
  const originalEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  )
  process.env.PATH = `${fakePiDirectory}${path.delimiter}${process.env.PATH ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.PIPELINE_RETURNED_FAILURE_DIST_ROOT = DIST_ROOT

  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  try {
    const outcome = await runWorkflowOutcome({
      workflowEntry: {
        name: 'team-step-workflow',
        template_path: templatePath,
      },
      teamRegistry: new Map([['lonely-writer', entry]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-returned-failure',
      parentSessionId: 'root-returned-failure',
      taskId: 'task-returned-failure',
      productSessionId: 'session-returned-failure',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    })

    // The user is asked, rather than told the run failed.
    assert.equal(outcome.kind, 'awaiting_model_choice')
    if (outcome.kind !== 'awaiting_model_choice') return
    assert.equal(outcome.stepId, 'write')
    assert.equal(outcome.offer.agentName, 'writer')
    assert.deepEqual(outcome.offer.failedChoice, PINNED)
    assert.deepEqual(outcome.offer.proposedDefault, APP_DEFAULT)
    // The offer has to be one an approval could actually run. A resumed step
    // whose child assignment holds a failed receipt commits it and returns
    // terminal without dispatching, so a receipt written before the decision
    // would leave the user approving something nothing can execute.
    assert.deepEqual(
      findCompletionReceipts(workspace),
      [],
      'a suspended step must not have committed a completion receipt',
    )
  } finally {
    setRuntimeDefaultModelState(undefined)
    for (const name of environmentNames) {
      const original = originalEnvironment.get(name)
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a returned failure with nothing to displace still ends the run', async () => {
  // The other half of the same decision. Reaching the evaluator from the
  // returned path must not turn every failed child into a question: an Agent
  // that named no pair ran on the application default, so there is no Agent
  // choice a retry could replace, and the run ends as it always did.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-returned-inherit-')),
  )
  fs.mkdirSync(path.join(workspace, 'assignments', 'root-returned-inherit'), {
    recursive: true,
  })
  const { templatePath, teamPath } = writeFixture(workspace, { pinned: false })
  const fakePiDirectory = writeChildRuntime(workspace, {
    ...APP_DEFAULT,
    source: 'app-default',
  })
  const entry: TeamRegistryEntry = {
    name: 'lonely-writer',
    type: 'team',
    team_path: teamPath,
    output_artifact: 'final-draft.md',
  }

  const environmentNames = [
    'PATH',
    'TEAM_RUNTIME_PI_CLI_PATH',
    'PIPELINE_RETURNED_FAILURE_DIST_ROOT',
  ] as const
  const originalEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  )
  process.env.PATH = `${fakePiDirectory}${path.delimiter}${process.env.PATH ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.PIPELINE_RETURNED_FAILURE_DIST_ROOT = DIST_ROOT

  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  try {
    const outcome = await runWorkflowOutcome({
      workflowEntry: {
        name: 'team-step-workflow',
        template_path: templatePath,
      },
      teamRegistry: new Map([['lonely-writer', entry]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-returned-inherit',
      parentSessionId: 'root-returned-inherit',
      taskId: 'task-returned-inherit',
      productSessionId: 'session-returned-inherit',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    })

    assert.equal(outcome.kind, 'terminal')
    if (outcome.kind !== 'terminal') return
    assert.equal(outcome.result.status, 'failed')
    // The ordinary terminal handling still runs: the step's failure is
    // committed, not left waiting for a decision nobody was asked for.
    assert.equal(findCompletionReceipts(workspace).length, 1)
  } finally {
    setRuntimeDefaultModelState(undefined)
    for (const name of environmentNames) {
      const original = originalEnvironment.get(name)
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

/**
 * A `never_retry` step cannot be offered a retry it would never be allowed to
 * take.
 *
 * Approval resumes the run, and a resumed step with no completion receipt and
 * `recovery_policy: never_retry` is forced to `blocked` before any dispatch is
 * attempted. Suspending such a step therefore asks the user a question whose
 * only answer is refused: the offer is presented, approved, and then silently
 * declined by the policy that was always going to decline it.
 * Both shapes of failure have to suppress it, so both are driven here — the
 * returned one through a real child team, the thrown one through an agent-only
 * step, which calls the provider in-process and raises.
 */
for (const shape of [
  // A child team reports failure by resolving, so the run ends with a terminal
  // result. An agent-only step raises, and the repository's existing policy is
  // that an unearned failure propagates — the run still ends, and its durable
  // state still records the terminal status. Neither may leave an offer behind.
  { name: 'a child team that fails by returning', stepType: 'team' as const, throws: false },
  { name: 'an agent-only step that fails by throwing', stepType: 'agent' as const, throws: true },
]) {
  test(`${shape.name} earns no model-choice offer when the step is never_retry`, async () => {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-never-retry-choice-')),
    )
    const rootRunId = `root-never-retry-${shape.stepType}`
    fs.mkdirSync(path.join(workspace, 'assignments', rootRunId), {
      recursive: true,
    })
    const { templatePath, teamPath } = writeFixture(workspace, {
      stepType: shape.stepType,
      recoveryPolicy: 'never_retry',
    })
    const fakePiDirectory = writeChildRuntime(workspace, {
      ...PINNED,
      source: 'agent',
    })
    const entry: TeamRegistryEntry = {
      name: 'lonely-writer',
      type: 'team',
      team_path: teamPath,
      output_artifact: 'final-draft.md',
    }

    const environmentNames = [
      'PATH',
      'TEAM_RUNTIME_PI_CLI_PATH',
      'PIPELINE_RETURNED_FAILURE_DIST_ROOT',
    ] as const
    const originalEnvironment = new Map(
      environmentNames.map((name) => [name, process.env[name]]),
    )
    process.env.PATH = `${fakePiDirectory}${path.delimiter}${process.env.PATH ?? ''}`
    delete process.env.TEAM_RUNTIME_PI_CLI_PATH
    process.env.PIPELINE_RETURNED_FAILURE_DIST_ROOT = DIST_ROOT

    setConfiguredProviderConnections([])
    setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
    try {
      const run = (): Promise<WorkflowRunOutcome> =>
        runWorkflowOutcome({
          workflowEntry: {
            name: 'team-step-workflow',
            template_path: templatePath,
          },
          teamRegistry: new Map([['lonely-writer', entry]]),
          brief: 'Draft a recommendation.',
          workspacePath: workspace,
          spawnDepth: 0,
          rootSessionId: rootRunId,
          parentSessionId: rootRunId,
          taskId: `task-never-retry-${shape.stepType}`,
          productSessionId: `session-never-retry-${shape.stepType}`,
          persistenceMode: 'required' as const,
          executionAttemptId: 'attempt-one',
          modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
        })

      // The run ends the way it ended before this decision existed. Asserted
      // as the exact outcome rather than as "not waiting": a step coming to
      // rest in some other state would satisfy a negative assertion while
      // still having lost the contract this case exists to keep.
      if (shape.throws) {
        await assert.rejects(run(), /connection:missing-connection/)
      } else {
        const outcome = await run()
        assert.equal(outcome.kind, 'terminal')
        if (outcome.kind !== 'terminal') return
        assert.equal(outcome.result.status, 'failed')
      }

      // And nothing is left pending for a user to answer. A reopened run must
      // not show an offer whose approval the recovery policy would refuse.
      const state = readDurableState(workspace, rootRunId)
      assert.equal(state.status, 'failed')
      const step = state.steps.find((candidate) => candidate.stepId === 'write')
      assert.ok(step)
      assert.equal(step.status, 'failed')
      assert.equal(
        step.modelChoice,
        undefined,
        'a never_retry step must not carry a pending offer',
      )
    } finally {
      setRuntimeDefaultModelState(undefined)
      for (const name of environmentNames) {
        const original = originalEnvironment.get(name)
        if (original === undefined) delete process.env[name]
        else process.env[name] = original
      }
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
}

test('a completed predecessor stays completed while the next step waits', async () => {
  // The point of suspending before terminal is that committed work survives.
  // The first step really runs and really produces its artifact; the second
  // fails eligibly. What the user comes back to must show the first step done
  // and only the second waiting, or an approved retry would recompute work
  // that was already paid for.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-returned-predecessor-')),
  )
  const rootRunId = 'root-returned-predecessor'
  fs.mkdirSync(path.join(workspace, 'assignments', rootRunId), { recursive: true })
  const { templatePath, teamPath } = writeFixture(workspace, { predecessor: true })
  const fakePiDirectory = writeChildRuntime(workspace, {
    ...PINNED,
    source: 'agent',
  })
  const entry: TeamRegistryEntry = {
    name: 'lonely-writer',
    type: 'team',
    team_path: teamPath,
    output_artifact: 'final-draft.md',
  }

  const environmentNames = [
    'PATH',
    'TEAM_RUNTIME_PI_CLI_PATH',
    'PIPELINE_RETURNED_FAILURE_DIST_ROOT',
    'PIPELINE_RETURNED_FAILURE_SUCCEED_STEP',
  ] as const
  const originalEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  )
  process.env.PATH = `${fakePiDirectory}${path.delimiter}${process.env.PATH ?? ''}`
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.PIPELINE_RETURNED_FAILURE_DIST_ROOT = DIST_ROOT
  process.env.PIPELINE_RETURNED_FAILURE_SUCCEED_STEP = 'research'

  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  try {
    const outcome = await runWorkflowOutcome({
      workflowEntry: {
        name: 'team-step-workflow',
        template_path: templatePath,
      },
      teamRegistry: new Map([['lonely-writer', entry]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: rootRunId,
      parentSessionId: rootRunId,
      taskId: 'task-returned-predecessor',
      productSessionId: 'session-returned-predecessor',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    })

    assert.equal(outcome.kind, 'awaiting_model_choice')
    if (outcome.kind !== 'awaiting_model_choice') return
    assert.equal(outcome.stepId, 'write')

    const state = readDurableState(workspace, rootRunId)
    assert.equal(state.status, 'awaiting_model_choice')
    const research = state.steps.find((step) => step.stepId === 'research')
    const write = state.steps.find((step) => step.stepId === 'write')
    assert.ok(research)
    assert.ok(write)
    assert.equal(research.status, 'completed')
    assert.equal(write.status, 'awaiting_model_choice')

    // The predecessor's receipt is the only one on disk. The suspended step
    // must not have committed one, or its approval could never be run.
    assert.deepEqual(receiptStepIds(workspace), ['research'])
  } finally {
    setRuntimeDefaultModelState(undefined)
    for (const name of environmentNames) {
      const original = originalEnvironment.get(name)
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
