/**
 * A declared coordinator that never loaded stops the boot before any tool
 * registers.
 *
 * The capability policy's `runtime_owned_tool_denied` sentence ("Nothing to
 * change here.") is only true because a stage whose coordinator is missing
 * cannot reach a tool call at all. A level naming an agent whose persona file
 * is absent is refused at boot, over every level rather than only the entry
 * one, and nothing is registered for Pi to call.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

const INTAKE = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }

test('a later level whose declared coordinator cannot be loaded stops the boot before any tool registers', {
  timeout: 60_000,
}, async () => {
  // The entry level is valid. Only the level the run has not reached names an
  // agent with no persona file.
  const runtime = await bootFixtureRuntime({
    label: 'unloadable-later-coordinator',
    team: {
      coordinator: INTAKE,
      laterLevels: [{ id: 'review', coordinator: { name: 'auditor', loadable: false } }],
    },
  })
  try {
    assert.deepEqual(
      runtime.host.registered.map((tool) => tool.name),
      [],
      'no tool may be registered for a Team whose declared coordinator never loaded',
    )
    assert.deepEqual(runtime.host.hostModelSwitches, [], 'no host model may be selected')

    const errorNotices = runtime.host.notifications.filter((notice) => notice.level === 'error')
    assert.equal(errorNotices.length, 1, `told once; got ${JSON.stringify(runtime.host.notifications)}`)
    assert.match(
      errorNotices[0]?.message ?? '',
      /level 'review' declares coordinator 'auditor', which is not a loaded Agent/,
    )

    const configErrors = runtime
      .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
      .filter((record) => record.event === 'runtime.config_error')
    assert.equal(configErrors.length, 1, 'the refusal is recorded durably')
    assert.match(JSON.stringify(configErrors[0]?.errors), /'auditor'/)
  } finally {
    await runtime.close()
  }
})

test('the same two-level Team with every coordinator on disk boots and registers its tools', {
  timeout: 60_000,
}, async () => {
  // Control for the test above: the fixture shape itself boots, so the empty
  // registration there comes from the missing persona file.
  const runtime = await bootFixtureRuntime({
    label: 'loadable-later-coordinator',
    team: {
      coordinator: INTAKE,
      laterLevels: [{ id: 'review', coordinator: { name: 'auditor' } }],
    },
  })
  try {
    const registeredNames = runtime.host.registered.map((tool) => tool.name)
    assert.ok(
      registeredNames.includes('inspect-task-state'),
      `the entry level's tools must register; got ${registeredNames.join(', ')}; ` +
        `notices: ${JSON.stringify(runtime.host.notifications)}`,
    )
    assert.deepEqual(
      runtime.host.notifications.filter((notice) => notice.level === 'error'),
      [],
    )
  } finally {
    await runtime.close()
  }
})
