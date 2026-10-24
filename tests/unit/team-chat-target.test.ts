import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { validateWorkflowForLaunch } from '../../services/run-orchestrator-service.js'
import {
  ensureTeamChatTarget,
  TeamChatTargetError,
} from '../../services/team-chat-target.js'
import { listWorkflowEntries } from '../../services/workflow-service.js'
import { parseWorkflowTemplateYaml } from '../../workflows/loader.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'

const teamId = 'test-team'

/**
 * The shared scheduler fixture declares its team caller-only. Chat targets are
 * only materialized for user-invocable teams, so opt the fixture in.
 */
function makeTeamUserInvocable(repoRootPath: string): void {
  const teamYamlPath = path.join(repoRootPath, 'teams', teamId, 'team.yaml')
  fs.writeFileSync(
    teamYamlPath,
    fs
      .readFileSync(teamYamlPath, 'utf8')
      .replace('  user_facing: false\n', '  user_facing: true\n')
      .replace('    - team\n', '    - team\n    - user\n'),
  )
}

test('team chat targets wrap an existing team in one validated, hidden workflow', async () => {
  const fixture = createSchedulerFixture('team-chat-target-')
  try {
    makeTeamUserInvocable(fixture.repoRootPath)
    const options = {
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }
    const target = await ensureTeamChatTarget({ teamId }, options)

    assert.equal(target.workflowId, 'team-chat-test-team-5e8a78eff975')
    assert.deepEqual(
      validateWorkflowForLaunch({ ...options, workflowId: target.workflowId }),
      [],
    )

    // The team already exists and is registered — the wrapper must not fork it.
    assert.equal(
      fs.existsSync(path.join(fixture.repoRootPath, 'teams', target.workflowId)),
      false,
    )

    const templatePath = path.join(
      fixture.repoRootPath,
      'workflows',
      'user-generated',
      `${target.workflowId}.yaml`,
    )
    const parsed = parseWorkflowTemplateYaml(
      fs.readFileSync(templatePath, 'utf8'),
    )
    const workflowYaml = fs.readFileSync(templatePath, 'utf8')
    assert.ok(parsed.template, parsed.errors.join('; '))
    assert.equal(parsed.template.steps.length, 1)
    assert.equal(parsed.template.steps[0]?.type, 'team')
    assert.equal(parsed.template.steps[0]?.team, teamId)
    assert.match(workflowYaml, /\n      team: "test-team"\n/)

    // Generated wrappers must stay out of the workflow catalog the
    // receptionist and the Create sidebar read.
    const visible = listWorkflowEntries(fixture.workflowsRegistryPath)
    assert.equal(
      visible.some((entry) => entry.id === target.workflowId),
      false,
    )
    assert.equal(
      listWorkflowEntries(fixture.workflowsRegistryPath, {
        includeInternal: true,
      }).some((entry) => entry.id === target.workflowId),
      true,
    )
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets are idempotent across repeated calls', async () => {
  const fixture = createSchedulerFixture('team-chat-target-idempotent-')
  try {
    makeTeamUserInvocable(fixture.repoRootPath)
    const options = {
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }
    const first = await ensureTeamChatTarget({ teamId }, options)
    const templatePath = path.join(
      fixture.repoRootPath,
      'workflows',
      'user-generated',
      `${first.workflowId}.yaml`,
    )
    const templateAfterFirst = fs.readFileSync(templatePath, 'utf8')
    const registryAfterFirst = fs.readFileSync(
      fixture.workflowsRegistryPath,
      'utf8',
    )

    const second = await ensureTeamChatTarget({ teamId }, options)
    assert.equal(second.workflowId, first.workflowId)
    assert.equal(fs.readFileSync(templatePath, 'utf8'), templateAfterFirst)

    const registryAfterSecond = fs.readFileSync(
      fixture.workflowsRegistryPath,
      'utf8',
    )
    assert.equal(registryAfterSecond, registryAfterFirst)
    assert.equal(
      registryAfterSecond.split('\n').filter(
        (line) => line === `${first.workflowId}:`,
      ).length,
      1,
    )
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets keep distinct wrapper identities for lossy team names', async () => {
  const fixture = createSchedulerFixture('team-chat-target-collision-')
  try {
    makeTeamUserInvocable(fixture.repoRootPath)
    fs.appendFileSync(
      path.join(fixture.repoRootPath, 'teams.yaml'),
      [
        'test.team:',
        '  type: team',
        '  description: Colliding test team alias.',
        '  team_path: ./teams/test-team',
        '  input_artifact: incoming-brief.md',
        '  output_artifact: result.md',
        '',
      ].join('\n'),
    )
    const options = {
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    }

    const exact = await ensureTeamChatTarget({ teamId }, options)
    const lossy = await ensureTeamChatTarget({ teamId: 'test.team' }, options)

    assert.notEqual(lossy.workflowId, exact.workflowId)
    const lossyTemplate = parseWorkflowTemplateYaml(
      fs.readFileSync(
        path.join(
          fixture.repoRootPath,
          'workflows',
          'user-generated',
          `${lossy.workflowId}.yaml`,
        ),
        'utf8',
      ),
    )
    assert.equal(lossyTemplate.template?.steps[0]?.team, 'test.team')
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets quote YAML-significant registered team identifiers', async () => {
  const fixture = createSchedulerFixture('team-chat-target-yaml-id-')
  try {
    makeTeamUserInvocable(fixture.repoRootPath)
    const significantTeamId = 'test: #team'
    fs.appendFileSync(
      path.join(fixture.repoRootPath, 'teams.yaml'),
      [
        `${JSON.stringify(significantTeamId)}:`,
        '  type: team',
        '  description: Team with a YAML-significant identifier.',
        '  team_path: ./teams/test-team',
        '  input_artifact: incoming-brief.md',
        '  output_artifact: result.md',
        '',
      ].join('\n'),
    )

    const target = await ensureTeamChatTarget(
      { teamId: significantTeamId },
      {
        repoRootPath: fixture.repoRootPath,
        workflowsRegistryPath: fixture.workflowsRegistryPath,
      },
    )
    const templatePath = path.join(
      fixture.repoRootPath,
      'workflows',
      'user-generated',
      `${target.workflowId}.yaml`,
    )
    const workflowYaml = fs.readFileSync(templatePath, 'utf8')
    const parsed = parseWorkflowTemplateYaml(workflowYaml)

    assert.equal(target.workflowId, 'team-chat-test-team-73775210e4ca')
    assert.ok(parsed.template, parsed.errors.join('; '))
    assert.equal(parsed.template.steps[0]?.team, significantTeamId)
    assert.match(workflowYaml, /\n      team: "test: #team"\n/)
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets reject a team that is not registered', async () => {
  const fixture = createSchedulerFixture('team-chat-target-unknown-')
  try {
    await assert.rejects(
      () =>
        ensureTeamChatTarget(
          { teamId: 'no-such-team' },
          {
            repoRootPath: fixture.repoRootPath,
            workflowsRegistryPath: fixture.workflowsRegistryPath,
          },
        ),
      (error: unknown) =>
        error instanceof TeamChatTargetError && error.code === 'unknown_team',
    )
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets refuse a team that is not user invocable', async () => {
  const fixture = createSchedulerFixture('team-chat-target-caller-only-')
  try {
    // Declare the fixture team caller-only, the way research-team does.
    const teamYamlPath = path.join(
      fixture.repoRootPath,
      'teams',
      teamId,
      'team.yaml',
    )
    fs.writeFileSync(
      teamYamlPath,
      fs
        .readFileSync(teamYamlPath, 'utf8')
        .replace("  user_facing: false\n", '')
        .replace(
          '  invocation_modes:\n    - team\n',
          '  invocation_modes:\n    - team\n  user_facing: false\n',
        ),
    )

    await assert.rejects(
      () =>
        ensureTeamChatTarget(
          { teamId },
          {
            repoRootPath: fixture.repoRootPath,
            workflowsRegistryPath: fixture.workflowsRegistryPath,
          },
        ),
      (error: unknown) =>
        error instanceof TeamChatTargetError &&
        error.code === 'team_not_user_invocable',
    )

    // Nothing is written for a refused team.
    assert.equal(
      fs.existsSync(
        path.join(
          fixture.repoRootPath,
          'workflows',
          'user-generated',
          'team-chat-test-team-5e8a78eff975.yaml',
        ),
      ),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets refuse malformed team configuration before writing a wrapper', async () => {
  const fixture = createSchedulerFixture('team-chat-target-malformed-')
  try {
    const teamYamlPath = path.join(
      fixture.repoRootPath,
      'teams',
      teamId,
      'team.yaml',
    )
    fs.writeFileSync(teamYamlPath, 'team:\n  name: test-team\n')

    await assert.rejects(
      () =>
        ensureTeamChatTarget(
          { teamId },
          {
            repoRootPath: fixture.repoRootPath,
            workflowsRegistryPath: fixture.workflowsRegistryPath,
          },
        ),
      (error: unknown) =>
        error instanceof TeamChatTargetError &&
        error.code === 'materialization_failed',
    )

    assert.equal(
      fs.existsSync(
        path.join(
          fixture.repoRootPath,
          'workflows',
          'user-generated',
          'team-chat-test-team-5e8a78eff975.yaml',
        ),
      ),
      false,
    )
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets do not publish into a malformed workflow registry', async () => {
  const fixture = createSchedulerFixture('team-chat-target-registry-invalid-')
  try {
    makeTeamUserInvocable(fixture.repoRootPath)
    fs.writeFileSync(
      fixture.workflowsRegistryPath,
      'broken:\n  description: Missing template path.\n',
    )

    await assert.rejects(
      () =>
        ensureTeamChatTarget(
          { teamId },
          {
            repoRootPath: fixture.repoRootPath,
            workflowsRegistryPath: fixture.workflowsRegistryPath,
          },
        ),
      (error: unknown) =>
        error instanceof TeamChatTargetError &&
        error.code === 'materialization_failed',
    )

    assert.equal(
      fs.existsSync(
        path.join(
          fixture.repoRootPath,
          'workflows',
          'user-generated',
          'team-chat-test-team-5e8a78eff975.yaml',
        ),
      ),
      false,
    )
    assert.doesNotMatch(
      fs.readFileSync(fixture.workflowsRegistryPath, 'utf8'),
      /team-chat-test-team/,
    )
  } finally {
    fixture.cleanup()
  }
})

test('team chat targets roll back template and registry publication failures', async () => {
  const fixture = createSchedulerFixture('team-chat-target-publish-rollback-')
  try {
    makeTeamUserInvocable(fixture.repoRootPath)
    const registryBefore = fs.readFileSync(fixture.workflowsRegistryPath, 'utf8')
    const expectedWorkflowId = 'team-chat-test-team-5e8a78eff975'
    const templatePath = path.join(
      fixture.repoRootPath,
      'workflows',
      'user-generated',
      `${expectedWorkflowId}.yaml`,
    )

    await assert.rejects(
      () =>
        ensureTeamChatTarget(
          { teamId },
          {
            repoRootPath: fixture.repoRootPath,
            workflowsRegistryPath: fixture.workflowsRegistryPath,
            onPersistenceBoundary: (boundary) => {
              if (boundary === 'after_registry_published') {
                throw new Error('injected publication failure')
              }
            },
          },
        ),
      (error: unknown) =>
        error instanceof TeamChatTargetError &&
        error.code === 'materialization_failed',
    )

    assert.equal(fs.existsSync(templatePath), false)
    assert.equal(
      fs.readFileSync(fixture.workflowsRegistryPath, 'utf8'),
      registryBefore,
    )
  } finally {
    fixture.cleanup()
  }
})

test('a discussion team wrapper leaves roster and round selection to the Team orchestrator', async () => {
  const repoRootPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'team-chat-target-discussion-'),
  )
  try {
    fs.cpSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'team-chat-e2e'),
      repoRootPath,
      { recursive: true },
    )
    const workflowsRegistryPath = path.join(
      repoRootPath,
      'workflows',
      'registry.yaml',
    )
    const boardTeamPath = path.join(
      repoRootPath,
      'teams',
      'board-team',
      'team.yaml',
    )
    fs.writeFileSync(
      boardTeamPath,
      fs
        .readFileSync(boardTeamPath, 'utf8')
        .replace('max_rounds: 1', 'max_rounds: 3')
        .replace(
          'levels:\n  - id: deliberation',
          [
            'levels:',
            '  - id: warmup',
            '    name: Warmup',
            '    order: 0',
            '    stage:',
            '      type: chain',
            '      sequence:',
            '        - board-lead',
            '      config:',
            '        handoff_format: markdown',
            '        constraints:',
            '          max_time_minutes: 2',
            '          agent_timeout_minutes: 1',
            '          max_budget_usd: 1',
            '        output:',
            '          format: warmup.md',
            '          user_review: false',
            '  - id: deliberation',
          ].join('\n'),
        )
        .replace(
          '  - id: deliberation\n    name: Deliberation\n    order: 0',
          '  - id: deliberation\n    name: Deliberation\n    order: 1',
        ),
    )

    const board = await ensureTeamChatTarget(
      { teamId: 'board-team' },
      { repoRootPath, workflowsRegistryPath },
    )
    const boardTemplate = parseWorkflowTemplateYaml(
      fs.readFileSync(
        path.join(
          repoRootPath,
          'workflows',
          'user-generated',
          `${board.workflowId}.yaml`,
        ),
        'utf8',
      ),
    )
    assert.ok(boardTemplate.template, boardTemplate.errors.join('; '))
    // The wrapper does not rewrite reusable Team workflow settings. Direct
    // Team-chat execution selects its roster and one-pass behavior separately.
    assert.equal(boardTemplate.template.steps[0]?.runtime_overrides, undefined)

    // A chain team has no roster to pin.
    const line = await ensureTeamChatTarget(
      { teamId: 'line-team' },
      { repoRootPath, workflowsRegistryPath },
    )
    const lineTemplate = parseWorkflowTemplateYaml(
      fs.readFileSync(
        path.join(
          repoRootPath,
          'workflows',
          'user-generated',
          `${line.workflowId}.yaml`,
        ),
        'utf8',
      ),
    )
    assert.ok(lineTemplate.template, lineTemplate.errors.join('; '))
    assert.equal(lineTemplate.template.steps[0]?.runtime_overrides, undefined)
  } finally {
    fs.rmSync(repoRootPath, { recursive: true, force: true })
  }
})
