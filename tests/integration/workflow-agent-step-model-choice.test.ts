/**
 * An agent-only workflow step has to earn an offer like any other dispatch.
 *
 * A step of `type: agent` calls the provider directly instead of starting a
 * child team runtime. If that path records nothing under the dispatch identity
 * the evaluator joins on, an eligible failure — the adapter refusing before it
 * sent anything — cannot become a choice for the user, and the run simply ends.
 * Approval machinery downstream is irrelevant if no offer is ever produced.
 *
 * Driven through the real runner and the real evaluator against a configured
 * connection that does not exist, so the refusal is a genuine one.
 */
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { createWorkflowModelChoiceEvaluator } from '../../services/workflow-model-choice-evaluator.js'
import { runWorkflowOutcome } from '../../workflows/runner.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'
import { randomUUID } from 'node:crypto'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import type { TeamRegistryEntry } from '../../core/types.js'

initProviders()

const PINNED = { provider: 'connection:missing-connection', model: 'pinned-model' }
// Both pairs name configured connections that are deliberately not registered,
// so nothing here can reach a network whatever credentials the environment
// happens to hold. This suite is about dispatch identity and provenance, not
// about a provider answering.
const APP_DEFAULT = { provider: 'connection:missing-default', model: 'default-model' }

function readRunLog(workspace: string): Record<string, unknown>[] {
  const assignments = path.join(workspace, 'assignments')
  const records: Record<string, unknown>[] = []
  for (const entry of fs.readdirSync(assignments)) {
    const logPath = path.join(assignments, entry, 'logs', 'agent-runs.jsonl')
    if (!fs.existsSync(logPath)) continue
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return records
}

function writeFixture(
  workspace: string,
  options: { pinned?: boolean; providerOptions?: string } = {},
): { templatePath: string; teamPath: string } {
  const teamPath = path.join(workspace, 'teams', 'lonely-writer')
  const agentDir = path.join(workspace, 'agents', 'writer')
  fs.mkdirSync(teamPath, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'writer.md'),
    [
      '---',
      // An inheriting agent names no pair at all, so the loader resolves the
      // application default for it and says so.
      ...(options.pinned === false
        ? []
        : [`provider: ${PINNED.provider}`, `model: ${PINNED.model}`]),
      ...(options.providerOptions
        ? [`provider_options: '${options.providerOptions}'`]
        : []),
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
  const templatePath = path.join(workspace, 'agent-step.yaml')
  fs.writeFileSync(
    templatePath,
    [
      'workflow:',
      '  id: agent-step-workflow',
      '  steps:',
      '    - id: write',
      '      type: agent',
      '      stage_type: pipeline',
      '      team: lonely-writer',
      '      agent: writer',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: final-draft.md',
      '  output:',
      '    from_step: write',
      '    artifact: final-draft.md',
      '',
    ].join('\n'),
  )
  return { templatePath, teamPath }
}

test('an agent-only step whose pinned connection is gone earns an offer', async () => {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-choice-')),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'root-agent-step')
  fs.mkdirSync(assignmentPath, { recursive: true })
  const { templatePath, teamPath } = writeFixture(workspace)
  const entry: TeamRegistryEntry = {
    name: 'lonely-writer',
    type: 'team',
    team_path: teamPath,
    output_artifact: 'final-draft.md',
  }
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  try {
    const outcome = await runWorkflowOutcome({
      workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
      teamRegistry: new Map([['lonely-writer', entry]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-agent-step',
      parentSessionId: 'root-agent-step',
      taskId: 'task-agent-step',
      productSessionId: 'session-agent-step',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    })

    assert.equal(outcome.kind, 'awaiting_model_choice')
    if (outcome.kind !== 'awaiting_model_choice') return
    assert.equal(outcome.stepId, 'write')
    assert.equal(outcome.offer.agentName, 'writer')
    assert.deepEqual(outcome.offer.failedChoice, PINNED)
    assert.deepEqual(outcome.offer.proposedDefault, APP_DEFAULT)
    // The approval is scoped to one logical invocation, and the step resolves
    // its authorization against the step id. An offer carrying anything else
    // could never be matched by the approval it produces.
    assert.equal(outcome.offer.logicalInvocationId, 'write')
  } finally {
    setRuntimeDefaultModelState(undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an inheriting step records default use, not an Agent choice', async () => {
  // The step reconstructs a pair to dispatch with. If it reconstructs every
  // pair as the Agent's own explicit choice, an Agent that named no model at
  // all is recorded as having chosen the application default — history then
  // says a persona setting exists that nobody configured, and the notice that
  // should say "no Agent model selected" says nothing.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-inherit-')),
  )
  fs.mkdirSync(path.join(workspace, 'assignments', 'root-inherit'), { recursive: true })
  const { templatePath, teamPath } = writeFixture(workspace, { pinned: false })
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'connection:missing-connection',
    model: 'default-model',
  })
  try {
    await runWorkflowOutcome({
      workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
      teamRegistry: new Map([[
        'lonely-writer',
        { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' } as TeamRegistryEntry,
      ]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-inherit',
      parentSessionId: 'root-inherit',
      taskId: 'task-inherit',
      productSessionId: 'session-inherit',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    }).catch(() => undefined)

    const start = readRunLog(workspace).find((record) => record.event === 'start')
    assert.ok(start, 'the dispatch recorded a start')
    assert.deepEqual(start.model_selection, {
      provider: 'connection:missing-connection',
      model: 'default-model',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a step whose selection the loader could not resolve never dispatches', async () => {
  // No pair on the Agent and no application default. There is nothing to run
  // and nothing to offer, so the step has to stop with the loader's own reason
  // rather than dispatching an empty pair as though it were a choice.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-unresolved-')),
  )
  fs.mkdirSync(path.join(workspace, 'assignments', 'root-unresolved'), { recursive: true })
  const { templatePath, teamPath } = writeFixture(workspace, { pinned: false })
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'unset' })
  try {
    const outcome = await runWorkflowOutcome({
      workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
      teamRegistry: new Map([[
        'lonely-writer',
        { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' } as TeamRegistryEntry,
      ]]),
      brief: 'Draft a recommendation.',
      workspacePath: workspace,
      spawnDepth: 0,
      rootSessionId: 'root-unresolved',
      parentSessionId: 'root-unresolved',
      taskId: 'task-unresolved',
      productSessionId: 'session-unresolved',
      persistenceMode: 'required' as const,
      executionAttemptId: 'attempt-one',
      modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
    }).catch((error: unknown) => error)

    assert.ok(outcome instanceof Error, 'the step stopped instead of dispatching')
    assert.match(outcome.message, /no model selected|no application default/i)
    assert.deepEqual(readRunLog(workspace), [], 'nothing was dispatched')
  } finally {
    setRuntimeDefaultModelState(undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an approved retry is a distinct attempt, and the first one stays on record', async () => {
  // Consent is scoped to one logical invocation, so that id is stable across
  // attempts. The concrete attempt identity must not be: the evaluator refuses
  // a second start under one dispatch id as contradictory evidence, and the
  // transcript keeps the first selection it sees per dispatch id, so a reused
  // identity both breaks the next offer and hides the retry's own model.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-retry-')),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'root-retry')
  fs.mkdirSync(assignmentPath, { recursive: true })
  // Settings the Agent chose: one the approved connection applies and one it
  // has no field for. §4.3 asks for them to be re-evaluated on the switch, and
  // the run has to say which stopped applying.
  const { templatePath, teamPath } = writeFixture(workspace, {
    providerOptions: '{"max_tokens": 512, "thinking_budget": 2048}',
  })
  const common = {
    workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
    teamRegistry: new Map([[
      'lonely-writer',
      { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' } as TeamRegistryEntry,
    ]]),
    brief: 'Draft a recommendation.',
    workspacePath: workspace,
    spawnDepth: 0,
    rootSessionId: 'root-retry',
    parentSessionId: 'root-retry',
    taskId: 'task-retry',
    productSessionId: 'session-retry',
    persistenceMode: 'required' as const,
    modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
  }
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  try {
    const waiting = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-one',
    })
    assert.equal(waiting.kind, 'awaiting_model_choice')
    if (waiting.kind !== 'awaiting_model_choice') return

    await new FileSystemWorkflowStateStore(assignmentPath).approveModelChoice({
      expectedRevision: waiting.workflowRevision,
      offerId: waiting.offer.offerId,
    })

    await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      recoveryMode: true,
    }).catch(() => undefined)

    const starts = readRunLog(workspace).filter((record) => record.event === 'start')
    assert.equal(starts.length, 2, 'both attempts are on record')
    assert.notEqual(
      starts[0]?.dispatch_id,
      starts[1]?.dispatch_id,
      'each concrete attempt has its own dispatch identity',
    )
    assert.equal(starts[0]?.logical_invocation_id, 'write')
    assert.equal(starts[1]?.logical_invocation_id, 'write')
    // The attempt on the Agent's own pair carries its settings untouched; the
    // approved one names the setting its new provider has no field for.
    assert.equal(starts[0]?.dropped_provider_options, undefined)
    assert.deepEqual(
      starts[1]?.dropped_provider_options,
      ['thinking_budget'],
      'the retry says which setting stopped applying',
    )
    // The retry ran on the pair the user approved; the first attempt still
    // says what it actually tried.
    assert.deepEqual(starts[0]?.model_selection, {
      ...PINNED,
      source: 'agent',
      reason: 'explicit-agent-choice',
      caller: 'agent',
    })
    assert.deepEqual(starts[1]?.model_selection, {
      ...APP_DEFAULT,
      source: 'app-default',
      reason: 'user-approved-retry',
      caller: 'agent',
      requestedProvider: PINNED.provider,
      requestedModel: PINNED.model,
    })
  } finally {
    setRuntimeDefaultModelState(undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an approved model choice is continued through the real continuation path', async () => {
  // Approval and admission are two separate things. The API enqueues a
  // continuation and the runtime starts a *new* execution attempt for it, so
  // the resumed run has to take ownership of the durable workflow. Ownership
  // transfer in continuation mode used to require a submitted human input,
  // which a model-choice approval never produces — so a real continuation
  // stopped before dispatch with "no submitted human input to continue", and
  // the only thing that appeared to work was recovery mode, which is not the
  // path the product takes.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-continue-')),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'root-continue')
  fs.mkdirSync(assignmentPath, { recursive: true })
  const { templatePath, teamPath } = writeFixture(workspace)
  const common = {
    workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
    teamRegistry: new Map([[
      'lonely-writer',
      { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' } as TeamRegistryEntry,
    ]]),
    brief: 'Draft a recommendation.',
    workspacePath: workspace,
    spawnDepth: 0,
    rootSessionId: 'root-continue',
    parentSessionId: 'root-continue',
    taskId: 'task-continue',
    productSessionId: 'session-continue',
    persistenceMode: 'required' as const,
    modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
  }
  setConfiguredProviderConnections([])
  setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
  try {
    const waiting = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-one',
    })
    assert.equal(waiting.kind, 'awaiting_model_choice')
    if (waiting.kind !== 'awaiting_model_choice') return

    await new FileSystemWorkflowStateStore(assignmentPath).approveModelChoice({
      expectedRevision: waiting.workflowRevision,
      offerId: waiting.offer.offerId,
    })

    // The continuation the API enqueues: a new execution attempt, in
    // continuation mode, carrying the admission request that authorized it.
    await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      continuationMode: true,
      continuationAdmissionRequestId: 'admission-1',
    }).catch((error: unknown) => {
      // A dispatch failure is expected here — the approved default is a
      // connection that is not registered either. Anything else means the
      // continuation never got that far, and the message says which.
      const message = error instanceof Error ? error.message : String(error)
      assert.match(
        message,
        /connection:missing-default|Provider/,
        `the continuation stopped before dispatching: ${message}`,
      )
    })

    const starts = readRunLog(workspace).filter((record) => record.event === 'start')
    assert.equal(starts.length, 2, 'the continuation actually dispatched')
    assert.deepEqual(starts[1]?.model_selection, {
      ...APP_DEFAULT,
      source: 'app-default',
      reason: 'user-approved-retry',
      caller: 'agent',
      requestedProvider: PINNED.provider,
      requestedModel: PINNED.model,
    })
    // Ownership moved to the attempt that ran, and the admission that
    // authorized it is on record.
    const reopened = await new FileSystemWorkflowStateStore(assignmentPath).requireSnapshot()
    assert.equal(reopened.state.ownerExecutionAttemptId, 'attempt-two')
  } finally {
    setRuntimeDefaultModelState(undefined)
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

/** A two-step workflow, each step pinned to a different absent connection. */
function writeTwoStepFixture(workspace: string): { templatePath: string; teamPath: string } {
  const teamPath = path.join(workspace, 'teams', 'two-writers')
  fs.mkdirSync(teamPath, { recursive: true })
  for (const [name, connection] of [
    ['writer-a', 'connection:missing-a'],
    ['writer-b', 'connection:missing-b'],
  ] as const) {
    const agentDir = path.join(workspace, 'agents', name)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${name}.md`),
      ['---', `provider: ${connection}`, 'model: pinned-model', 'thinking: low', '---', '', 'Write.', ''].join('\n'),
    )
  }
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    [
      'team:',
      '  name: two-writers',
      '  description: Two writers',
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
      '    completion_artifact: second-draft.md',
      'agents:',
      '  - name: writer-a',
      '    type: agent',
      '    role: Writer',
      '    tier: strategic',
      '    agent_file: ../../agents/writer-a/writer-a.md',
      '    produces:',
      '      - path: first-draft.md',
      '  - name: writer-b',
      '    type: agent',
      '    role: Writer',
      '    tier: strategic',
      '    agent_file: ../../agents/writer-b/writer-b.md',
      '    produces:',
      '      - path: second-draft.md',
      'levels:',
      '  - id: execute',
      '    name: Execute',
      '    order: 0',
      '    agents:',
      '      - writer-a',
      '      - writer-b',
      '    stage:',
      '      type: pipeline',
      '      config:',
      '        output:',
      '          format: second-draft.md',
      '          user_review: false',
      '',
    ].join('\n'),
  )
  const templatePath = path.join(workspace, 'two-step.yaml')
  fs.writeFileSync(
    templatePath,
    [
      'workflow:',
      '  id: two-step-workflow',
      '  steps:',
      '    - id: first',
      '      type: agent',
      '      stage_type: pipeline',
      '      team: two-writers',
      '      agent: writer-a',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: first-draft.md',
      '    - id: second',
      '      type: agent',
      '      stage_type: pipeline',
      '      team: two-writers',
      '      agent: writer-b',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: second-draft.md',
      '  output:',
      '    from_step: second',
      '    artifact: second-draft.md',
      '',
    ].join('\n'),
  )
  return { templatePath, teamPath }
}

test('a second approval admits its own step, and leaves the first step\'s receipt alone', async () => {
  // Two approvals in one run. The continuation has to admit the step this
  // admission is for, not the first step that ever held an approval: a
  // predecessor that was approved and has since finished still carries its
  // approval, and claiming that one would overwrite a settled receipt while
  // leaving the step actually waiting exactly where it was.
  const provider = await startFakeChatCompletionsServer({
    script: [
      { content: 'First draft from the app default.' },
      { content: 'Second draft from the app default.' },
    ],
  })
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Working default',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'default-key',
    },
  ])
  const workingDefault = { provider: `connection:${connectionId}`, model: 'default-model' }
  setRuntimeDefaultModelState({ status: 'available', ...workingDefault })
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-two-step-choice-')),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'root-two-step')
  fs.mkdirSync(assignmentPath, { recursive: true })
  const { templatePath, teamPath } = writeTwoStepFixture(workspace)
  const common = {
    workflowEntry: { name: 'two-step-workflow', template_path: templatePath },
    teamRegistry: new Map([[
      'two-writers',
      { name: 'two-writers', type: 'team', team_path: teamPath, output_artifact: 'second-draft.md' } as TeamRegistryEntry,
    ]]),
    brief: 'Draft a recommendation.',
    workspacePath: workspace,
    spawnDepth: 0,
    rootSessionId: 'root-two-step',
    parentSessionId: 'root-two-step',
    taskId: 'task-two-step',
    productSessionId: 'session-two-step',
    persistenceMode: 'required' as const,
    modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
  }
  try {
    const store = () => new FileSystemWorkflowStateStore(assignmentPath)
    const firstWait = await runWorkflowOutcome({ ...common, executionAttemptId: 'attempt-one' })
    assert.equal(firstWait.kind, 'awaiting_model_choice')
    if (firstWait.kind !== 'awaiting_model_choice') return
    assert.equal(firstWait.stepId, 'first')
    await store().approveModelChoice({
      expectedRevision: firstWait.workflowRevision,
      offerId: firstWait.offer.offerId,
    })

    // The first step now runs on the approved default and finishes, and the
    // second step fails on its own pinned connection.
    const secondWait = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      continuationMode: true,
      continuationAdmissionRequestId: 'admission-a',
    })
    assert.equal(secondWait.kind, 'awaiting_model_choice')
    if (secondWait.kind !== 'awaiting_model_choice') return
    assert.equal(secondWait.stepId, 'second', 'the run moved on to the second step')
    await store().approveModelChoice({
      expectedRevision: secondWait.workflowRevision,
      offerId: secondWait.offer.offerId,
    })

    await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-three',
      continuationMode: true,
      continuationAdmissionRequestId: 'admission-b',
    })

    const reopened = await store().requireSnapshot()
    const first = reopened.state.steps.find((step) => step.stepId === 'first')
    const second = reopened.state.steps.find((step) => step.stepId === 'second')
    assert.equal(first?.modelChoiceContinuationAdmissionRequestId, 'admission-a')
    assert.equal(second?.modelChoiceContinuationAdmissionRequestId, 'admission-b')
  } finally {
    setRuntimeDefaultModelState(undefined)
    setConfiguredProviderConnections([])
    await provider.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a direct agent step refuses provider options nobody can use', async () => {
  // A workflow step of `type: agent` loads its Agent itself rather than going
  // through Team startup, so the refusal Team startup performs has to be asked
  // here too. Without it the step runs with its settings silently dropped, and
  // a credential written into the Agent file is neither used nor reported.
  // Asserted for both an Agent that names its own pair and one that inherits,
  // because the options are unusable either way.
  for (const pinned of [true, false]) {
    const workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-options-')),
    )
    fs.mkdirSync(path.join(workspace, 'assignments', 'root-options'), { recursive: true })
    const { templatePath, teamPath } = writeFixture(workspace, {
      pinned,
      providerOptions: '{"api_key": "sk-should-never-be-here"}',
    })
    setConfiguredProviderConnections([])
    setRuntimeDefaultModelState({ status: 'available', ...APP_DEFAULT })
    try {
      const outcome = await runWorkflowOutcome({
        workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
        teamRegistry: new Map([[
          'lonely-writer',
          { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' } as TeamRegistryEntry,
        ]]),
        brief: 'Draft a recommendation.',
        workspacePath: workspace,
        spawnDepth: 0,
        rootSessionId: 'root-options',
        parentSessionId: 'root-options',
        taskId: 'task-options',
        productSessionId: 'session-options',
        persistenceMode: 'required' as const,
        executionAttemptId: 'attempt-one',
        modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
      }).catch((error: unknown) => error)

      assert.ok(outcome instanceof Error, `pinned=${pinned}: the step refused`)
      assert.match(outcome.message, /Credentials belong in Settings/)
      // Nothing dispatched, so nothing to offer a retry for either.
      assert.deepEqual(readRunLog(workspace), [], 'nothing was dispatched')
    } finally {
      setRuntimeDefaultModelState(undefined)
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  }
})


/** A loopback that records the request bodies a workflow step really sends. */
async function startRecordingProvider(): Promise<{
  readonly url: string
  readonly bodies: Record<string, unknown>[]
  close(): Promise<void>
}> {
  const bodies: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.once('end', () => {
      try {
        bodies.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >,
        )
      } catch {
        bodies.push({})
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'Answered.' }, index: 0 }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the recording provider did not bind')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('an approved retry on a workflow step sends the settings its new provider applies', async () => {
  // The companion to the log assertion above. That one proves the run *says*
  // which setting stopped applying; this one proves the other half — that the
  // setting which survived is really in the request the provider received.
  // Neither is inferable from the other, and dropping both was the behaviour
  // this capability replaces.
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-agent-step-outbound-')),
  )
  const assignmentPath = path.join(workspace, 'assignments', 'root-outbound')
  fs.mkdirSync(assignmentPath, { recursive: true })
  const { templatePath, teamPath } = writeFixture(workspace, {
    providerOptions: '{"max_tokens": 512, "thinking_budget": 2048}',
  })
  const provider = await startRecordingProvider()
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Workflow step loopback',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'workflow-step-key',
    },
  ])
  const providerName = `connection:${connectionId}`
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: 'default-model',
  })
  const common = {
    workflowEntry: { name: 'agent-step-workflow', template_path: templatePath },
    teamRegistry: new Map([[
      'lonely-writer',
      { name: 'lonely-writer', type: 'team', team_path: teamPath, output_artifact: 'final-draft.md' } as TeamRegistryEntry,
    ]]),
    brief: 'Draft a recommendation.',
    workspacePath: workspace,
    spawnDepth: 0,
    rootSessionId: 'root-outbound',
    parentSessionId: 'root-outbound',
    taskId: 'task-outbound',
    productSessionId: 'session-outbound',
    persistenceMode: 'required' as const,
    modelChoiceEvaluator: createWorkflowModelChoiceEvaluator(),
  }
  try {
    const waiting = await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-one',
    })
    assert.equal(waiting.kind, 'awaiting_model_choice')
    if (waiting.kind !== 'awaiting_model_choice') return

    await new FileSystemWorkflowStateStore(assignmentPath).approveModelChoice({
      expectedRevision: waiting.workflowRevision,
      offerId: waiting.offer.offerId,
    })
    await runWorkflowOutcome({
      ...common,
      executionAttemptId: 'attempt-two',
      recoveryMode: true,
    }).catch(() => undefined)

    assert.equal(provider.bodies.length, 1, 'the approved retry ran once')
    assert.equal(
      provider.bodies[0]?.max_tokens,
      512,
      'the setting this connection applies survived the switch',
    )
    assert.equal(
      provider.bodies[0]?.thinking_budget,
      undefined,
      'and the one it has no field for was not invented for it',
    )


  } finally {
    setConfiguredProviderConnections([])
    setRuntimeDefaultModelState({ status: 'unset' })
    await provider.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

