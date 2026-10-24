import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { parseTeamConfig } from '../../parsers/team-config.js'
import { validateWorkflowForLaunch } from '../../services/run-orchestrator-service.js'
import {
  ensureScheduledAgentTarget,
  renderScheduledAgentWorkflowSnapshot,
  ScheduledAgentTargetError,
} from '../../services/scheduled-agent-target.js'
import { listWorkflowEntries } from '../../services/workflow-service.js'
import { parseWorkflowTemplateYaml } from '../../workflows/loader.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

test('scheduled agent targets are deterministic, validated, and hidden from catalogs', async () => {
  const fixture = createSchedulerFixture('scheduled-agent-target-')
  try {
    const target = await ensureScheduledAgentTarget(
      { agentName: fixture.agentName },
      {
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
      },
    )

    assert.equal(target.workflowId, `scheduled-agent-${fixture.agentName}`)
    assert.deepEqual(
      validateWorkflowForLaunch({
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
        workflowId: target.workflowId,
      }),
      [],
    )

    // A schedule runs the agent, so the wrapper carries the reference only.
    // Injecting a model here would make the same agent run differently
    // depending on how it was started.
    const team = parseTeamConfig(
      path.join(fixture.repoRootPath, 'teams', target.workflowId, 'team.yaml'),
    )
    assert.ok(team.config)
    assert.equal(team.config.agents[0]?.legacyProvider, undefined)
    assert.equal(team.config.agents[0]?.legacyModel, undefined)

    const publicCatalog = listWorkflowEntries(fixture.workflowsRegistryPath)
    assert.deepEqual(publicCatalog.map((entry) => entry.id), [fixture.workflowId])
    const runtimeCatalog = listWorkflowEntries(fixture.workflowsRegistryPath, {
      includeInternal: true,
    })
    assert.deepEqual(
      new Set(runtimeCatalog.map((entry) => entry.id)),
      new Set([fixture.workflowId, target.workflowId]),
    )

    const registryBefore = fs.readFileSync(fixture.workflowsRegistryPath, 'utf8')
    const teamBefore = fs.readFileSync(
      path.join(fixture.repoRootPath, 'teams', target.workflowId, 'team.yaml'),
      'utf8',
    )
    assert.deepEqual(
      await ensureScheduledAgentTarget(
        { agentName: fixture.agentName },
        {
          repoRootPath: fixture.repoRootPath,
          workflowsRegistryPath: fixture.workflowsRegistryPath,
        },
      ),
      target,
    )
    assert.equal(fs.readFileSync(fixture.workflowsRegistryPath, 'utf8'), registryBefore)
    assert.equal(
      fs.readFileSync(
        path.join(fixture.repoRootPath, 'teams', target.workflowId, 'team.yaml'),
        'utf8',
      ),
      teamBefore,
    )
  } finally {
    fixture.cleanup()
  }
})

test('scheduled agent targets reject missing agents', async () => {
  const fixture = createSchedulerFixture('scheduled-agent-missing-')
  try {
    await assert.rejects(
      ensureScheduledAgentTarget(
        { agentName: 'missing-agent' },
        {
          repoRootPath: fixture.repoRootPath,
          workflowsRegistryPath: fixture.workflowsRegistryPath,
        },
      ),
      /not available for scheduling/,
    )
  } finally {
    fixture.cleanup()
  }
})

test('scheduled agent targets snapshot declared tool permissions', async () => {
  const fixture = createSchedulerFixture('scheduled-agent-tools-')
  try {
    const personaPath = path.join(
      fixture.repoRootPath,
      'agents',
      fixture.agentName,
      `${fixture.agentName}.md`,
    )
    const persona = fs.readFileSync(personaPath, 'utf8')
    fs.writeFileSync(
      personaPath,
      persona.replace('model: gpt-5-mini', 'model: gpt-5-mini\ntools: read, browser'),
      'utf8',
    )

    const target = await ensureScheduledAgentTarget(
      { agentName: fixture.agentName },
      {
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
      },
    )
    const team = parseTeamConfig(
      path.join(fixture.repoRootPath, 'teams', target.workflowId, 'team.yaml'),
    )

    assert.deepEqual(team.errors, [])
    assert.deepEqual(team.config?.agents[0]?.tools, ['read', 'browser'])
  } finally {
    fixture.cleanup()
  }
})

test('scheduled Web Researcher targets require browser permission', async () => {
  const fixture = createSchedulerFixture('scheduled-web-researcher-guard-')
  try {
    const agentName = 'web-researcher'
    const personaPath = path.join(
      fixture.repoRootPath,
      'agents',
      agentName,
      `${agentName}.md`,
    )
    fs.mkdirSync(path.dirname(personaPath), { recursive: true })
    fs.writeFileSync(
      personaPath,
      [
        '---',
        `name: ${agentName}`,
        'description: Browser-only test researcher.',
        'tier: strategic',
        'provider: codex',
        'model: gpt-5.5',
        'tools: none',
        '---',
        '',
        'Research current information.',
        '',
      ].join('\n'),
      'utf8',
    )

    await assert.rejects(
      ensureScheduledAgentTarget(
        { agentName },
        {
          repoRootPath: fixture.repoRootPath,
          workflowsRegistryPath: fixture.workflowsRegistryPath,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ScheduledAgentTargetError)
        assert.equal(error.code, 'materialization_failed')
        assert.match(error.message, /browser/)
        return true
      },
    )
    assert.equal(
      fs.existsSync(
        path.join(fixture.repoRootPath, 'teams', `scheduled-agent-${agentName}`),
      ),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('scheduled agent workflow snapshots use one safe per-fire artifact name', () => {
  const workflowYaml = renderScheduledAgentWorkflowSnapshot({
    agentName: 'test-agent',
    workflowId: 'scheduled-agent-test-agent',
    resultArtifact: 'ohio-market-overview.md',
  })
  const parsed = parseWorkflowTemplateYaml(workflowYaml)
  assert.ok(parsed.template)
  assert.equal(parsed.template.steps[0]?.result_artifact, 'ohio-market-overview.md')
  assert.equal(
    parsed.template.steps[0]?.requested_result_type,
    'artifact:ohio-market-overview.md',
  )
  assert.equal(parsed.template.output.artifact, 'ohio-market-overview.md')

  assert.throws(
    () => renderScheduledAgentWorkflowSnapshot({
      agentName: 'test-agent',
      workflowId: 'scheduled-agent-test-agent',
      resultArtifact: '../result.md',
    }),
    /safe Markdown filename/,
  )
})

test('a scheduled wrapper Team is written without a model grade', async () => {
  // The wrapper is a new file this server authors, so §5 applies to it like any
  // other new serialization: it must not write a grade, and it must not invent
  // one by normalizing whatever the persona happens to declare — that is a
  // setting nobody chose, written into a Team the user never edited.
  const fixture = createSchedulerFixture('scheduled-agent-no-grade-')
  try {
    const personaPath = path.join(
      fixture.repoRootPath,
      'agents',
      fixture.agentName,
      `${fixture.agentName}.md`,
    )
    const persona = fs.readFileSync(personaPath, 'utf8')
    // The persona volunteers one, which is what the wrapper used to copy.
    fs.writeFileSync(
      personaPath,
      persona.replace('model: gpt-5-mini', 'model: gpt-5-mini\ntier: specialist'),
      'utf8',
    )

    const target = await ensureScheduledAgentTarget(
      { agentName: fixture.agentName },
      {
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
      },
    )
    const teamYamlPath = path.join(
      fixture.repoRootPath,
      'teams',
      target.workflowId,
      'team.yaml',
    )
    const yaml = fs.readFileSync(teamYamlPath, 'utf8')
    const team = parseTeamConfig(teamYamlPath)

    assert.doesNotMatch(yaml, /^\s*tier:/mu)
    // Still a Team the runtime accepts, with the member it was made for.
    assert.deepEqual(team.errors, [])
    assert.deepEqual(team.warnings, [])
    assert.deepEqual(team.config?.agents.map((agent) => agent.name), [fixture.agentName])
    // And the persona itself is untouched: this writes a wrapper, not an edit.
    assert.match(fs.readFileSync(personaPath, 'utf8'), /^tier: specialist$/mu)
  } finally {
    fixture.cleanup()
  }
})
