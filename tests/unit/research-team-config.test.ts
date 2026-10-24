import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'

import { MINIMUM_DEEP_RESEARCH_DURATION_MINUTES } from '../../domains/deep-research/deep-research-settings.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { loadAgent } from '../../parsers/load-agent.js'
import { parseTeamConfig } from '../../parsers/team-config.js'

test('research team wires bounded collection, factual quality routing, and correction escalation', () => {
  const parsed = parseTeamConfig(path.join(process.cwd(), 'teams', 'research-team', 'team.yaml'))
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.warnings, [])
  assert.ok(parsed.config)

  const config = parsed.config
  assert.equal(config.workflow?.user_facing, false)
  assert.equal(config.workflow?.output_contract?.completion_artifact, 'research-package.md')

  const researcher = config.agents.find((agent) => agent.name === 'web-researcher')
  const synthesizer = config.agents.find((agent) => agent.name === 'research-synthesizer')
  const critic = config.agents.find((agent) => agent.name === 'evidence-critic')
  const escalator = config.agents.find((agent) => agent.name === 'research-escalator')
  assert.deepEqual(researcher?.tools, ['read', 'research_web', 'browser'])
  assert.equal(researcher?.on_failure?.policy, 'retry')
  assert.equal(researcher?.on_failure?.max_retries, 1)
  assert.equal(researcher?.on_failure?.fallback_agent, undefined)
  // The synthesizer reads nothing: the runtime materializes its whole bundle
  // into the request, so a filesystem grant would only give a live provider a
  // second, conflicting instruction about where its evidence comes from.
  assert.deepEqual(synthesizer?.tools, [])
  // The critic receives its core inputs in a runtime-owned bundle. Its narrow
  // read grant remains for specifically disputed assignment evidence.
  assert.deepEqual(critic?.tools, ['read'])
  assert.deepEqual(escalator?.tools, [])
  assert.deepEqual(
    critic?.produces?.map((artifact) => artifact.path),
    ['research/quality/current-verdict.json'],
  )

  // `draft-sections` fans out eight concurrent writers inside the same run
  // budget as the research it follows, so it must share the deadline too or it
  // dispatches with no clamp, no shutdown reserve, and no diagnostic.
  for (const levelId of [
    'collect-evidence',
    'draft-sections',
    'synthesize-evidence',
    'quality-audit',
  ]) {
    const level = config.levels.find((candidate) => candidate.id === levelId)
    assert.ok(level)
    const deadlineArtifact = 'deadline_artifact' in level.stage.config
      ? level.stage.config.deadline_artifact
      : undefined
    assert.equal(
      deadlineArtifact,
      'research/runtime-limits.json',
      `${levelId} must share the approved absolute deadline`,
    )
  }
  const collection = config.levels.find((level) => level.id === 'collect-evidence')
  assert.equal(collection?.stage.type, 'pipeline')
  if (collection?.stage.type !== 'pipeline') {
    assert.fail('collect-evidence must be a pipeline stage')
  }
  assert.equal(
    collection.stage.config.on_agent_failure,
    undefined,
    'collection must retain the web researcher bounded retry policy',
  )
  const quality = config.levels.find((level) => level.id === 'quality-audit')
  assert.equal(quality?.stage.type, 'chain')
  if (quality?.stage.type !== 'chain') assert.fail('quality-audit must be a chain stage')
  assert.deepEqual(quality.stage.sequence, ['evidence-critic'])
  assert.equal(quality.stage.config.structured_output, 'deep_research_quality_verdict')
  assert.deepEqual(quality.stage.config.research_quality_bundle, {
    plan_artifact: 'research/approved-plan.json',
    quality_packet_artifact: 'research/quality/current-packet.json',
    deterministic_verdict_artifact: 'research/quality/deterministic-verdict.json',
    report_artifact: 'research-package.md',
    context_window_tokens: 200000,
    output_reserve_tokens: 32000,
  })

  const escalation = config.levels.find((level) => level.id === 'research-escalation')
  assert.equal(escalation?.stage.type, 'chain')
  if (escalation?.stage.type !== 'chain') assert.fail('research-escalation must be a chain stage')
  assert.deepEqual(escalation.stage.sequence, ['research-escalator'])
  assert.deepEqual(
    escalation.stage.config.output_contract?.artifacts?.map((artifact) => artifact.path),
    ['research/quality/escalation.md'],
  )
  assert.equal(
    escalation.stage.config.output_contract?.completion_artifact,
    'research/quality/escalation.md',
  )
  assert.equal(
    config.gates.some((gate) => gate.from === 'research-escalation'),
    false,
    'a persisted blocker must not route to successful completion',
  )

  const qualityRoutes = config.gates.filter((gate) => gate.from === 'quality-audit')
  assert.deepEqual(qualityRoutes.map((gate) => gate.to), [
    'synthesize-evidence',
    'collect-evidence',
    'research-escalation',
    'research-escalation',
    'done',
    'research-escalation',
  ])
  assert.deepEqual(qualityRoutes.map((gate) => gate.condition.type), [
    'artifact_json',
    'artifact_json',
    'artifact_json',
    'artifact_json',
    'artifact_json',
    'artifact_exists',
  ])
  assert.equal(qualityRoutes[0]?.reset_scope, 'target_through_source')
  assert.equal(qualityRoutes[0]?.max_loopbacks, 2)
  assert.equal(
    path.basename(qualityRoutes[0]?.transform?.script ?? ''),
    'prepare-resynthesis-wave.mjs',
  )
  assert.equal(qualityRoutes[0]?.transform?.strictness, 'hard')
  assert.equal(qualityRoutes[1]?.reset_scope, 'target_through_source')
  assert.equal(qualityRoutes[1]?.max_loopbacks, 2)
  assert.equal(
    path.basename(qualityRoutes[1]?.transform?.script ?? ''),
    'prepare-correction-wave.mjs',
  )
  assert.equal(qualityRoutes[1]?.transform?.strictness, 'hard')
  assert.equal(qualityRoutes[4]?.condition.type, 'artifact_json')
  if (qualityRoutes[4]?.condition.type === 'artifact_json') {
    assert.equal(qualityRoutes[4].condition.pointer, '/decision')
    assert.equal(qualityRoutes[4].condition.value, 'APPROVE')
  }
  assert.equal(qualityRoutes[5]?.condition.type, 'artifact_exists')
  if (qualityRoutes[5]?.condition.type === 'artifact_exists') {
    assert.equal(
      qualityRoutes[5].condition.artifact,
      'research/quality/current-verdict.json',
    )
  }

  const prepareRoute = config.gates.find((gate) => gate.from === 'prepare-approved-plan')
  assert.equal(
    path.basename(prepareRoute?.transform?.script ?? ''),
    'materialize-approved-plan.mjs',
  )
  assert.equal(prepareRoute?.transform?.strictness, 'hard')
})

test('every level timeout that can never fire is pinned, so a new one cannot slip in', () => {
  const parsed = parseTeamConfig(
    path.join(process.cwd(), 'teams', 'research-team', 'team.yaml'),
  )
  assert.ok(parsed.config)

  // A declared `agent_timeout_minutes` at or above the approved plan budget
  // expires no earlier than the run deadline, so it reads as a safety control
  // while providing none. The smallest approvable plan is the strictest
  // yardstick; against it three shipped levels are already diagnostic.
  //
  // The Time-Budgets ADR forbids changing the declared values, so this pins
  // the known set rather than asserting the set is empty: a level added or
  // retimed above the floor breaks this test and forces an explicit decision.
  const diagnostic = parsed.config.levels
    .filter((level) => {
      const constraints =
        'constraints' in level.stage.config
          ? level.stage.config.constraints
          : undefined
      const declared = constraints?.agent_timeout_minutes
      return (
        declared !== undefined &&
        declared >= MINIMUM_DEEP_RESEARCH_DURATION_MINUTES
      )
    })
    .map((level) => level.id)
    .sort()

  assert.deepEqual(
    diagnostic,
    ['collect-evidence', 'draft-sections', 'synthesize-evidence'],
    'a level declaring a timeout at or above the smallest approvable plan ' +
      'duration must be an explicit, reviewed exception',
  )
})

test('the shipped evidence critic resolves to Codex Terra even when the app default is Claude Haiku', () => {
  const parsed = parseTeamConfig(path.join(process.cwd(), 'teams', 'research-team', 'team.yaml'))
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.config)
  const rosterEntry = parsed.config.agents.find((agent) => agent.name === 'evidence-critic')
  assert.ok(rosterEntry, 'research-team must roster the evidence critic')

  setRuntimeDefaultModelState({ status: 'available', provider: 'claude', model: 'claude-haiku-4-5-20251001' })
  try {
    const loaded = loadAgent(rosterEntry, parsed.config, 0)

    assert.ok(loaded, 'the evidence critic must load')
    assert.equal(loaded.provider, 'codex')
    assert.equal(loaded.model, 'gpt-5.6-terra')
    // The agent's own file decides its reasoning level now that the team's
    // tier table no longer overrides it.
    assert.equal(loaded.thinking, 'high')
    assert.equal(loaded.selection?.source, 'agent')
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
})
