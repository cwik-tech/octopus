import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { readAcquisitionAgentPolicy } from '../../domains/acquisition/acquisition-policy.js'
import { deriveEffectiveWorkflowTemplateContracts } from '../../domains/stage/stage-contracts.js'
import { parseWorkflowRegistry, parseWorkflowTemplate } from '../../workflows/loader.js'
import { validateWorkflowTemplate } from '../../workflows/validation.js'

const repoRoot = process.cwd()

test('every live registered workflow passes launch validation', () => {
  const workflowRegistry = parseWorkflowRegistry(
    path.join(repoRoot, 'workflows', 'registry.yaml'),
  )
  const teamRegistry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  assert.deepEqual(workflowRegistry.errors, [])
  assert.deepEqual(workflowRegistry.warnings, [])
  assert.deepEqual(teamRegistry.errors, [])

  const teamsByName = new Map(
    teamRegistry.entries.map((entry) => [entry.name, entry]),
  )
  const failures = workflowRegistry.entries.flatMap((entry) => {
    const parsed = parseWorkflowTemplate(entry.template_path)
    if (!parsed.template) {
      return parsed.errors.map((error) => `${entry.name}: ${error}`)
    }
    const validationFailures = validateWorkflowTemplate(
      parsed.template,
      teamsByName,
    ).map(
      (error) => `${entry.name}: ${error}`,
    )
    const outputContractFailures = parsed.template.steps.flatMap((step) => {
      if (!step.team) return []
      const teamEntry = teamsByName.get(step.team)
      if (!teamEntry || teamEntry.type !== 'team') return []
      const team = parseTeamConfig(path.join(teamEntry.team_path, 'team.yaml'))
      if (!team.config) {
        return team.errors.map(
          (error) => `${entry.name}/${step.id}: ${error}`,
        )
      }
      const completionArtifact = deriveEffectiveWorkflowTemplateContracts(
        team.config,
      ).output.completion_artifact
      return completionArtifact && step.result_artifact !== completionArtifact
        ? [
            `${entry.name}/${step.id}: result_artifact '${step.result_artifact}' ` +
              `does not match team completion artifact '${completionArtifact}'`,
          ]
        : []
    })
    return [...validationFailures, ...outputContractFailures]
  })

  assert.deepEqual(failures, [])
})

test('live registry entry for writing-team matches the workflow template contract', () => {
  const registry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  const team = parseTeamConfig(path.join(repoRoot, 'teams', 'writing-team', 'team.yaml'))

  assert.equal(registry.errors.length, 0)
  assert.equal(team.errors.length, 0)
  assert.ok(team.config)

  const writingEntry = registry.entries.find((entry) => entry.name === 'writing-team')
  assert.ok(writingEntry)
  assert.equal(writingEntry?.type, 'team')

  const contracts = deriveEffectiveWorkflowTemplateContracts(team.config!)
  assert.equal(contracts.entry_level, 'brief-and-draft')
  assert.equal(contracts.input.artifacts?.[0]?.path, 'incoming-brief.md')
  assert.equal(contracts.output.completion_artifact, 'final-draft.md')
  assert.deepEqual(contracts.capabilities, ['writing', 'editing', 'report-generation'])
  assert.deepEqual(contracts.invocation_modes, ['user', 'team'])

  if (writingEntry?.type === 'team') {
    assert.equal(writingEntry.input_artifact, contracts.input.artifacts?.[0]?.path)
    assert.equal(writingEntry.output_artifact, contracts.output.completion_artifact)
  }
})

test('YouTube workflows execute the extractor agent instead of stopping at routing', () => {
  const registry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  const team = parseTeamConfig(path.join(repoRoot, 'teams', 'youtube-extraction', 'team.yaml'))

  assert.equal(registry.errors.length, 0)
  assert.equal(team.errors.length, 0)
  assert.ok(team.config)

  const youtubeEntry = registry.entries.find((entry) => entry.name === 'youtube-extraction')
  assert.ok(youtubeEntry)
  assert.equal(youtubeEntry?.type, 'team')

  const entryLevel = team.config!.levels.find(
    (level) => level.id === team.config!.workflow?.entry_level,
  )
  assert.equal(entryLevel?.stage.type, 'chain')
  if (entryLevel?.stage.type === 'chain') {
    assert.deepEqual(entryLevel.stage.sequence, ['youtube-extractor'])
  }

  const extractor = team.config!.agents.find((agent) => agent.name === 'youtube-extractor')
  assert.ok(extractor)
  assert.ok(extractor?.tools?.includes('youtube_extract'))

  const contracts = deriveEffectiveWorkflowTemplateContracts(team.config!)
  assert.equal(contracts.output.completion_artifact, 'extraction-report.md')
  if (youtubeEntry?.type === 'team') {
    assert.equal(youtubeEntry.output_artifact, contracts.output.completion_artifact)
  }
})

test('YouTube manual workflow routes video, playlist, and channel requests through the extraction team', () => {
  const workflowRegistry = parseWorkflowRegistry(
    path.join(repoRoot, 'workflows', 'registry.yaml'),
  )
  const entry = workflowRegistry.entries.find(
    (candidate) => candidate.name === 'youtube-manual-generation',
  )

  assert.ok(entry)
  const parsed = parseWorkflowTemplate(entry.template_path)
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.template)
  assert.equal(parsed.template?.steps.length, 1)
  assert.equal(parsed.template?.steps[0]?.team, 'youtube-extraction')
  assert.equal(parsed.template?.steps[0]?.result_artifact, 'extraction-report.md')
  assert.equal(parsed.template?.input?.artifact, 'incoming-request.md')
  assert.equal(parsed.template?.steps[0]?.input_artifact, 'incoming-brief.md')
  assert.equal(parsed.template?.output.artifact, 'extraction-report.md')
  assert.ok(parsed.template?.steps[0]?.optional_result_artifact_globs?.includes(
    'output/manuals/*/*/source-video.mp4',
  ))
  assert.deepEqual(
    parsed.template?.output.secondary_artifact_globs?.find(
      (artifact) => artifact.glob === 'output/manuals/*/*/source-video.mp4',
    ),
    {
      glob: 'output/manuals/*/*/source-video.mp4',
      media_type: 'video/mp4',
      label: 'Downloaded source video',
    },
  )
  assert.match(parsed.template?.steps[0]?.brief_suffix ?? '', /manual mode/iu)
  assert.match(parsed.template?.description ?? '', /video, playlist, or channel/iu)

  const team = parseTeamConfig(path.join(repoRoot, 'teams', 'youtube-extraction', 'team.yaml'))
  assert.ok(team.config)
  const contracts = deriveEffectiveWorkflowTemplateContracts(team.config!)
  assert.ok(contracts.capabilities?.includes('manual-generation'))
  assert.ok(
    contracts.output.artifacts?.some((artifact) => artifact.path === 'output/manuals/'),
  )
  const agentInstructions = readFileSync(
    path.join(repoRoot, 'agents', 'youtube-extractor', 'youtube-extractor.md'),
    'utf8',
  )
  assert.match(
    agentInstructions,
    /manual mode[\s\S]*call `youtube_extract` with `capture`[\s\S]*before `prepare_manual`/iu,
  )
  assert.match(agentInstructions, /never ask the user to stop.*configure Gemini.*mid-run/isu)
  assert.match(agentInstructions, /premierePending[\s\S]*never.*capture_authenticated/iu)
})

test('reception-desk fixture routes to writing-team with compatible child-team contracts', () => {
  const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'reception-to-writing-e2e')
  const registry = parseTeamRegistry(path.join(fixtureRoot, 'teams.yaml'))
  const reception = parseTeamConfig(path.join(fixtureRoot, 'teams', 'reception-desk', 'team.yaml'))
  const writing = parseTeamConfig(path.join(fixtureRoot, 'teams', 'writing-team', 'team.yaml'))

  assert.equal(registry.errors.length, 0)
  assert.equal(reception.errors.length, 0)
  assert.equal(writing.errors.length, 0)
  assert.ok(reception.config)
  assert.ok(writing.config)

  const writingEntry = registry.entries.find((entry) => entry.name === 'writing-team')
  assert.ok(writingEntry)
  assert.equal(writingEntry?.type, 'team')

  const receptionContracts = deriveEffectiveWorkflowTemplateContracts(reception.config!)
  const writingContracts = deriveEffectiveWorkflowTemplateContracts(writing.config!)

  assert.equal(receptionContracts.entry_level, 'intake')
  assert.equal(receptionContracts.output.completion_artifact, 'delegation-writing-team-result.md')
  assert.equal(writingContracts.entry_level, 'brief-and-draft')
  assert.equal(writingContracts.output.completion_artifact, 'final-draft.md')

  if (writingEntry?.type === 'team') {
    assert.equal(writingEntry.input_artifact, 'incoming-brief.md')
    assert.equal(writingEntry.output_artifact, writingContracts.output.completion_artifact)
  }
})

test('problem-thinking-board workflow contract matches its registry entry', () => {
  const registry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  const team = parseTeamConfig(path.join(repoRoot, 'teams', 'problem-thinking-board', 'team.yaml'))

  assert.equal(registry.errors.length, 0)
  assert.equal(team.errors.length, 0)
  assert.ok(team.config)

  const boardEntry = registry.entries.find((entry) => entry.name === 'problem-thinking-board')
  assert.ok(boardEntry)
  assert.equal(boardEntry?.type, 'team')

  const contracts = deriveEffectiveWorkflowTemplateContracts(team.config!)
  assert.equal(contracts.entry_level, 'deliberation')
  assert.equal(contracts.input.artifacts?.[0]?.path, 'incoming-brief.md')
  assert.equal(contracts.output.completion_artifact, 'output/decomposition-plan.md')
  assert.deepEqual(contracts.capabilities, ['strategy', 'decomposition', 'board', 'analysis'])
  assert.deepEqual(contracts.invocation_modes, ['user', 'team'])

  if (boardEntry?.type === 'team') {
    assert.equal(boardEntry.input_artifact, contracts.input.artifacts?.[0]?.path)
    assert.equal(boardEntry.output_artifact, contracts.output.completion_artifact)
  }
})

test('crypto investment board deliberates across every risk lens before the lead returns a decision', () => {
  const registry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  const team = parseTeamConfig(
    path.join(repoRoot, 'teams', 'crypto-investment-board', 'team.yaml'),
  )

  assert.deepEqual(registry.errors, [])
  assert.deepEqual(team.errors, [])
  assert.ok(team.config)

  const boardEntry = registry.entries.find(
    (entry) => entry.name === 'crypto-investment-board',
  )
  assert.ok(boardEntry)
  assert.equal(boardEntry.type, 'team')

  const entryLevel = team.config.levels.find(
    (level) => level.id === team.config?.workflow?.entry_level,
  )
  assert.ok(entryLevel)
  assert.equal(entryLevel.stage.type, 'discussion')
  if (entryLevel.stage.type !== 'discussion') {
    assert.fail('crypto investment board must use a discussion stage')
  }

  assert.equal(entryLevel.stage.coordinator, 'crypto-investment-lead')
  assert.equal(entryLevel.stage.config.output.format, 'board-deliberation.md')
  assert.deepEqual(entryLevel.stage.participants, [
    'crypto-early-signal-scout',
    'crypto-token-diligence-analyst',
    'crypto-risk-compliance-analyst',
    'contrarian',
    'web-researcher',
    'crypto-market-analyst',
    'crypto-portfolio-strategist',
  ])

  for (const researchAgentName of ['crypto-early-signal-scout', 'web-researcher']) {
    const researchAgent = team.config.agents.find(
      (agent) => agent.name === researchAgentName,
    )
    assert.ok(researchAgent)
    assert.ok(researchAgent.tools?.includes('read'))
    assert.ok(researchAgent.tools?.includes('research_web'))
    assert.equal(
      readAcquisitionAgentPolicy(repoRoot, `agents/${researchAgentName}`).enabled,
      true,
    )
  }

  const riskAgent = team.config.agents.find(
    (agent) => agent.name === 'crypto-risk-compliance-analyst',
  )
  assert.ok(riskAgent)
  assert.ok(riskAgent.agent_file)
  assert.ok(
    existsSync(
      path.resolve(
        repoRoot,
        'teams',
        'crypto-investment-board',
        riskAgent.agent_file,
      ),
    ),
  )

  const synthesisLevel = team.config.levels.find(
    (level) => level.id === 'decision-synthesis',
  )
  assert.ok(synthesisLevel)
  assert.equal(synthesisLevel.stage.type, 'chain')
  if (synthesisLevel.stage.type !== 'chain') {
    assert.fail('crypto investment board must end with a lead synthesis chain')
  }
  assert.deepEqual(synthesisLevel.stage.sequence, ['crypto-investment-lead'])
  assert.equal(synthesisLevel.stage.config.output.format, 'final-result.md')

  assert.ok(
    team.config.gates.some(
      (gate) =>
        gate.from === entryLevel.id &&
        gate.to === synthesisLevel.id &&
        gate.condition.type === 'artifact_exists' &&
        gate.condition.artifact === 'board-deliberation.md',
    ),
  )

  const contracts = deriveEffectiveWorkflowTemplateContracts(team.config)
  assert.equal(contracts.output.completion_artifact, 'final-result.md')
  if (boardEntry.type === 'team') {
    assert.equal(boardEntry.output_artifact, contracts.output.completion_artifact)
  }
})

test('every crypto investment specialist can load the shared plain-language skill', () => {
  const specialistNames = [
    'crypto-early-signal-scout',
    'crypto-investment-lead',
    'crypto-market-analyst',
    'crypto-portfolio-strategist',
    'crypto-risk-compliance-analyst',
    'crypto-token-diligence-analyst',
  ]

  for (const specialistName of specialistNames) {
    assert.ok(
      existsSync(
        path.join(
          repoRoot,
          'agents',
          specialistName,
          'skills',
          'crypto-plain-language-explainer',
          'SKILL.md',
        ),
      ),
      `${specialistName} is missing crypto-plain-language-explainer`,
    )
  }
})

test('no user-visible workflow runs the Reception Desk as a second intake layer', () => {
  const workflowRegistry = parseWorkflowRegistry(
    path.join(repoRoot, 'workflows', 'registry.yaml'),
  )
  assert.deepEqual(workflowRegistry.errors, [])

  // Run already does intake. A registered workflow that opens with the
  // reception desk asks the user the same questions a second time, from a
  // second routing authority.
  const offenders = workflowRegistry.entries.flatMap((entry) => {
    const parsed = parseWorkflowTemplate(entry.template_path)
    const steps = parsed.template?.steps ?? []
    return steps
      .filter((step) => step.type === 'team' && step.team === 'reception-desk')
      .map((step) => `${entry.name}: step '${step.id}'`)
  })

  assert.deepEqual(offenders, [])
})
