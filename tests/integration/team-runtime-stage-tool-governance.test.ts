/**
 * Every tool the Team Runtime hands to Pi runs through the capability policy,
 * for every stage type.
 *
 * Observed through the real `team-runtime/index.ts` booted on a fixture Team:
 * the tools the fixture host received, what Pi's `tool_call` hook returns for
 * each, and what happens when the host executes each one where the policy says
 * no. A tool registered around the policy would run instead of being refused,
 * and would leave no policy record in `tool-use.jsonl` and no dispatch in
 * `capability-dispatch-events.jsonl`.
 *
 * The skill loader is registered as a plain tool rather than through the
 * governed wrapper, so it gets the same checks by its own path: its call must
 * reach the dispatcher under capability `skill.load`.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test, { before } from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  type FixtureRuntime,
  type FixtureRuntimeOptions,
  type FixtureStageType,
} from '../support/team-runtime-fixture-boot.js'

// Loading the runtime module takes about a second and happens once per
// process. Doing it here keeps that cost out of whichever case runs first.
before(async () => {
  await import('../../team-runtime/index.js')
})

const SKILL_LOADER = 'mcp__pipeline_skills__load_skill'
const SKILL_LOADER_CAPABILITY_ID = 'skill.load'

/** A grant with no Pi builtin in it, so no file tool registers. */
const COORDINATOR = { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] }

const STAGE_TOOLS: Record<FixtureStageType, readonly string[]> = {
  routing: [],
  discussion: ['set_roster', 'create_brief', 'converse'],
  pipeline: ['dispatch'],
  chain: ['handoff'],
  broadcast: ['broadcast'],
  review: ['submit_for_review'],
}

/** The stage types that may leave out `coordinator:`. */
const RUNTIME_OWNED_STAGES: readonly FixtureStageType[] = ['pipeline', 'chain', 'broadcast', 'review']
const ALL_STAGES: readonly FixtureStageType[] = ['routing', 'discussion', ...RUNTIME_OWNED_STAGES]

/** Registered for every level, whoever coordinates it. */
const EVERY_LEVEL_TOOLS = [
  'browser',
  'research_web',
  'youtube_extract',
  'generate_word',
  'generate_excel',
  SKILL_LOADER,
]

/** The governed Pi builtins, in registration order. */
const PI_BUILTINS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

/**
 * Arguments that pass each tool's schema and the file-tool safety gate, so the
 * refusal under test is the capability policy's and not an earlier rejection.
 */
const CALL_ARGUMENTS: Record<string, unknown> = {
  set_roster: { agents: ['fixture-member'] },
  create_brief: {
    title: 'Fixture brief',
    inquiry: 'Fixture inquiry.',
    objectives: ['Answer the fixture inquiry.'],
    scope: 'Fixture scope.',
    roster_rationale: { 'fixture-member': 'Fixture reason.' },
    deliverables: ['Fixture answer.'],
  },
  converse: {},
  dispatch: {},
  handoff: { action: 'status' },
  broadcast: {},
  submit_for_review: { action: 'status' },
  spawn_team: { team: 'fixture-specialists', brief: 'Fixture brief.' },
  spawn_workflow: { workflow: 'fixture-workflow', brief: 'Fixture brief.' },
  'inspect-task-state': { taskId: 'task-fixture' },
  browser: { action: 'observe' },
  research_web: { action: 'search', query: 'fixture' },
  youtube_extract: { action: 'inspect', url: 'https://www.youtube.com/watch?v=fixture' },
  generate_word: { action: 'list_profiles' },
  generate_excel: { action: 'list_profiles' },
  [SKILL_LOADER]: { source: 'fixture-skill', sha256: '0'.repeat(64) },
  read: { path: 'notes.md' },
  bash: { command: 'pwd' },
  edit: { path: 'notes.md', edits: [{ oldText: 'draft', newText: 'final' }] },
  write: { path: 'notes.md', content: 'Fixture note.' },
  grep: { pattern: 'fixture' },
  find: { pattern: '*.md' },
  ls: {},
}

function argumentsFor(toolName: string): unknown {
  assert.ok(
    toolName in CALL_ARGUMENTS,
    `no call arguments for registered tool ${toolName}; add them to CALL_ARGUMENTS`,
  )
  return CALL_ARGUMENTS[toolName]
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function registeredNames(runtime: FixtureRuntime): string[] {
  return runtime.host.registered.map((tool) => tool.name)
}

function toolUseFor(runtime: FixtureRuntime, toolCallId: string): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.toolUse)
    .filter((record) => record.tool_call_id === toolCallId)
}

/**
 * The skill loader's evidence event types, sorted. The log has two writers (the
 * evidence writer and the journal projection), so file order is not call order.
 */
function skillLoaderEvidenceTypes(evidence: Array<Record<string, unknown>>): unknown[] {
  return evidence
    .filter((event) => event.capabilityId === SKILL_LOADER_CAPABILITY_ID)
    .map((event) => String(event.type))
    .sort()
}

function listField(record: Record<string, unknown> | undefined, field: string): unknown[] {
  const value = record?.[field]
  assert.ok(Array.isArray(value), `${field} must be a list; got ${JSON.stringify(value)}`)
  return value
}

function toolsRegisteredEvents(runtime: FixtureRuntime): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
    .filter((record) => record.event === 'tools.registered')
}

/**
 * Boot with a one-entry workflow registry beside team.yaml. It is written
 * before the session starts, because the runtime reads it at boot.
 */
async function bootWithWorkflowRegistry(options: FixtureRuntimeOptions): Promise<FixtureRuntime> {
  const runtime = await bootFixtureRuntime({ ...options, startSession: false })
  try {
    const teamConfigPath = runtime.teamConfigPath
    assert.ok(teamConfigPath, 'a Team boot has a team.yaml')
    const workflowsDir = path.join(path.dirname(teamConfigPath), 'workflows')
    fs.mkdirSync(path.join(workflowsDir, 'templates'), { recursive: true })
    fs.writeFileSync(path.join(workflowsDir, 'templates', 'fixture-workflow.yaml'), 'steps: []\n')
    fs.writeFileSync(
      path.join(workflowsDir, 'registry.yaml'),
      'fixture-workflow:\n' +
        '  description: Fixture workflow.\n' +
        '  template_path: ./templates/fixture-workflow.yaml\n',
    )
    await runtime.startSession()
    return runtime
  } catch (error) {
    await runtime.close()
    throw error
  }
}

async function assertHookLetsThrough(runtime: FixtureRuntime, callIdPrefix: string): Promise<void> {
  for (const toolName of registeredNames(runtime)) {
    assert.equal(
      await runtime.host.callToolCall({
        toolName,
        toolCallId: `${callIdPrefix}-hook-${toolName}`,
        input: argumentsFor(toolName),
      }),
      undefined,
      `the tool_call hook must let registered tool ${toolName} through to its wrapper`,
    )
  }
}

/**
 * Execute a tool the policy refuses and return the one tool-use record the
 * refusal wrote. A governed tool rejects with the policy code; the skill loader
 * returns its refusal as a result instead of throwing.
 */
async function executeRefused(
  runtime: FixtureRuntime,
  toolName: string,
  toolCallId: string,
  expectedCode: string,
): Promise<Record<string, unknown>> {
  if (toolName === SKILL_LOADER) {
    const result = await runtime.host.invokeTool(toolName, toolCallId, argumentsFor(toolName))
    const details =
      typeof result === 'object' && result !== null && 'details' in result ? result.details : undefined
    assert.equal(
      typeof details === 'object' && details !== null && 'ok' in details ? details.ok : undefined,
      false,
      `the skill loader must not load a skill for a refused call; got ${JSON.stringify(result)}`,
    )
  } else {
    await assert.rejects(
      runtime.host.invokeTool(toolName, toolCallId, argumentsFor(toolName)),
      (error: unknown) => {
        assert.equal(errorCode(error), expectedCode, `${toolName} must be refused by the capability policy`)
        return true
      },
    )
  }
  const records = toolUseFor(runtime, toolCallId)
  assert.equal(records.length, 1, `one tool-use record for ${toolName}; got ${JSON.stringify(records)}`)
  const [record] = records
  assert.ok(record)
  assert.equal(record.tool_name, toolName)
  assert.equal(record.policy_code, expectedCode)
  assert.equal(record.blocked_by_capability_policy, true)
  return record
}

test('every tool a runtime-owned stage registers passes the tool_call hook and is refused by the capability policy when the host runs it', {
  timeout: 60_000,
}, async (t) => {
  for (const stage of RUNTIME_OWNED_STAGES) {
    await t.test(`${stage} stage with no coordinator`, async () => {
      const runtime = await bootWithWorkflowRegistry({
        label: `governance-owned-${stage}`,
        team: { coordinator: COORDINATOR, stage, omitStageCoordinator: true },
      })
      try {
        // No coordinator means no persona grant, so every governed Pi builtin
        // registers; spawn_teams plus a workflow registry adds all three
        // delegation tools.
        const expected = [
          ...STAGE_TOOLS[stage],
          'spawn_team',
          'spawn_workflow',
          'inspect-task-state',
          ...EVERY_LEVEL_TOOLS,
          ...PI_BUILTINS,
        ]
        assert.deepEqual(registeredNames(runtime), expected)
        const registrations = toolsRegisteredEvents(runtime)
        assert.equal(registrations.length, 1)
        assert.deepEqual(registrations[0]?.registered_tools, expected)
        assert.equal(registrations[0]?.coordinator, null)

        await assertHookLetsThrough(runtime, stage)

        for (const toolName of expected) {
          const record = await executeRefused(
            runtime,
            toolName,
            `${stage}-run-${toolName}`,
            'runtime_owned_tool_denied',
          )
          assert.equal(record.level_id, 'intake')
        }

        // Flushes the evidence writer before its log is read.
        await runtime.shutdown()
        const evidence = runtime.readAssignmentJsonl(ASSIGNMENT_LOG.capabilityDispatchEvents)
        const rejectedCapabilities = new Set(
          evidence
            .filter((event) => event.type === 'capability.dispatch.rejected')
            .map((event) => event.capabilityId),
        )
        assert.equal(
          rejectedCapabilities.size,
          expected.length,
          'every refused call reached the dispatcher under its own capability; ' +
            `rejected capabilities: ${JSON.stringify([...rejectedCapabilities])}`,
        )
        assert.ok(
          rejectedCapabilities.has(SKILL_LOADER_CAPABILITY_ID),
          'the skill loader dispatches under capability skill.load',
        )
        assert.deepEqual(
          skillLoaderEvidenceTypes(evidence),
          ['capability.dispatch.rejected', 'capability.dispatch.requested'],
        )
      } finally {
        await runtime.close()
      }
    })
  }
})

test('a coordinated stage registers its own stage tools and the every-level tools, and refuses the coordinator the tools its level does not grant', {
  timeout: 60_000,
}, async (t) => {
  for (const stage of ALL_STAGES) {
    await t.test(`${stage} stage with a coordinator`, async () => {
      const runtime = await bootFixtureRuntime({
        label: `governance-coordinated-${stage}`,
        team: { coordinator: COORDINATOR, stage },
      })
      try {
        const expected = [
          ...STAGE_TOOLS[stage],
          'spawn_team',
          'inspect-task-state',
          ...EVERY_LEVEL_TOOLS,
        ]
        assert.deepEqual(registeredNames(runtime), expected)
        const registrations = toolsRegisteredEvents(runtime)
        assert.equal(registrations.length, 1)
        assert.deepEqual(registrations[0]?.registered_tools, expected)
        assert.equal(registrations[0]?.coordinator, COORDINATOR.name)
        // The level grants its stage tools, the delegation pair and the skill
        // loader; the rest of the every-level tools are outside it.
        assert.deepEqual(
          new Set(listField(registrations[0], 'allowed_level_tools')),
          new Set([...STAGE_TOOLS[stage], 'spawn_team', 'inspect-task-state', SKILL_LOADER]),
        )

        await assertHookLetsThrough(runtime, stage)

        for (const toolName of EVERY_LEVEL_TOOLS.filter((name) => name !== SKILL_LOADER)) {
          const record = await executeRefused(
            runtime,
            toolName,
            `${stage}-run-${toolName}`,
            'tool_not_allowed_for_agent',
          )
          assert.equal(record.agent_name, COORDINATOR.name)
        }
      } finally {
        await runtime.close()
      }
    })
  }
})

test('each discussion tool and the skill loader are refused on a second use in the same coordinator turn', {
  timeout: 60_000,
}, async () => {
  // A coordinator is granted its level's tools, so the refusal a discussion
  // coordinator can meet is the one-use-per-turn rule. Each first call is
  // admitted and then fails inside the tool (no roster is locked, the agent has
  // no skill catalog), so nothing is dispatched to an agent.
  const runtime = await bootFixtureRuntime({
    label: 'governance-discussion-reuse',
    team: { coordinator: COORDINATOR, stage: 'discussion', spawnTeams: false },
  })
  try {
    assert.deepEqual(registeredNames(runtime), [
      'set_roster',
      'create_brief',
      'converse',
      ...EVERY_LEVEL_TOOLS,
    ])

    const firstCalls: Array<[string, unknown]> = [
      ['set_roster', { agents: ['not-a-participant'] }],
      ['create_brief', CALL_ARGUMENTS.create_brief],
      ['converse', {}],
    ]
    for (const [toolName, params] of firstCalls) {
      const toolCallId = `discussion-first-${toolName}`
      await assert.rejects(
        runtime.host.invokeTool(toolName, toolCallId, params),
        (error: unknown) => {
          assert.equal(errorCode(error), undefined, `the first ${toolName} fails inside the tool, not in the policy`)
          return true
        },
      )
      assert.deepEqual(toolUseFor(runtime, toolCallId), [], `the policy admitted the first ${toolName}`)
    }
    await runtime.host.invokeTool(SKILL_LOADER, 'discussion-first-skill', CALL_ARGUMENTS[SKILL_LOADER])
    assert.deepEqual(toolUseFor(runtime, 'discussion-first-skill'), [])

    for (const toolName of ['set_roster', 'create_brief', 'converse', SKILL_LOADER]) {
      const record = await executeRefused(
        runtime,
        toolName,
        `discussion-second-${toolName}`,
        'duplicate_level_tool',
      )
      assert.equal(record.agent_name, COORDINATOR.name)
    }

    await runtime.shutdown()
    assert.deepEqual(
      skillLoaderEvidenceTypes(
        runtime.readAssignmentJsonl(ASSIGNMENT_LOG.capabilityDispatchEvents),
      ),
      [
        'capability.dispatch.rejected',
        'capability.dispatch.rejected',
        'capability.dispatch.requested',
        'capability.dispatch.requested',
      ],
      'both skill loader calls went through the dispatcher',
    )
  } finally {
    await runtime.close()
  }
})

test('spawn_team and inspect-task-state register only under spawn_teams, and spawn_workflow also needs a workflow registry', {
  timeout: 60_000,
}, async (t) => {
  await t.test('spawn_teams with a workflow registry registers and grants all three', async () => {
    const runtime = await bootWithWorkflowRegistry({
      label: 'governance-spawn-workflows',
      team: { coordinator: COORDINATOR },
    })
    try {
      const expected = ['spawn_team', 'spawn_workflow', 'inspect-task-state', ...EVERY_LEVEL_TOOLS]
      assert.deepEqual(registeredNames(runtime), expected)
      assert.deepEqual(
        new Set(listField(toolsRegisteredEvents(runtime)[0], 'allowed_level_tools')),
        new Set(['spawn_team', 'spawn_workflow', 'inspect-task-state', SKILL_LOADER]),
      )
      await assertHookLetsThrough(runtime, 'spawn-workflows')
    } finally {
      await runtime.close()
    }
  })

  await t.test('without spawn_teams none of the three registers, even with a workflow registry', async () => {
    const runtime = await bootWithWorkflowRegistry({
      label: 'governance-no-spawn',
      team: { coordinator: COORDINATOR, spawnTeams: false },
    })
    try {
      assert.deepEqual(registeredNames(runtime), EVERY_LEVEL_TOOLS)
      assert.deepEqual(toolsRegisteredEvents(runtime)[0]?.allowed_level_tools, [SKILL_LOADER])
      for (const toolName of ['spawn_team', 'spawn_workflow', 'inspect-task-state']) {
        assert.deepEqual(
          await runtime.host.callToolCall({ toolName, toolCallId: `no-spawn-${toolName}` }),
          {
            block: true,
            terminate: true,
            reason: `Tool '${toolName}' has no Team Runtime capability registration.`,
          },
          `the hook refuses ${toolName} when the level did not register it`,
        )
      }
    } finally {
      await runtime.close()
    }
  })
})
