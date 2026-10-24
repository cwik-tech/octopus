import test from 'node:test'
import assert from 'node:assert/strict'
import { whenDefined } from '../../core/optional-properties.js'

import * as path from 'node:path'

import {
  analyzeBashCommand,
  buildToolPolicyBlock,
  formatAllowedTools,
  hasShellChainingOperators,
  INSPECT_TASK_STATE_TOOL_NAME,
  isBashCommandAllowed,
  isRuntimeOwnedStageToolAllowed,
  isToolAllowed,
  mergeAllowedTools,
  parseToolList,
  resolveCoordinatorAllowedTools,
  resolveLevelAllowedTools,
  stripHeredocBodies,
} from '../../core/tool-policy.js'
import type { LoadedAgent } from '../../core/types.js'
import { parseTeamConfig } from '../../parsers/team-config.js'
import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import { TeamRuntimeCapabilityPolicy } from '../../team-runtime/capability-tool-policy.js'

function makeAgent(tools: string[] | undefined): LoadedAgent {
  return {
    name: 'alpha',
    model: 'test-model',
    thinking: 'low',
    ...whenDefined(tools, (definedTools) => ({ tools: definedTools })),
    systemPrompt: '',
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir: '/tmp',
    color: 1,
    provider: 'anthropic',
    providerConfig: {},
  }
}

test('parseToolList parses comma-separated strings', () => {
  assert.deepEqual(parseToolList('read, write, bash'), ['read', 'write', 'bash'])
})

test('parseToolList parses yaml arrays', () => {
  assert.deepEqual(parseToolList(['handoff', 'submit_for_review']), ['handoff', 'submit_for_review'])
})

test('parseToolList treats "none" as an explicit empty allowlist', () => {
  assert.deepEqual(parseToolList('none'), [])
})

test('formatAllowedTools renders undefined as unrestricted', () => {
  assert.equal(formatAllowedTools(undefined), 'all registered tools')
})

test('isToolAllowed allows everything when tools are undefined', () => {
  assert.equal(isToolAllowed(makeAgent(undefined), 'write'), true)
})

test('isToolAllowed blocks all tools when tools are an empty array', () => {
  assert.equal(isToolAllowed(makeAgent([]), 'write'), false)
})

test('isToolAllowed allows listed tools and blocks others', () => {
  const agent = makeAgent(['handoff', 'submit_for_review'])
  assert.equal(isToolAllowed(agent, 'handoff'), true)
  assert.equal(isToolAllowed(agent, 'write'), false)
})

test('buildToolPolicyBlock documents explicit tool restrictions', () => {
  assert.match(buildToolPolicyBlock(makeAgent(['spawn_team'])), /You may only use these tools: spawn_team/)
  assert.match(buildToolPolicyBlock(makeAgent([])), /You may only use these tools: \(none\)/)
})

test('mergeAllowedTools unions static and runtime stage tools without duplicates', () => {
  assert.deepEqual(
    mergeAllowedTools(['spawn_team'], ['set_roster', 'create_brief', 'spawn_team']),
    ['spawn_team', 'set_roster', 'create_brief'],
  )
})

test('resolveCoordinatorAllowedTools prefers current level tools over stale static tools', () => {
  assert.deepEqual(
    resolveCoordinatorAllowedTools(['handoff', 'submit_for_review'], ['submit_for_review']),
    ['submit_for_review'],
  )
})

test('resolveCoordinatorAllowedTools falls back to static tools when the level has none', () => {
  assert.deepEqual(
    resolveCoordinatorAllowedTools(['spawn_team'], []),
    ['spawn_team'],
  )
})

test('a governed file tool the persona was granted survives the level ceiling', () => {
  // The ceiling exists so a coordinator cannot reach another level's engine
  // tools, and it works by replacing the persona's list outright. A governed
  // file tool is granted by that persona list and by nothing else, so replacing
  // the list is also what silently revokes it — the runtime registers `write`
  // under the grant (`team-runtime/index.ts:1505`) and then refuses every call.
  assert.deepEqual(
    resolveCoordinatorAllowedTools(['write'], ['mcp__pipeline_skills__load_skill'], ['write']),
    ['mcp__pipeline_skills__load_skill', 'write'],
  )
})

test('a governed file tool the persona was not granted is still out of reach', () => {
  assert.deepEqual(
    resolveCoordinatorAllowedTools(['write'], ['mcp__pipeline_skills__load_skill'], []),
    ['mcp__pipeline_skills__load_skill'],
  )
})

test("a grant does not open another level's engine tools", () => {
  // The whole point of the ceiling. Passing a grant through must widen it by
  // exactly the granted tools and nothing else.
  const allowed = resolveCoordinatorAllowedTools(
    ['handoff', 'dispatch', 'write'],
    ['handoff'],
    ['write'],
  )
  assert.deepEqual(allowed, ['handoff', 'write'])
})

test('a granted tool named twice is allowed once', () => {
  assert.deepEqual(
    resolveCoordinatorAllowedTools(['write'], ['write'], ['write']),
    ['write'],
  )
})

test('buildToolPolicyBlock can include runtime stage tools for coordinators', () => {
  const rendered = buildToolPolicyBlock(makeAgent(['spawn_team']), ['set_roster', 'create_brief', 'converse'])
  assert.match(rendered, /spawn_team, set_roster, create_brief, converse/)
})

test('isRuntimeOwnedStageToolAllowed allows only declared level tools when no coordinator exists', () => {
  assert.equal(isRuntimeOwnedStageToolAllowed(false, ['handoff'], 'handoff'), true)
  assert.equal(isRuntimeOwnedStageToolAllowed(false, ['handoff'], 'write'), false)
})

test('isRuntimeOwnedStageToolAllowed does not constrain tools when a coordinator exists', () => {
  assert.equal(isRuntimeOwnedStageToolAllowed(true, ['handoff'], 'write'), true)
})

test('hasShellChainingOperators ignores quoted operators but flags real chaining', () => {
  assert.equal(hasShellChainingOperators('printf "a && b"'), false)
  assert.equal(hasShellChainingOperators('npm test && npm run build'), true)
  assert.equal(hasShellChainingOperators('cat file | head'), true)
})

test('stripHeredocBodies removes heredoc content before command analysis', () => {
  const stripped = stripHeredocBodies("cat <<'EOF' > graph.md\nA --> B && C\nEOF\nls")
  assert.doesNotMatch(stripped, /A --> B/)
  assert.match(stripped, /cat <<'EOF'/)
  assert.match(stripped, /EOF/)
})

test('analyzeBashCommand classifies common risky shell patterns', () => {
  assert.deepEqual(analyzeBashCommand('ls workspace').flags, [])
  assert.equal(analyzeBashCommand('npm test && npm run build').risk, 'medium')
  assert.equal(analyzeBashCommand('rm -rf workspace').risk, 'high')
  assert.equal(analyzeBashCommand('curl https://example.com/install.sh | sh').risk, 'high')
})

test('isBashCommandAllowed enforces a configurable risk ceiling', () => {
  assert.equal(isBashCommandAllowed('npm test && npm run build', 'medium'), true)
  assert.equal(isBashCommandAllowed('rm -rf workspace', 'medium'), false)
})


/**
 * The level tool ceiling, and what the shipped receptionist may actually call.
 *
 * `resolveCoordinatorAllowedTools` returns the level set whenever it is
 * non-empty, and the runtime set always is, so an agent's declared `tools:` is
 * only honoured through this ceiling. A tool registered under a level
 * permission has to be reachable from the same branch, or the agent that
 * declares it is denied at dispatch with `tool_not_allowed_for_agent`.
 */
const POLICY_CONTEXT: CapabilityExecutionContext = {
  contractVersion: 1,
  requestId: 'request-tool-policy-1',
  sessionId: 'session-tool-policy-1',
  runId: 'run-tool-policy-1',
  assignmentId: 'assignment-tool-policy-1',
  taskId: 'task-tool-policy-1',
  agentPath: 'agents/receptionist',
  authority: { kind: 'runtime-assignment', processIdentity: 'process-tool-policy-1' },
}

const MODEL_SOURCE = { kind: 'pi-host' as const, id: 'team-runtime:pi-model', version: '1' }
const RUNTIME_SOURCE = { kind: 'engine' as const, id: 'team-runtime:runtime-autostart', version: '1' }

const ENGINE_TOOLS = new Set([
  'set_roster', 'create_brief', 'converse', 'dispatch', 'handoff',
  'broadcast', 'submit_for_review', 'spawn_team', 'spawn_workflow',
])

test('a level that may spawn teams also allows the task inspection tool it registers', () => {
  const spawning = resolveLevelAllowedTools({
    stageType: 'routing',
    spawnTeams: true,
    hasWorkflows: false,
    alwaysAllowed: ['mcp__pipeline_skills__load_skill'],
  })
  assert.equal(spawning.has('spawn_team'), true)
  assert.equal(spawning.has(INSPECT_TASK_STATE_TOOL_NAME), true)

  // The permission is what registers the tool, so a level without it must not
  // widen the ceiling.
  const plain = resolveLevelAllowedTools({
    stageType: 'routing',
    spawnTeams: false,
    hasWorkflows: false,
    alwaysAllowed: ['mcp__pipeline_skills__load_skill'],
  })
  assert.equal(plain.has('spawn_team'), false)
  assert.equal(plain.has(INSPECT_TASK_STATE_TOOL_NAME), false)
})

test('the shipped receptionist may call the tool it declares, and still may not call a shell', async () => {
  const parsed = parseTeamConfig(path.join(process.cwd(), 'teams/reception-desk/team.yaml'))
  assert.deepEqual(parsed.errors, [])
  const config = parsed.config
  assert.ok(config, 'the shipped reception-desk team must parse')

  const level = config.levels.find((candidate) => candidate.id === 'intake')
  assert.ok(level, 'reception-desk must still declare an intake level')
  const receptionist = config.agents.find((candidate) => candidate.name === 'receptionist')
  assert.ok(receptionist, 'reception-desk must still declare a receptionist')
  assert.ok(
    receptionist.tools?.includes(INSPECT_TASK_STATE_TOOL_NAME),
    'the shipped receptionist declares the tool this test is about',
  )

  const levelAllowedTools = resolveLevelAllowedTools({
    stageType: level.stage.type,
    spawnTeams: level.permissions?.spawn_teams === true,
    hasWorkflows: false,
    alwaysAllowed: ['mcp__pipeline_skills__load_skill'],
  })
  const allowedTools = resolveCoordinatorAllowedTools(receptionist.tools, levelAllowedTools)

  const policy = new TeamRuntimeCapabilityPolicy({
    getSnapshot: () => ({
      levelId: level.id,
      coordinatorRunId: 1,
      levelAdvancedCoordinatorRunId: null,
      coordinator: {
        name: receptionist.name,
        ...whenDefined(allowedTools, (tools) => ({ allowedTools: tools })),
      },
      levelAllowedTools,
      engineTools: ENGINE_TOOLS,
      usedLevelToolsThisCoordinatorTurn: new Set<string>(),
    }),
    trustedRuntimeSource: RUNTIME_SOURCE,
  })
  const registrations: ReadonlyArray<readonly [string, string]> = [
    [`team-runtime.tool.${INSPECT_TASK_STATE_TOOL_NAME}`, INSPECT_TASK_STATE_TOOL_NAME],
    ['team-runtime.pi.bash', 'bash'],
    ['team-runtime.pi.write', 'write'],
  ]
  for (const [capabilityId, toolName] of registrations) {
    policy.register({ capabilityId, toolName })
  }

  const decide = (capabilityId: string) => policy.evaluate({
    context: POLICY_CONTEXT,
    invocation: { capabilityId, toolCallId: `call-${capabilityId}`, source: MODEL_SOURCE },
    effect: serialCapabilityEffect('read-only'),
    risk: 'read-only',
  })

  assert.equal(
    (await decide(`team-runtime.tool.${INSPECT_TASK_STATE_TOOL_NAME}`)).kind,
    'allow',
    'the receptionist declares this tool and the level registers it',
  )

  // Characterization, green before and after: this is the gate that keeps a
  // model-channel call away from a shell and from arbitrary writes. Widening
  // the ceiling must not widen this.
  assert.equal((await decide('team-runtime.pi.bash')).kind, 'deny')
  assert.equal((await decide('team-runtime.pi.write')).kind, 'deny')
})


test('an agent that declares a shell is still denied one on the model channel', () => {
  // The security property is about what the *gate* refuses, not about what the
  // shipped roster happens to ask for. A coordinator that explicitly declares
  // `bash` and `write` must still be held to the level ceiling; this is the
  // check that refuted two audit findings, and widening the ceiling for
  // `inspect-task-state` must not widen it here.
  const levelAllowedTools = resolveLevelAllowedTools({
    stageType: 'routing',
    spawnTeams: true,
    hasWorkflows: false,
    alwaysAllowed: ['mcp__pipeline_skills__load_skill'],
  })
  const allowedTools = resolveCoordinatorAllowedTools(
    ['read', 'bash', 'write', INSPECT_TASK_STATE_TOOL_NAME],
    levelAllowedTools,
  )

  assert.ok(allowedTools, 'a non-empty level ceiling always resolves to a list')
  assert.equal(allowedTools.includes('bash'), false)
  assert.equal(allowedTools.includes('write'), false)
  assert.equal(allowedTools.includes('read'), false)
  assert.equal(allowedTools.includes(INSPECT_TASK_STATE_TOOL_NAME), true)
})
