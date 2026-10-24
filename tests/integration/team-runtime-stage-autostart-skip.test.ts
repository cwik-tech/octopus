/**
 * When the Team Runtime does not start a stage itself, it says so.
 *
 * A delegated child is told to reply NOOP while runtime autostart owns its
 * stage. An autostart that declined without a record left the host silenced
 * for a stage nobody ran, and the parent blamed the host provider. These boot
 * the real `team-runtime/index.ts` on a fixture Team and read the
 * `runtime.stage_autostart.skipped` event it writes to the assignment's
 * runtime-events log.
 *
 * `TEAM_RUNTIME_FAULT_INJECT=skip_stage_autostart` is the test-only way to make
 * autostart decline. The fault stages here are pipelines, whose autostart runs
 * no agent, so a runtime that ignored the fault would still finish the boot.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
  type FixtureRuntime,
  type FixtureStageType,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }
const FAULT = 'skip_stage_autostart'
/** The stage types the runtime does not start itself unless TEAM_DELEGATED_AUTOSTART=1. */
const COORDINATED_ONLY_STAGES: readonly FixtureStageType[] = ['routing', 'discussion']

function runtimeEvents(runtime: FixtureRuntime, event: string): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
    .filter((record) => record.event === event)
}

function onlyEvent(runtime: FixtureRuntime, event: string): Record<string, unknown> {
  const records = runtimeEvents(runtime, event)
  assert.equal(records.length, 1, `exactly one ${event}; got ${JSON.stringify(records)}`)
  const [record] = records
  assert.ok(record)
  return record
}

/**
 * The skip event with its timestamp checked and removed, so the rest can be
 * compared whole: an unexpected field fails the comparison too.
 */
function skippedEventFields(runtime: FixtureRuntime): Record<string, unknown> {
  const { timestamp, ...fields } = onlyEvent(runtime, 'runtime.stage_autostart.skipped')
  assert.equal(typeof timestamp, 'string')
  return fields
}

function expectedSkip(
  runtime: FixtureRuntime,
  fields: {
    readonly stageType: string
    readonly reason: string
    readonly delegatedAutostart: boolean
  },
): Record<string, unknown> {
  const registration = onlyEvent(runtime, 'tools.registered')
  return {
    event: 'runtime.stage_autostart.skipped',
    session_id: registration.session_id,
    root_session_id: registration.root_session_id,
    level_id: 'intake',
    stage_type: fields.stageType,
    reason: fields.reason,
    delegated_autostart: fields.delegatedAutostart,
    missing_tools: [],
    registered_tools: runtime.host.registered.map((tool) => tool.name),
  }
}

function assertStageNeverBegan(runtime: FixtureRuntime): void {
  assert.deepEqual(runtimeEvents(runtime, 'runtime.stage_autostart.begin'), [])
  assert.deepEqual(runtimeEvents(runtime, 'runtime.stage_autostart.end'), [])
  assert.deepEqual(
    runtime
      .readAssignmentJsonl(ASSIGNMENT_LOG.toolUse)
      .filter((record) => record.runtime_autostart === true),
    [],
    'no stage tool ran on the runtime autostart path',
  )
}

test('a fault-injected autostart records one skip naming the cause and every registered tool, and never begins the stage', {
  timeout: 120_000,
}, async (t) => {
  for (const delegatedAutostart of [true, false]) {
    await t.test(delegatedAutostart ? 'delegated boot' : 'boot without delegated autostart', async () => {
      const runtime = await bootFixtureRuntime({
        label: `autostart-fault-${delegatedAutostart ? 'delegated' : 'plain'}`,
        team: { coordinator: COORDINATOR, stage: 'pipeline' },
        delegatedAutostart,
        faultInjection: FAULT,
      })
      try {
        assert.ok(runtime.host.registered.length > 0, 'precondition: the level registered its tools')
        assert.deepEqual(
          skippedEventFields(runtime),
          expectedSkip(runtime, {
            stageType: 'pipeline',
            reason: 'fault_injected',
            delegatedAutostart,
          }),
        )
        assertStageNeverBegan(runtime)

        // The runtime does not claim the stage it skipped: the host is put on
        // the coordinator's pair, the stage entry is queued for it, and its
        // input is not swallowed.
        assert.deepEqual(
          runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
          [`${FIXTURE_HOST_PROVIDER}:${FIXTURE_HOST_MODEL_ID}`],
        )
        const followUp = onlyEvent(runtime, 'runtime.follow_up_enqueued')
        assert.equal(followUp.follow_up_kind, 'stage_entry')
        assert.equal(followUp.target_level_id, 'intake')
        assert.deepEqual(
          await runtime.host.callHandler('input', { type: 'input', text: 'Fixture request.' }),
          { action: 'continue' },
        )
      } finally {
        await runtime.close()
      }
    })
  }
})

test('a coordinated routing or discussion stage the runtime does not start itself records why', {
  timeout: 120_000,
}, async (t) => {
  for (const stage of COORDINATED_ONLY_STAGES) {
    await t.test(`${stage} stage`, async () => {
      const runtime = await bootFixtureRuntime({
        label: `autostart-not-autostartable-${stage}`,
        team: { coordinator: COORDINATOR, stage },
      })
      try {
        assert.deepEqual(
          skippedEventFields(runtime),
          expectedSkip(runtime, {
            stageType: stage,
            reason: 'stage_not_autostartable',
            delegatedAutostart: false,
          }),
        )
        assertStageNeverBegan(runtime)
      } finally {
        await runtime.close()
      }
    })
  }
})

test('the fault-injection value is fixed when the extension loads, not when the session starts', {
  timeout: 120_000,
}, async (t) => {
  await t.test('clearing the variable before session_start still skips', async () => {
    const runtime = await bootFixtureRuntime({
      label: 'autostart-fault-cleared',
      team: { coordinator: COORDINATOR, stage: 'pipeline' },
      delegatedAutostart: true,
      faultInjection: FAULT,
      startSession: false,
    })
    try {
      delete process.env.TEAM_RUNTIME_FAULT_INJECT
      await runtime.startSession()
      assert.equal(skippedEventFields(runtime).reason, 'fault_injected')
      assertStageNeverBegan(runtime)
    } finally {
      await runtime.close()
    }
  })

  await t.test('setting the variable before session_start does not skip', async () => {
    const runtime = await bootFixtureRuntime({
      label: 'autostart-fault-late',
      team: { coordinator: COORDINATOR, stage: 'pipeline' },
      delegatedAutostart: true,
      startSession: false,
    })
    try {
      process.env.TEAM_RUNTIME_FAULT_INJECT = FAULT
      await runtime.startSession()
      assert.deepEqual(runtimeEvents(runtime, 'runtime.stage_autostart.skipped'), [])
      assert.equal(onlyEvent(runtime, 'runtime.stage_autostart.begin').tool_name, 'dispatch')
    } finally {
      await runtime.close()
    }
  })
})
