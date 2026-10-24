/**
 * The cost a stage tool records is what the run spent during that call (matrix
 * A4.3, inventory TR-22, the total-cost value).
 *
 * `team-runtime/level-tools.ts` hands every engine and delegation tool a
 * `readTotalCostUsd` that reads the run's total when it is called. The tool's
 * adapter reads it when the call starts and again when it is accepted
 * (`services/engine-capability-adapter.ts`), and the difference is the call's
 * `actualCostUsd`. The Team Runtime's budget port settles the call with that
 * figure (`team-runtime/capability-budget-port.ts`), and the dispatcher stores
 * it on the call's completed record in `capability-dispatch-events.jsonl`.
 *
 * This boots the real runtime on a fixture Team whose entry level is a chain
 * with one member. The runtime starts the chain itself, and the member runs
 * through a fake `claude` executable that reports a cost, so the run's total
 * rises while `handoff` runs. The stored record must carry that cost.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  type FixtureRuntime,
} from '../support/team-runtime-fixture-boot.js'

const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }
const INPUT_BRIEF = 'incoming-brief.md'
/** What the member's one call costs, as the fake `claude` reports it. */
const MEMBER_COST_USD = 0.125

const IDENTITY_ENV = [
  'TEAM_SESSION_ID',
  'TEAM_ROOT_SESSION_ID',
  'TEAM_PARENT_SESSION_ID',
  'TEAM_SPAWN_DEPTH',
  'TEAM_RUNTIME_ASSIGNMENT_PATH',
  'TEAM_RUNTIME_RUN_PATH',
  'TEAM_DELEGATED_AUTOSTART',
] as const

/** Declare the chain's input artifact and write it, so the chain has content. */
function provideInputBrief(runtime: FixtureRuntime): void {
  const teamConfigPath = runtime.teamConfigPath
  assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
  const text = fs.readFileSync(teamConfigPath, 'utf8')
  const from = 'workflow:\n  entry_level: intake\n'
  assert.ok(text.includes(from), 'the fixture team.yaml declares its entry level')
  fs.writeFileSync(
    teamConfigPath,
    text.replace(
      from,
      from +
        '  input_contract:\n' +
        '    artifacts:\n' +
        `      - path: ${INPUT_BRIEF}\n` +
        '        required: true\n',
    ),
  )
  fs.mkdirSync(runtime.assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(runtime.assignmentPath, INPUT_BRIEF), 'Draft the fixture answer.')
}

test('A4.3: the handoff the runtime starts records, as its cost, what the run spent while it ran', {
  timeout: 120_000,
}, async (t) => {
  // A `claude` that answers at once and reports what the call cost.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'armed-tool-cost-claude-'))
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'The fixture answer.',
  model: 'claude-haiku-4-5',
  usage: { input_tokens: 5, output_tokens: 5 },
  total_cost_usd: ${MEMBER_COST_USD},
}) + '\\n')
`, { mode: 0o700 })

  const runtime = await bootFixtureRuntime({
    label: 'armed-tool-cost',
    team: {
      coordinator: COORDINATOR,
      stage: 'chain',
      omitStageCoordinator: true,
      members: [{ name: 'fixture-member', provider: 'claude', model: 'claude-haiku-4-5' }],
    },
    unsetEnv: [...IDENTITY_ENV],
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      // A ledger makes the stage tool a metered call, whose cost is settled.
      TEAM_BUDGET_CAP: '5',
    },
    startSession: false,
  })
  t.after(() => runtime.close())
  provideInputBrief(runtime)

  await runtime.startSession()
  // The shutdown flushes the dispatch evidence.
  await runtime.shutdown()

  const completed = runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.capabilityDispatchEvents)
    .filter((event) =>
      event.type === 'capability.dispatch.completed' &&
      event.capabilityId === 'team-runtime.engine.handoff')
  assert.equal(completed.length, 1, `one completed handoff; got ${JSON.stringify(completed)}`)
  assert.equal(
    completed[0]?.actualCostUsd,
    MEMBER_COST_USD,
    'the handoff records what the run spent while it ran',
  )
})
