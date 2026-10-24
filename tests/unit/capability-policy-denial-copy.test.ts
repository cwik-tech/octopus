/**
 * The sentences a refused tool call is explained by.
 *
 * Two halves, and the second is the one that matters. The first drives every
 * refusal gate the runtime has — the capability policy, the bypass detector and
 * the governed Pi tools' safety gate — and checks that each code it can emit is
 * one this build declares copy for, so a new refusal cannot reach a reader as a
 * bare identifier. The second pins the literal text of every sentence.
 *
 * "Every gate" has to mean every gate. This file once drove one of the three and
 * still claimed the whole set, which is how a destructive-command refusal came to
 * be shown as "failed using tool bash": the gate that emitted it was outside the
 * test's reach, so the promise cost nothing to keep. A gate added later is
 * covered by the same rule the three keep — its denial type is narrowed to the
 * contract's own list (`contracts/capability-policy-denial.ts`), so a code
 * without a sentence is a type error — but it also belongs in `emitEveryRefusal`
 * below.
 *
 * The literal pinning is not belt-and-braces. Shape checks — no underscore, a
 * trailing period, over forty characters — pass for any well-formed sentence,
 * including a wrong one, which is how "Nothing to change here." survived on a
 * refusal that had exactly one thing to change. A test that asserts the copy
 * against the copy asserts nothing at all. These strings are duplicated on
 * purpose: changing one is then a deliberate act with a visible diff.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'

import type {
  CapabilityExecutionContext,
  CapabilityInvocationIdentity,
} from '../../contracts/capability-dispatch.js'
import {
  serialCapabilityEffect,
  type CapabilityEffect,
} from '../../contracts/capability-effect.js'
import {
  CAPABILITY_DENIAL_USER_MESSAGES,
  TOOL_REFUSAL_CODES,
  capabilityDenialUserMessage,
  isToolRefusalCode,
  type ToolRefusalCode,
} from '../../contracts/capability-policy-denial.js'
import { TeamRuntimeCapabilityBypassDetector } from '../../team-runtime/capability-bypass-detector.js'
import type { TeamRuntimeToolArguments } from '../../team-runtime/capability-tool-adapter.js'
import {
  TeamRuntimeCapabilityPolicy,
  type TeamRuntimePolicyCoordinator,
  type TeamRuntimeToolPolicySnapshot,
} from '../../team-runtime/capability-tool-policy.js'
import {
  createPipelinePiToolAdapterFactory,
  createPipelinePiToolDefinitions,
  type PipelineGovernedPiToolName,
} from '../../team-runtime/governed-pi-tools.js'

const CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-denial-copy-1',
  sessionId: 'session-denial-copy-1',
  runId: 'run-denial-copy-1',
  assignmentId: 'assignment-denial-copy-1',
  taskId: 'task-denial-copy-1',
  agentPath: 'agents/coordinator',
  authority: {
    kind: 'runtime-assignment',
    processIdentity: 'process-denial-copy-1',
  },
}

/**
 * The exact sentence each refusal is shown to a reader as.
 *
 * Written out here rather than read from the contract, so that editing a
 * sentence fails this test until the edit is made in both places.
 */
const PINNED_REFUSAL_COPY: Readonly<Record<ToolRefusalCode, string>> = {
  unknown_team_runtime_capability:
    'This tool is not set up in the stage the run is on now, so the call was turned down. Check which stage offers the tool, or leave the step to that stage.',
  runtime_owned_tool_denied:
    'No agent is in charge of this stage, so the run handles it alone and accepts no tool calls. Nothing to change here.',
  post_advance_tool_denied:
    'The run had already moved to the next stage, so the request arrived too late. The work carries on in the new stage.',
  tool_not_allowed_in_level:
    'The agent asked for something this stage does not offer. Add the tool to this stage, or move the step to the stage that already has it.',
  tool_not_allowed_for_agent:
    'This agent is not set up to use that tool. Grant it to the agent, or leave the step to the teammate who already has it.',
  duplicate_level_tool:
    'The agent reached for the same stage tool twice in one turn. The first use counted and the repeat was dropped.',
  ungoverned_tool_call:
    'The agent asked for a tool this run does not offer at all, so nothing ran. Add it to the team and the stage, or drop it from the agent instructions.',
  shadowed_tool_registration:
    'Another part of the app is holding this tool name, so the run refused the call rather than hand it to a tool it does not control. No team setting causes this one.',
  unsafe_bash_command:
    'The command the agent asked to run could delete files, take administrator rights or run something downloaded from the web, so the run stopped it. This is the runtime keeping your machine safe, not a setting to change.',
  tool_path_outside_workspace:
    'The agent reached for a file outside the folder this run owns, so nothing was read or written. This is the runtime keeping the run inside its own folder, not a setting to change.',
}

/** The sentence a build shows for a code it has never heard of. */
const PINNED_UNRECOGNISED_COPY =
  'The run turned down a tool the agent asked for. Check the tool settings for this team.'

interface EmittedRefusal {
  readonly code: string
  readonly reason: string
}

/**
 * Every refusal the Team Runtime can actually produce, each driven through the
 * real gate rather than asserted from a hand-written list, so a code that gains
 * a new emitter without copy fails here instead of reaching a reader.
 *
 * Three gates, because the runtime has three. Enumerating only the capability
 * policy is what let the governed Pi tools refuse a destructive command with a
 * code no build had a sentence for: the test promised "every refusal" while
 * reaching one file, and the refusal it could not see fell through the timeline's
 * failure arm as "failed using tool bash".
 */
async function emitEveryRefusal(): Promise<readonly EmittedRefusal[]> {
  return [
    ...await emitEveryPolicyDenial(),
    ...emitEveryBypassRefusal(),
    ...await emitEveryGovernedPiToolRefusal(),
  ]
}

async function emitEveryPolicyDenial(): Promise<readonly EmittedRefusal[]> {
  const denials: EmittedRefusal[] = []
  const record = async (
    evaluate: () => Promise<
      Awaited<ReturnType<TeamRuntimeCapabilityPolicy['evaluate']>>
    >,
  ): Promise<void> => {
    const decision = await evaluate()
    assert.equal(decision.kind, 'deny')
    if (decision.kind === 'deny') {
      denials.push({ code: decision.code, reason: decision.reason })
    }
  }

  const unregistered = makePolicy()
  await record(() =>
    unregistered.evaluate(makeEvaluation('call-unknown', {
      capabilityId: 'team-runtime.engine.never-registered',
    })))

  const runtimeOwned = makePolicy({ coordinator: null })
  await record(() => runtimeOwned.evaluate(makeEvaluation('call-runtime-owned')))

  const advanced = makePolicy({
    coordinatorRunId: 7,
    levelAdvancedCoordinatorRunId: 7,
  })
  await record(() => advanced.evaluate(makeEvaluation('call-advanced')))

  const wrongLevel = makePolicy({ levelAllowedTools: new Set(['handoff']) })
  await record(() => wrongLevel.evaluate(makeEvaluation('call-wrong-level')))

  const wrongAgent = makePolicy({
    coordinator: { name: 'coordinator', allowedTools: ['handoff'] },
  })
  await record(() => wrongAgent.evaluate(makeEvaluation('call-wrong-agent')))

  const duplicate = makePolicy()
  await duplicate.evaluate(makeEvaluation('call-first'))
  await record(() => duplicate.evaluate(makeEvaluation('call-duplicate')))

  return denials
}

/**
 * The refusals that never reach the policy at all.
 *
 * The bypass detector runs on Pi's `tool_call`, before dispatch, and blocks a
 * call whose tool is not the governed registration this runtime made. Its
 * refusals are written to the same log, read by the same timeline arm and owed
 * the same sentence.
 */
function emitEveryBypassRefusal(): readonly EmittedRefusal[] {
  const refusals: EmittedRefusal[] = []
  const record = (refusal: ReturnType<
    TeamRuntimeCapabilityBypassDetector['observe']
  >): void => {
    assert.ok(refusal, 'the detector must refuse this call')
    refusals.push({ code: refusal.code, reason: refusal.result.reason ?? '' })
  }

  const ungoverned = new TeamRuntimeCapabilityBypassDetector()
  ungoverned.replaceGovernedTools(['dispatch'])
  record(ungoverned.observe({
    toolName: 'extension_bypass',
    toolCallId: 'bypass-ungoverned',
  }))

  const shadowed = new TeamRuntimeCapabilityBypassDetector({
    isGovernedRegistrationActive: () => false,
  })
  shadowed.replaceGovernedTools(['read'])
  record(shadowed.observe({ toolName: 'read', toolCallId: 'bypass-shadowed' }))

  return refusals
}

/**
 * The refusals the governed Pi tools return on safety grounds.
 *
 * The third gate, and the one nothing here used to reach. It lives in the tool
 * adapter rather than in the policy, and its denial is the one the dispatcher
 * resolves (`core/capability-policy.ts:25` takes the first deny of
 * `[adapter, prepared, policy]`), so the capability policy can allow the same
 * call and its `onDenied` never fire. Driven through the real adapter factory
 * so a code it emits without copy fails here.
 */
async function emitEveryGovernedPiToolRefusal(): Promise<
  readonly EmittedRefusal[]
> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-refusal-copy-'))
  try {
    const tools = createPipelinePiToolDefinitions(cwd)
    return [
      await refuseGovernedPiTool({
        tool: tools.bash,
        name: 'bash',
        cwd,
        effect: serialCapabilityEffect('unknown'),
        arguments: { command: "sudo rm -rf '../outside'" },
      }),
      await refuseGovernedPiTool({
        tool: tools.write,
        name: 'write',
        cwd,
        effect: serialCapabilityEffect('mutating'),
        arguments: { path: '../escaped.txt', content: 'must not be written' },
      }),
    ]
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/**
 * One refused call through the real adapter, on arguments Pi's own schema
 * admits — the dispatcher validates against that schema before it prepares
 * (`team-runtime/capability-tool-adapter.ts:187`), so a refusal driven with
 * arguments the schema rejects would be proving the wrong gate.
 */
async function refuseGovernedPiTool<
  TParams extends TSchema,
  TDetails,
  TState,
>(input: {
  readonly tool: ToolDefinition<TParams, TDetails, TState>
  readonly name: PipelineGovernedPiToolName
  readonly cwd: string
  readonly effect: CapabilityEffect
  readonly arguments: TeamRuntimeToolArguments<TParams>
}): Promise<EmittedRefusal> {
  assert.ok(
    Value.Check(input.tool.parameters, input.arguments),
    `the ${input.name} call must be one Pi's schema admits`,
  )
  const factory = createPipelinePiToolAdapterFactory<TParams, TDetails>({
    name: input.name,
    cwd: input.cwd,
    effect: input.effect,
  })
  const prepared = await factory.createPreparedExecution({
    arguments: input.arguments,
    context: CONTEXT,
    invocation: {
      capabilityId: factory.capabilityId,
      source: { kind: 'pi-host', id: 'team-runtime:pi-model', version: '1' },
      toolCallId: `pi-tool-refusal-${input.name}`,
    },
    signal: new AbortController().signal,
    argumentNames: Object.keys(input.arguments).sort(),
    executeRaw: async () => {
      throw new Error('a refused Pi tool call must never reach execution')
    },
  })

  const decision = prepared.policyDecision
  assert.equal(decision.kind, 'deny', `the ${input.name} call must be refused`)
  assert.ok(decision.kind === 'deny')
  return { code: decision.code, reason: decision.reason }
}

test('every refusal the Team Runtime can emit has a sentence for the reader', async () => {
  const refusals = await emitEveryRefusal()

  const emittedCodes = [...new Set(refusals.map((refusal) => refusal.code))].sort()
  assert.deepEqual(emittedCodes, [...TOOL_REFUSAL_CODES].sort())
  for (const refusal of refusals) {
    assert.ok(
      isToolRefusalCode(refusal.code),
      `no copy is declared for refusal code ${refusal.code}`,
    )
  }
})

test('every refusal reads as the exact sentence this build promises', async () => {
  const refusals = await emitEveryRefusal()

  // Pinned against the emitted codes, not against the declared list, so the
  // sentence a reader is actually shown for a live refusal is the one checked.
  for (const refusal of refusals) {
    assert.ok(isToolRefusalCode(refusal.code))
    assert.equal(
      capabilityDenialUserMessage(refusal.code),
      PINNED_REFUSAL_COPY[refusal.code],
      `the sentence for ${refusal.code} changed; update the pin deliberately`,
    )
  }
  // And the other direction, so a code can neither lose its pin nor gain a
  // sentence no gate emits.
  assert.deepEqual(
    Object.keys(CAPABILITY_DENIAL_USER_MESSAGES).sort(),
    Object.keys(PINNED_REFUSAL_COPY).sort(),
  )
})

test('refusal copy is prose a non-coder can act on, never the code or the runtime prose', async () => {
  const refusals = await emitEveryRefusal()

  for (const refusal of refusals) {
    const message = capabilityDenialUserMessage(refusal.code)
    assert.notEqual(
      message,
      refusal.code,
      `refusal code ${refusal.code} is shown to the reader unchanged`,
    )
    assert.ok(
      !message.includes(refusal.code),
      `copy for ${refusal.code} still carries the raw code`,
    )
    assert.ok(
      !message.includes('_'),
      `copy for ${refusal.code} still carries an identifier: ${message}`,
    )
    assert.ok(
      !message.includes(refusal.reason),
      `copy for ${refusal.code} still carries the runtime's own prose`,
    )
    assert.equal(
      message,
      message.trim(),
      `copy for ${refusal.code} is not trimmed`,
    )
    assert.ok(
      message.endsWith('.'),
      `copy for ${refusal.code} is not a finished sentence: ${message}`,
    )
    assert.ok(
      message.length > 40,
      `copy for ${refusal.code} is too terse to act on: ${message}`,
    )
  }
})

test('an unrecognised refusal code still reads as a sentence rather than an identifier', () => {
  const message = capabilityDenialUserMessage('some_future_policy_code')

  assert.equal(message, PINNED_UNRECOGNISED_COPY)
  assert.ok(!message.includes('some_future_policy_code'))
  assert.ok(!message.includes('_'))
  assert.ok(message.endsWith('.'))
  assert.ok(!Object.values(CAPABILITY_DENIAL_USER_MESSAGES).includes(message))
})

function makePolicy(
  overrides: Partial<Omit<TeamRuntimeToolPolicySnapshot, 'coordinator'>> & {
    coordinator?: TeamRuntimePolicyCoordinator | null
  } = {},
): TeamRuntimeCapabilityPolicy {
  const {
    coordinator = { name: 'coordinator', allowedTools: ['dispatch'] },
    ...rest
  } = overrides
  const snapshot: TeamRuntimeToolPolicySnapshot = {
    levelId: 'level-1',
    coordinatorRunId: 1,
    levelAdvancedCoordinatorRunId: null,
    levelAllowedTools: new Set(['dispatch']),
    engineTools: new Set(['dispatch']),
    usedLevelToolsThisCoordinatorTurn: new Set(),
    ...rest,
    ...(coordinator ? { coordinator } : {}),
  }
  const policy = new TeamRuntimeCapabilityPolicy({
    getSnapshot: () => snapshot,
    trustedRuntimeSource: {
      kind: 'engine',
      id: 'team-runtime:runtime-autostart',
      version: '1',
    },
  })
  policy.register({
    capabilityId: 'team-runtime.engine.dispatch',
    toolName: 'dispatch',
  })
  return policy
}

function makeEvaluation(
  toolCallId: string,
  overrides: { readonly capabilityId?: string } = {},
): Parameters<TeamRuntimeCapabilityPolicy['evaluate']>[0] {
  const source: CapabilityInvocationIdentity['source'] = {
    kind: 'engine',
    id: 'team-runtime:pi-model',
    version: '1',
  }
  return {
    context: CONTEXT,
    invocation: {
      capabilityId: overrides.capabilityId ?? 'team-runtime.engine.dispatch',
      source,
      toolCallId,
    },
    effect: { kind: 'mutating', concurrency: 'serial' },
    risk: 'mutating',
  }
}
