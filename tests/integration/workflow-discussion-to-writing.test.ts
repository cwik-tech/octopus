import { whenDefined } from '../../core/optional-properties.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { runWorkflow } from '../../workflows/runner.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-discussion-to-writing-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('discussion-to-writing workflow executes sequentially, hands off the discussion artifact, and applies runtime overrides', async () => {
  await withTempDir(async (dir) => {
    const workflowRegistry = parseWorkflowRegistry(path.join(repoRoot, 'workflows', 'registry.yaml'))
    const teamRegistry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))

    assert.equal(workflowRegistry.errors.length, 0)
    assert.equal(teamRegistry.errors.length, 0)

    const workflowEntry = workflowRegistry.entries.find(
      (entry) => path.basename(entry.template_path) === 'discussion-to-writing.yaml',
    )
    assert.ok(workflowEntry)

    const calls: Array<{
      teamPath: string
      brief: string
      outputArtifact?: string
      runtimeOverrides?: import('../../core/types.js').TeamRuntimeOverrides
      workspacePathOverride?: string
    }> = []

    const result = await runWorkflow({
      workflowEntry: workflowEntry!,
      teamRegistry: new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Think through the problem, then write the final output.',
      workspacePath: path.join(repoRoot, 'workspace'),
      spawnDepth: 0,
      runTeamImpl: async (options) => {
        calls.push({
          teamPath: options.teamPath,
          brief: options.brief,
          ...whenDefined(options.outputArtifact, (outputArtifact) => ({ outputArtifact: outputArtifact })),
          ...whenDefined(options.runtimeOverrides, (runtimeOverrides) => ({ runtimeOverrides: runtimeOverrides })),
          ...whenDefined(options.workspacePathOverride, (workspacePathOverride) => ({ workspacePathOverride: workspacePathOverride })),
        })

        const assignmentPath = path.join(dir, `assignment-${calls.length}`)
        const artifactPath = path.join(assignmentPath, options.outputArtifact!)

        const artifactBody = calls.length === 1
          ? [
              '---',
              'artifact_type: "report"',
              '---',
              '# Discussion Summary',
              '',
              'Three-angle decomposition for the writing team.',
            ].join('\n')
          : [
              '---',
              'artifact_type: "report"',
              '---',
              '# Final Draft',
              '',
              'Written from the discussion summary.',
            ].join('\n')

        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, artifactBody)

        return {
          text: artifactBody,
          cost: calls.length === 1 ? 0.5 : 0.8,
          durationMs: 10,
          artifactPath,
          assignmentPath,
          childSessionId: `child-${calls.length}`,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(calls.length, 2)
    assert.match(calls[0]!.teamPath, /teams\/problem-thinking-board$/)
    assert.match(calls[1]!.teamPath, /teams\/writing-team$/)
    assert.equal(calls[0]!.workspacePathOverride, path.join(repoRoot, 'workspace'))
    assert.equal(calls[1]!.workspacePathOverride, path.join(repoRoot, 'workspace'))

    assert.deepEqual(
      calls[0]!.runtimeOverrides,
      {
        levels: {
          deliberation: {
            discussion: {
              participants: ['contrarian', 'pragmatist', 'domain-researcher'],
              min_rounds: 1,
              max_rounds: 1,
            },
          },
        },
      },
    )

    assert.deepEqual(
      calls[1]!.runtimeOverrides,
      {
        levels: {
          'editorial-review': {
            review: {
              max_iterations: 1,
            },
          },
        },
      },
    )

    assert.match(calls[1]!.brief, /Three-angle decomposition for the writing team\./)
    assert.equal(result.status, 'completed')
    assert.match(result.primaryArtifact || '', /final-draft\.md$/)
    assert.equal(result.steps.length, 2)
  })
})

test('workflow runner executes selected team stages and hosted agents through runtime overrides', async () => {
  await withTempDir(async (dir) => {
    const teamRegistryResult = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
    assert.equal(teamRegistryResult.errors.length, 0)
    const templatePath = path.join(dir, 'visual-workflow.yaml')
    fs.writeFileSync(templatePath, `
workflow:
  id: visual-workflow
  input:
    artifact: incoming-request.md
  steps:
    - id: discuss
      type: team
      team: problem-thinking-board
      stage_type: discussion
      input_artifact: incoming-brief.md
      result_artifact: output/decomposition-plan.md
    - id: draft
      type: agent
      team: writing-team
      agent: writer
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: draft-package.md
      handoff:
        from_step: discuss
        from_artifact: output/decomposition-plan.md
        to_artifact: incoming-brief.md
  output:
    from_step: draft
    artifact: draft-package.md
  on_blocked: stop
  on_failed: stop
`)

    const calls: import('../../core/types.js').TeamRunOptions[] = []
    const agentCalls: import('../../core/types.js').AgentRunOptions[] = []
    const assignmentLocation = buildSessionRunAssignmentLocation(dir, {
      sessionId: 'visual-session',
      runId: 'visual-run',
      assignmentId: 'visual-run',
    })
    assert.ok(assignmentLocation)
    const result = await runWorkflow({
      workflowEntry: { name: 'visual-workflow', template_path: templatePath },
      teamRegistry: new Map(teamRegistryResult.entries.map((entry) => [entry.name, entry])),
      brief: 'Build a visual multi-step workflow.',
      workspacePath: dir,
      spawnDepth: 0,
      rootSessionId: 'visual-run',
      assignmentLocation,
      runTeamImpl: async (options) => {
        calls.push(options)
        const assignmentPath = path.join(dir, `visual-step-${calls.length}`)
        const artifactPath = path.join(assignmentPath, options.outputArtifact!)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, `# Output ${calls.length}`)
        return {
          text: `# Output ${calls.length}`,
          cost: 0,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: `visual-child-${calls.length}`,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
      runAgentImpl: async (options) => {
        agentCalls.push(options)
        return {
          text: '# Agent draft\n\nDrafted from the discussion output.',
          cost: 0,
          durationMs: 1,
          inputTokens: 10,
          outputTokens: 10,
          contextTokens: 20,
          model: options.model,
          costTracked: true,
        }
      },
    })

    assert.equal(result.status, 'completed')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.runtimeOverrides, { stage_type: 'discussion' })
    assert.equal(agentCalls.length, 1)
    assert.equal(agentCalls[0]?.agentName, 'writer')
    assert.equal(
      agentCalls[0]?.workerEnvironment?.TEAM_RUNTIME_WORKFLOW_STEP_ID,
      'draft',
    )
    assert.equal(
      agentCalls[0]?.workerEnvironment?.TEAM_RUNTIME_ASSIGNMENT_ID,
      agentCalls[0]?.sessionId,
    )
    assert.match(agentCalls[0]?.userMessage ?? '', /workflow chain/)
    assert.match(agentCalls[0]?.userMessage ?? '', /Output 1/)
  })
})

test('workflow runner enforces output artifacts and exposes escalation policy', async () => {
  await withTempDir(async (dir) => {
    const teamRegistryResult = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
    assert.equal(teamRegistryResult.errors.length, 0)
    const teamRegistry = new Map(teamRegistryResult.entries.map((entry) => [entry.name, entry]))

    const templatePath = path.join(dir, 'contract-workflow.yaml')
    const writeTemplate = (onFailed: string, onBlocked: string) => fs.writeFileSync(templatePath, `
workflow:
  id: contract-workflow
  steps:
    - id: write
      type: team
      team: writing-team
      input_artifact: incoming-brief.md
      result_artifact: final-draft.md
  output:
    from_step: write
    artifact: final-draft.md
  on_failed: ${onFailed}
  on_blocked: ${onBlocked}
`)

    writeTemplate('escalate_to_user', 'stop')
    const assignmentPath = path.join(dir, 'missing-output-assignment')
    fs.mkdirSync(assignmentPath, { recursive: true })
    const missingOutput = await runWorkflow({
      workflowEntry: { name: 'contract-workflow', template_path: templatePath },
      teamRegistry,
      brief: 'Write the requested document.',
      workspacePath: dir,
      spawnDepth: 0,
      runTeamImpl: async () => ({
        text: 'Child claimed success without an artifact.',
        cost: 0,
        durationMs: 1,
        artifactPath: '',
        assignmentPath,
        childSessionId: 'child-missing-output',
        status: 'completed',
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }),
    })
    assert.equal(missingOutput.status, 'failed')
    assert.match(missingOutput.summary, /expected artifact 'final-draft\.md' was not produced/)
    assert.deepEqual(missingOutput.escalation, {
      target: 'user',
      stepId: 'write',
      reason: 'failed',
    })

    writeTemplate('stop', 'escalate_to_user')
    const blocked = await runWorkflow({
      workflowEntry: { name: 'contract-workflow', template_path: templatePath },
      teamRegistry,
      brief: 'Write the requested document.',
      workspacePath: dir,
      spawnDepth: 0,
      runTeamImpl: async () => ({
        text: 'Structured blocker.',
        cost: 0,
        durationMs: 1,
        artifactPath: '',
        assignmentPath,
        childSessionId: 'child-blocked',
        status: 'blocked',
        succeeded: false,
        exitCode: 1,
        exitSignal: null,
      }),
    })
    assert.equal(blocked.status, 'blocked')
    assert.deepEqual(blocked.escalation, {
      target: 'user',
      stepId: 'write',
      reason: 'blocked',
    })
  })
})

test('workflow runner passes remaining hard budget to each real workflow step', async () => {
  await withTempDir(async (dir) => {
    const workflowRegistry = parseWorkflowRegistry(path.join(repoRoot, 'workflows', 'registry.yaml'))
    const teamRegistryResult = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
    assert.equal(workflowRegistry.errors.length, 0)
    assert.equal(teamRegistryResult.errors.length, 0)
    const workflowEntry = workflowRegistry.entries.find(
      (entry) => path.basename(entry.template_path) === 'discussion-to-writing.yaml',
    )
    assert.ok(workflowEntry)

    const budgets: Array<number | undefined> = []
    let calls = 0
    const result = await runWorkflow({
      workflowEntry: workflowEntry!,
      teamRegistry: new Map(teamRegistryResult.entries.map((entry) => [entry.name, entry])),
      brief: 'Produce a budgeted discussion and final draft.',
      workspacePath: dir,
      spawnDepth: 0,
      budgetUsd: 10,
      budgetPolicy: 'halt',
      runTeamImpl: async (options) => {
        calls += 1
        budgets.push(options.budgetUsd)
        const assignmentPath = path.join(dir, `budget-step-${calls}`)
        const artifactPath = path.join(assignmentPath, options.outputArtifact!)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, `# Step ${calls}\n\nBudgeted output.`)
        return {
          text: fs.readFileSync(artifactPath, 'utf8'),
          cost: 6,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: `budget-child-${calls}`,
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.deepEqual(budgets, [10, 4])
    assert.equal(calls, 2)
    assert.equal(result.totalCost, 12)
    assert.equal(result.status, 'failed')
    assert.match(result.summary, /budget limit reached after step/i)
  })
})

test('workflow runner fails closed when a hard-budget child has untracked cost', async () => {
  await withTempDir(async (dir) => {
    const workflowRegistry = parseWorkflowRegistry(path.join(repoRoot, 'workflows', 'registry.yaml'))
    const teamRegistryResult = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
    const workflowEntry = workflowRegistry.entries.find(
      (entry) => path.basename(entry.template_path) === 'discussion-to-writing.yaml',
    )
    assert.ok(workflowEntry)
    let calls = 0

    const result = await runWorkflow({
      workflowEntry: workflowEntry!,
      teamRegistry: new Map(teamRegistryResult.entries.map((entry) => [entry.name, entry])),
      brief: 'Stop when child cost cannot be priced.',
      workspacePath: dir,
      spawnDepth: 0,
      budgetUsd: 10,
      budgetPolicy: 'halt',
      runTeamImpl: async (options) => {
        calls += 1
        const assignmentPath = path.join(dir, 'untracked-step')
        const artifactPath = path.join(assignmentPath, options.outputArtifact!)
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, '# Untracked output')
        return {
          text: '# Untracked output',
          cost: 0,
          costTracked: false,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: 'untracked-child',
          ...whenDefined(options.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed',
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })

    assert.equal(calls, 1)
    assert.equal(result.status, 'failed')
    assert.match(result.summary, /did not report a tracked USD cost/i)
  })
})
