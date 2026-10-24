import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { renderRegistryBlock } from '../../domains/workflow-generator/generator-prompt.js'
import { loadRegistry } from '../../domains/workflow-generator/registry.js'

test('loadRegistry exposes team level stage metadata and saved workflow templates', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'workflow-registry-'))
  mkdirSync(path.join(repoRoot, 'teams', 'board'), { recursive: true })
  mkdirSync(path.join(repoRoot, 'agents', 'runtime-router'), { recursive: true })
  mkdirSync(path.join(repoRoot, 'workflows', 'templates'), { recursive: true })

  writeFileSync(
    path.join(repoRoot, 'agents', 'runtime-router', 'runtime-router.md'),
    [
      '---',
      'name: runtime-router',
      'ui_hidden: true',
      '---',
      '',
      '# Runtime Router',
      '',
    ].join('\n'),
  )

  writeFileSync(
    path.join(repoRoot, 'teams.yaml'),
    [
      'board:',
      '  type: team',
      '  description: Discussion board',
      '  team_path: ./teams/board',
      '  input_artifact: incoming-brief.md',
      '  output_artifact: output/decision.md',
      '',
    ].join('\n'),
  )
  writeFileSync(
    path.join(repoRoot, 'teams', 'board', 'team.yaml'),
    [
      'team:',
      '  name: board',
      'agents:',
      '  - name: moderator',
      '    role: Runs the room',
      '  - name: skeptic',
      '    role: Challenges assumptions',
      '  - name: runtime-router',
      '    role: Internal runtime routing',
      '    agent_file: ../../agents/runtime-router/runtime-router.md',
      'levels:',
      '  - id: deliberation',
      '    name: Board Deliberation',
      '    stage:',
      '      type: discussion',
      '      coordinator: moderator',
      '      participants:',
      '        - moderator',
      '        - skeptic',
      '      config:',
      '        min_rounds: 1',
      '        max_rounds: 2',
      '        min_successful_participants: 2',
      '        output:',
      '          format: decision.md',
      '',
    ].join('\n'),
  )
  writeFileSync(
    path.join(repoRoot, 'workflows', 'registry.yaml'),
    [
      'board-to-decision:',
      '  description: Discuss then decide.',
      '  template_path: ./templates/board-to-decision.yaml',
      '  tags:',
      '    - discussion',
      '  capabilities:',
      '    - debate_then_decide',
      '',
    ].join('\n'),
  )
  writeFileSync(
    path.join(repoRoot, 'workflows', 'templates', 'board-to-decision.yaml'),
    [
      'workflow:',
      '  id: board-to-decision',
      '  input:',
      '    artifact: incoming-request.md',
      '  steps:',
      '    - id: discuss',
      '      type: team',
      '      team: board',
      '      input_artifact: incoming-brief.md',
      '      result_artifact: output/decision.md',
      '      requested_result_type: artifact:output/decision.md',
      '  output:',
      '    from_step: discuss',
      '    artifact: output/decision.md',
      '  on_blocked: stop',
      '  on_failed: stop',
      '',
    ].join('\n'),
  )

  const registry = loadRegistry(repoRoot)
  assert.equal(requiredValue(requiredValue(registry.teams[0], 'tests/unit/workflow-generator-registry.test.ts:109').levels?.[0], 'tests/unit/workflow-generator-registry.test.ts:110').stage_type, 'discussion')
  assert.equal(requiredValue(requiredValue(registry.teams[0], 'tests/unit/workflow-generator-registry.test.ts:110').levels?.[0], 'tests/unit/workflow-generator-registry.test.ts:111').coordinator, 'moderator')
  assert.deepEqual(requiredValue(requiredValue(registry.teams[0], 'tests/unit/workflow-generator-registry.test.ts:111').levels?.[0], 'tests/unit/workflow-generator-registry.test.ts:112').participants, ['moderator', 'skeptic'])
  assert.equal(requiredValue(requiredValue(registry.teams[0], 'tests/unit/workflow-generator-registry.test.ts:112').levels?.[0], 'tests/unit/workflow-generator-registry.test.ts:113').max_rounds, 2)
  assert.equal(requiredValue(requiredValue(registry.teams[0], 'tests/unit/workflow-generator-registry.test.ts:113').levels?.[0], 'tests/unit/workflow-generator-registry.test.ts:114').output_format, 'decision.md')
  assert.deepEqual(
    requiredValue(registry.teams[0], 'tests/unit/workflow-generator-registry.test.ts:115').agents.map((agent) => agent.name),
    ['moderator', 'skeptic'],
  )

  writeFileSync(
    path.join(repoRoot, 'agents', 'runtime-router', 'runtime-router.md'),
    ['---', 'name: runtime-router', '---', '', '# Runtime Router', ''].join('\n'),
  )
  const changedTime = new Date(Date.now() + 2_000)
  utimesSync(
    path.join(repoRoot, 'agents', 'runtime-router', 'runtime-router.md'),
    changedTime,
    changedTime,
  )
  assert.deepEqual(
    requiredValue(loadRegistry(repoRoot).teams[0], 'tests/unit/workflow-generator-registry.test.ts:130').agents.map((agent) => agent.name),
    ['moderator', 'skeptic', 'runtime-router'],
  )
  assert.equal(requiredValue(registry.workflow_templates?.[0], 'tests/unit/workflow-generator-registry.test.ts:133').id, 'board-to-decision')
  assert.equal(requiredValue(registry.workflow_templates?.[0], 'tests/unit/workflow-generator-registry.test.ts:135').input_artifact, 'incoming-request.md')
  assert.equal(requiredValue(registry.workflow_templates?.[0], 'tests/unit/workflow-generator-registry.test.ts:136').steps?.[0]?.team, 'board')
  assert.equal(
    requiredValue(registry.workflow_templates?.[0], 'first workflow template').output,
    'discuss:output/decision.md',
  )
})

test('renderRegistryBlock includes levels, stage types, and templates for the architect', () => {
  const block = renderRegistryBlock({
    teams: [
      {
        id: 'board',
        description: 'Discussion board',
        default_input_artifact: 'incoming-brief.md',
        default_output_artifact: 'output/decision.md',
        has_discussion_level: true,
        has_review_level: false,
        level_ids: ['deliberation'],
        levels: [
          {
            id: 'deliberation',
            name: 'Board Deliberation',
            stage_type: 'discussion',
            coordinator: 'moderator',
            participants: ['moderator', 'skeptic'],
            min_rounds: 1,
            max_rounds: 2,
            output_format: 'decision.md',
          },
        ],
        agents: [
          { name: 'moderator', role: 'Runs the room' },
          { name: 'skeptic', role: 'Challenges assumptions' },
        ],
      },
    ],
    workflow_templates: [
      {
        id: 'board-to-decision',
        description: 'Discuss then decide.',
        template_path: './templates/board-to-decision.yaml',
        tags: ['discussion'],
        capabilities: ['debate_then_decide'],
        input_artifact: 'incoming-request.md',
        steps: [
          {
            id: 'discuss',
            team: 'board',
            result_artifact: 'output/decision.md',
            requested_result_type: 'artifact:output/decision.md',
          },
        ],
        output: 'discuss:output/decision.md',
      },
    ],
  })

  assert.match(block, /stage_type: discussion/)
  assert.match(block, /participants: moderator, skeptic/)
  assert.match(block, /settings: min_rounds: 1, max_rounds: 2/)
  assert.match(block, /Available saved workflow templates/)
  assert.match(block, /board-to-decision/)
  assert.match(block, /capabilities: debate_then_decide/)
  assert.match(block, /input: incoming-request\.md/)
  assert.match(block, /1\. discuss: team=board -> output\/decision\.md/)
  assert.match(block, /output: discuss:output\/decision\.md/)
})
