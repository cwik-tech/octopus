/**
 * What arming a level's tools leaves behind, observed from the runtime's
 * entrypoint.
 *
 * Each case boots the real `team-runtime/index.ts` on a fixture Team through
 * `bootFixtureRuntime`: lm-studio personas, no delegated autostart, a routing
 * entry level. No stage autostart runs and no agent or provider is called,
 * which every case checks at the end.
 *
 * The fixture host stands in for Pi. Where a case needs Pi's tool registry, it
 * replaces the host's `registerTool`, `getActiveTools` and `setActiveTools`
 * with Pi's rule: the built-in names start in the registry and inactive, a
 * registered tool joins the active set only when its name is new to the
 * registry, and `setActiveTools` replaces the active set.
 *
 * A later level is armed the way a run with no turn in flight arms it: the
 * entry level's gate artifact is written and Pi reports a tool execution end.
 * That handler advances the gate, prepares the destination, and catches
 * whatever the advance throws.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test, { before } from 'node:test'

import { PI_BUILTIN_TOOL_NAMES } from '../../core/pi-runtime.js'
import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  type FixtureHost,
  type FixtureRuntime,
  type FixtureRuntimeOptions,
  type RegisteredTool,
} from '../support/team-runtime-fixture-boot.js'

const DEADLINE_MS = 20_000
const SKILL_LOADER = 'mcp__pipeline_skills__load_skill'
/** Registered for every level, in registration order, before the skill loader. */
const EVERY_LEVEL_TOOLS = ['browser', 'research_web', 'youtube_extract', 'generate_word', 'generate_excel']
const AGENT_LOG_FILES = ['agent-runs.jsonl', 'provider-events.jsonl']
const REGISTRATION_FAILURE = 'the fixture host refused this registration'

/**
 * A routing entry level whose coordinator is granted `write`, gated into a
 * pipeline level whose coordinator is granted `read`. Neither level has
 * `spawn_teams`, so no delegation tool registers.
 */
const TWO_LEVEL_TEAM: NonNullable<FixtureRuntimeOptions['team']> = {
  coordinator: { name: 'intake-agent', tools: ['write'] },
  spawnTeams: false,
  laterLevels: [
    { id: 'review', stage: 'pipeline', coordinator: { name: 'review-lead', tools: ['read'] } },
  ],
}
const INTAKE_TOOLS = [...EVERY_LEVEL_TOOLS, SKILL_LOADER, 'write']
const REVIEW_TOOLS = ['dispatch', ...EVERY_LEVEL_TOOLS, SKILL_LOADER, 'read']

// Loading the runtime module takes about a second, once per process.
before(async () => {
  await within(import('../../team-runtime/index.js'), 'loading the runtime module')
})

type Defer = (cleanup: () => unknown) => void

/**
 * Runs `body`, then every cleanup it registered, last first. Every cleanup
 * runs; the first error, from `body` or a cleanup, is rethrown.
 */
async function withCleanup(body: (defer: Defer) => Promise<void>): Promise<void> {
  const cleanups: Array<() => unknown> = []
  let failure: { readonly error: unknown } | undefined
  try {
    await body((cleanup) => {
      cleanups.push(cleanup)
    })
  } catch (error) {
    failure = { error }
  }
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}

/** `promise`, or a rejection naming `what` once the deadline passes. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error(`${what} did not finish within ${DEADLINE_MS} ms`)),
      DEADLINE_MS,
    )
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(deadline)
  }
}

interface PiToolRegistry {
  /** The tools the host could call now, in the order they became active. */
  activeTools(): string[]
  /** Make the next registration of `toolName` throw, once. */
  failRegistrationOf(toolName: string): void
}

/** Give the fixture host Pi's tool registry rules. Call before `session_start`. */
function emulatePiToolRegistry(host: FixtureHost): PiToolRegistry {
  const known = new Set<string>(PI_BUILTIN_TOOL_NAMES)
  const active = new Set<string>()
  let failingToolName: string | undefined
  const pi = host.pi
  assert.ok(typeof pi === 'object' && pi !== null, 'the fixture host has a pi object')
  Object.assign(pi, {
    registerTool: (tool: RegisteredTool) => {
      if (tool.name === failingToolName) {
        failingToolName = undefined
        throw new Error(REGISTRATION_FAILURE)
      }
      host.registered.push(tool)
      if (!known.has(tool.name)) active.add(tool.name)
      known.add(tool.name)
    },
    getActiveTools: () => [...active],
    setActiveTools: (toolNames: string[]) => {
      active.clear()
      for (const name of toolNames) {
        if (known.has(name)) active.add(name)
      }
    },
  })
  return {
    activeTools: () => [...active],
    failRegistrationOf: (toolName) => {
      failingToolName = toolName
    },
  }
}

async function bootTwoLevelTeam(
  defer: Defer,
  label: string,
): Promise<{ runtime: FixtureRuntime; registry: PiToolRegistry }> {
  const runtime = await within(
    bootFixtureRuntime({ label, team: TWO_LEVEL_TEAM, startSession: false }),
    `booting ${label}`,
  )
  defer(() => runtime.close())
  const registry = emulatePiToolRegistry(runtime.host)
  await within(runtime.startSession(), 'session_start')
  return { runtime, registry }
}

/** Satisfy the entry level's gate with no turn in flight. */
async function advanceIntakeGate(runtime: FixtureRuntime): Promise<void> {
  fs.writeFileSync(path.join(runtime.assignmentPath, 'routing-decision.md'), 'Route to review.\n')
  await within(
    runtime.host.callHandler('tool_execution_end', {
      type: 'tool_execution_end',
      toolName: 'write',
      toolCallId: 'intake-gate-write',
      isError: false,
    }),
    'the tool_execution_end that satisfies the intake gate',
  )
  assert.ok(
    runtime.host.notifications.some((notice) => notice.message.includes('Level advanced')),
    `precondition: the intake gate advanced; notices: ${JSON.stringify(runtime.host.notifications)}`,
  )
}

function runtimeEvents(runtime: FixtureRuntime, event: string): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
    .filter((record) => record.event === event)
}

function toolUseFor(runtime: FixtureRuntime, toolCallId: string): Array<Record<string, unknown>> {
  return runtime
    .readAssignmentJsonl(ASSIGNMENT_LOG.toolUse)
    .filter((record) => record.tool_call_id === toolCallId)
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function assertNoAgentRan(runtime: FixtureRuntime): void {
  for (const logFile of AGENT_LOG_FILES) {
    assert.deepEqual(runtime.readAssignmentJsonl(logFile), [], `no agent or provider ran (${logFile})`)
  }
}

test("arming a later level replaces the host's active tools and the governed tool list with that level's own", {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, registry } = await bootTwoLevelTeam(defer, 'arming-replaces')
    assert.deepEqual(registry.activeTools(), INTAKE_TOOLS, 'precondition: the entry level activated its own tools')

    await advanceIntakeGate(runtime)

    assert.deepEqual(
      registry.activeTools(),
      REVIEW_TOOLS,
      "the host can call exactly the review level's tools; intake's write is no longer active",
    )
    assert.deepEqual(
      runtimeEvents(runtime, 'tools.registered').map((record) => [
        record.level_id,
        record.coordinator,
        record.registered_tools,
      ]),
      [
        ['intake', 'intake-agent', INTAKE_TOOLS],
        ['review', 'review-lead', REVIEW_TOOLS],
      ],
    )

    // The bypass detector now governs the review level's names and no others.
    assert.deepEqual(
      await within(
        runtime.host.callToolCall({ toolName: 'write', toolCallId: 'after-arming-write' }),
        'the tool_call hook for write',
      ),
      {
        block: true,
        terminate: true,
        reason: "Tool 'write' has no Team Runtime capability registration.",
      },
      "a tool only the previous level registered is refused as ungoverned",
    )
    for (const toolName of ['dispatch', 'read']) {
      assert.equal(
        await within(
          runtime.host.callToolCall({ toolName, toolCallId: `after-arming-${toolName}` }),
          `the tool_call hook for ${toolName}`,
        ),
        undefined,
        `the review level's ${toolName} passes the tool_call hook`,
      )
    }
    assertNoAgentRan(runtime)
  })
})

test("a registration that throws part way through arming leaves the tools registered before it as the runtime's current tools", {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const { runtime, registry } = await bootTwoLevelTeam(defer, 'arming-partial')
    registry.failRegistrationOf(SKILL_LOADER)

    // The advance arms the review level, the skill loader's registration
    // throws, and the tool_execution_end handler catches it and returns.
    await advanceIntakeGate(runtime)

    const armedBeforeThrow = ['dispatch', ...EVERY_LEVEL_TOOLS]
    assert.deepEqual(
      runtime.host.registered.map((tool) => tool.name),
      [...INTAKE_TOOLS, ...armedBeforeThrow],
      'precondition: the review level registered its stage tool and the every-level tools, then the skill loader threw',
    )
    assert.deepEqual(
      runtimeEvents(runtime, 'tools.registered').map((record) => record.level_id),
      ['intake'],
      'precondition: the review arming did not finish',
    )

    const toolCallId = 'after-partial-arming'
    await within(
      runtime.host.callHandler('tool_execution_start', {
        type: 'tool_execution_start',
        toolName: 'dispatch',
        toolCallId,
        args: {},
      }),
      'tool_execution_start after the partial arming',
    )
    const started = runtimeEvents(runtime, 'tool.execution_start').filter(
      (record) => record.tool_call_id === toolCallId,
    )
    assert.equal(started.length, 1, `one tool.execution_start record; got ${JSON.stringify(started)}`)
    assert.deepEqual(
      started[0]?.registered_tools,
      armedBeforeThrow,
      "the runtime's current tools are the review tools that registered before the throw, not intake's",
    )
    assertNoAgentRan(runtime)
  })
})

test("a governed tool's own error message reaches the tool-use record its execution end writes", {
  timeout: 60_000,
}, async () => {
  await withCleanup(async (defer) => {
    const runtime = await within(
      bootFixtureRuntime({
        label: 'arming-raw-error',
        team: {
          coordinator: { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] },
          stage: 'discussion',
          spawnTeams: false,
        },
      }),
      'booting arming-raw-error',
    )
    defer(() => runtime.close())

    // The policy admits the first set_roster of the turn; the tool itself then
    // rejects an agent that is not a participant.
    const toolCallId = 'set-roster-raw-error'
    const failure = await within(
      runtime.host.invokeTool('set_roster', toolCallId, { agents: ['not-a-participant'] }).then(
        () => undefined,
        (error: unknown) => error,
      ),
      'the failing set_roster call',
    )
    assert.ok(failure instanceof Error, `set_roster must fail; got ${String(failure)}`)
    assert.equal(errorCode(failure), undefined, 'precondition: the tool failed, not the capability policy')
    assert.ok(failure.message.length > 0, 'precondition: the tool failed with a message')
    assert.deepEqual(toolUseFor(runtime, toolCallId), [], 'precondition: the call itself wrote no tool-use record')

    await within(
      runtime.host.callHandler('tool_execution_end', {
        type: 'tool_execution_end',
        toolName: 'set_roster',
        toolCallId,
        result: { content: [], details: undefined },
        isError: true,
      }),
      'the tool_execution_end for the failed set_roster',
    )

    const records = toolUseFor(runtime, toolCallId)
    assert.equal(records.length, 1, `one tool-use record; got ${JSON.stringify(records)}`)
    assert.equal(records[0]?.is_error, true)
    assert.equal(records[0]?.error, failure.message, "the record carries the tool's own message")
    assertNoAgentRan(runtime)
  })
})
