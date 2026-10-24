/**
 * What `session_start` records when it puts the host on the entry level's pair.
 *
 * The runtime works out the pair the level wants, looks it up in Pi's model
 * registry, and then leaves the host where it is, switches it, or stops the
 * run on a config error. Each of those writes one `host.model_selection.*`
 * record to `host-events.jsonl` under the run's identity, and a host that ends
 * up ready is then recorded as `host.model_selection.resolved`. A level that
 * wants no pair registers no provider and gets only the `resolved` record.
 *
 * These boot the real `team-runtime/index.ts` on a fixture Team. Only the Pi
 * host around it is a fake.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { DEFAULT_MODEL_SELECTION_ENV } from '../../domains/provider/provider-settings.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
  type FixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

const ROOT_SESSION_ID = 'root-session-host-selection'
const INTAKE_TOOLS = ['spawn_team', 'inspect-task-state']

const BUILT_IN_ANTHROPIC_MODEL = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  provider: 'anthropic',
  api: 'anthropic-messages',
  reasoning: true,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 64_000,
}

/**
 * The run's identity as the boot sets it: TEAM_SESSION_ID is removed, so the
 * session is the fixture's assignment id, and the root session is set here.
 */
const IDENTITY_ENV = { ANTHROPIC_API_KEY: 'test-key', TEAM_ROOT_SESSION_ID: ROOT_SESSION_ID }
const IDENTITY_UNSET_ENV = ['TEAM_SESSION_ID']

function modelSelectionRecords(runtime: FixtureRuntime): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.hostEvents)
    .filter((record) => String(record.event).startsWith('host.model_selection.'))
}

/** A record without its timestamp, which no test can know in advance. */
function withoutTimestamp(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!record) return {}
  const { timestamp: _timestamp, ...rest } = record
  return rest
}

test("a desired pair missing from Pi's registry stops startup on one config error, recorded with the first twelve distinct pairs on offer", {
  timeout: 60_000,
}, async () => {
  const label = 'host-selection-missing'
  // After the fixture's own model: a second listing of that same pair, then
  // twelve more. The preview drops the repeat and stops at twelve pairs.
  const moreLocalModels = Array.from({ length: 12 }, (_value, index) => ({
    provider: FIXTURE_HOST_PROVIDER,
    id: `local-model-${String(index + 2).padStart(2, '0')}`,
  }))
  const runtime = await bootFixtureRuntime({
    label,
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tools: INTAKE_TOOLS,
      },
    },
    env: IDENTITY_ENV,
    unsetEnv: IDENTITY_UNSET_ENV,
    // No built-in anthropic model, so no fallback makes the pair available.
    hostModels: [
      { provider: FIXTURE_HOST_PROVIDER, id: FIXTURE_HOST_MODEL_ID },
      ...moreLocalModels,
    ],
  })
  try {
    const availablePreview = [
      'lm-studio:local-model',
      'lm-studio:local-model-02',
      'lm-studio:local-model-03',
      'lm-studio:local-model-04',
      'lm-studio:local-model-05',
      'lm-studio:local-model-06',
      'lm-studio:local-model-07',
      'lm-studio:local-model-08',
      'lm-studio:local-model-09',
      'lm-studio:local-model-10',
      'lm-studio:local-model-11',
      'lm-studio:local-model-12',
    ].join(', ')

    assert.deepEqual(runtime.host.hostModelSwitches, [], 'no host model may be selected')
    const records = modelSelectionRecords(runtime)
    assert.deepEqual(
      records.map((record) => withoutTimestamp(record)),
      [
        {
          event: 'host.model_selection.blocked',
          session_id: `assignment-${label}`,
          root_session_id: ROOT_SESSION_ID,
          assignment_path: runtime.assignmentPath,
          desired_provider: 'anthropic',
          desired_model: 'claude-sonnet-4-6',
          current_provider: null,
          current_model: null,
          available_preview: availablePreview,
        },
      ],
      'one blocked record, and no switch or resolution after it',
    )

    const configErrors = runtime
      .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
      .filter((record) => record.event === 'runtime.config_error')
      .map((record) => record.errors)
    assert.deepEqual(configErrors, [
      [
        "Configured host model 'claude-sonnet-4-6' on provider 'anthropic' was not found in Pi's host model registry. " +
          `Team execution is blocked. Available: ${availablePreview}`,
      ],
    ])
    assert.equal(
      runtime.host.notifications.filter((notice) => notice.level === 'error').length,
      1,
      `told once; got ${JSON.stringify(runtime.host.notifications)}`,
    )
    assert.deepEqual(
      await runtime.host.callHandler('input', { type: 'input', text: 'Start.', source: 'interactive' }),
      { action: 'handled' },
    )
  } finally {
    await runtime.close()
  }
})

test('a host switch is recorded with the pair asked for, the pair the host was on and the pair selected, under the run identity', {
  timeout: 60_000,
}, async () => {
  const label = 'host-selection-switch'
  const runtime = await bootFixtureRuntime({
    label,
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tools: INTAKE_TOOLS,
      },
    },
    env: IDENTITY_ENV,
    unsetEnv: IDENTITY_UNSET_ENV,
    hostModels: [BUILT_IN_ANTHROPIC_MODEL],
    initialHostModel: { provider: FIXTURE_HOST_PROVIDER, id: FIXTURE_HOST_MODEL_ID },
  })
  try {
    assert.deepEqual(
      runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      ['anthropic-api:claude-sonnet-4-6'],
    )
    const records = modelSelectionRecords(runtime)
    assert.deepEqual(
      records.map((record) => record.event),
      ['host.model_selection.switch', 'host.model_selection.resolved'],
    )
    // The desired provider is the declared name; the selected one is the name
    // Pi's registry lists it under.
    assert.deepEqual(withoutTimestamp(records[0]), {
      event: 'host.model_selection.switch',
      session_id: `assignment-${label}`,
      root_session_id: ROOT_SESSION_ID,
      assignment_path: runtime.assignmentPath,
      desired_provider: 'anthropic',
      desired_model: 'claude-sonnet-4-6',
      current_provider: FIXTURE_HOST_PROVIDER,
      current_model: FIXTURE_HOST_MODEL_ID,
      selected_provider: 'anthropic-api',
      selected_model: 'claude-sonnet-4-6',
    })
  } finally {
    await runtime.close()
  }
})

test('a host already on the desired pair is left there, and the selection is recorded as already selected', {
  timeout: 60_000,
}, async () => {
  const label = 'host-selection-already-selected'
  const runtime = await bootFixtureRuntime({
    label,
    // The fixture persona declares the fixture's own lm-studio pair.
    team: { coordinator: { name: 'intake-agent', tools: INTAKE_TOOLS } },
    env: IDENTITY_ENV,
    unsetEnv: IDENTITY_UNSET_ENV,
    initialHostModel: { provider: FIXTURE_HOST_PROVIDER, id: FIXTURE_HOST_MODEL_ID },
  })
  try {
    assert.deepEqual(runtime.host.hostModelSwitches, [], 'a host already on the pair is not switched')
    const records = modelSelectionRecords(runtime)
    assert.deepEqual(
      records.map((record) => record.event),
      ['host.model_selection.already_selected', 'host.model_selection.resolved'],
    )
    assert.deepEqual(withoutTimestamp(records[0]), {
      event: 'host.model_selection.already_selected',
      session_id: `assignment-${label}`,
      root_session_id: ROOT_SESSION_ID,
      assignment_path: runtime.assignmentPath,
      selected_provider: FIXTURE_HOST_PROVIDER,
      selected_model: FIXTURE_HOST_MODEL_ID,
    })
  } finally {
    await runtime.close()
  }
})

test('a level with no coordinator and no application default leaves the host alone and registers no provider, even with an Anthropic key and built-in models', {
  timeout: 60_000,
}, async () => {
  // Forget any default an earlier read cached, so the boot reads it from the
  // environment, where it is removed.
  setRuntimeDefaultModelState(undefined)
  const runtime = await bootFixtureRuntime({
    label: 'host-selection-no-desired-pair',
    team: {
      coordinator: { name: 'intake-agent', tools: INTAKE_TOOLS },
      stage: 'pipeline',
      omitStageCoordinator: true,
    },
    env: IDENTITY_ENV,
    unsetEnv: [...IDENTITY_UNSET_ENV, DEFAULT_MODEL_SELECTION_ENV],
    hostModels: [BUILT_IN_ANTHROPIC_MODEL],
  })
  try {
    assert.deepEqual(
      runtime.host.providerRegistrations.map((registration) => registration.name),
      [],
      'the Anthropic fallback is registered only for a level that wants a pair',
    )
    assert.deepEqual(runtime.host.hostModelSwitches, [], 'no host model may be selected')
    assert.deepEqual(
      modelSelectionRecords(runtime).map((record) => record.event),
      ['host.model_selection.resolved'],
      'nothing is recorded as switched, kept or blocked',
    )
    assert.deepEqual(
      runtime
        .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
        .filter((record) => record.event === 'runtime.config_error'),
      [],
    )
  } finally {
    await runtime.close()
    setRuntimeDefaultModelState(undefined)
  }
})
