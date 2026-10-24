import test from 'node:test'
import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { resolveAssignmentPath } from '../../domains/runtime/runtime-paths.js'
import { runWorkflow } from '../../workflows/runner.js'
import {
  FileSystemWorkflowStateStore,
  hashWorkflowContent,
} from '../../workflows/workflow-state-store.js'

const repoRoot = process.cwd()

function fixture(): {
  rootPath: string
  templatePath: string
  teamRegistry: ReturnType<typeof parseTeamRegistry>['entries']
} {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-terminal-outcome-'))
  const templatePath = path.join(rootPath, 'workflow.yaml')
  fs.writeFileSync(templatePath, [
    'workflow:',
    '  id: terminal-outcome-test',
    '  steps:',
    '    - id: write',
    '      type: team',
    '      team: writing-team',
    '      input_artifact: incoming-brief.md',
    '      result_artifact: final-draft.md',
    '      requested_result_type: artifact:final-draft.md',
    '      recovery_policy: manual',
    '  output:',
    '    from_step: write',
    '    artifact: final-draft.md',
    '  on_blocked: escalate_to_user',
    '  on_failed: escalate_to_user',
    '',
  ].join('\n'))
  const registry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  assert.deepEqual(registry.errors, [])
  return { rootPath, templatePath, teamRegistry: registry.entries }
}

function options(params: {
  rootPath: string
  templatePath: string
  teamRegistry: ReturnType<typeof parseTeamRegistry>['entries']
  attemptId?: string
}) {
  return {
    workflowEntry: {
      name: 'terminal-outcome-test',
      template_path: params.templatePath,
    },
    teamRegistry: new Map(params.teamRegistry.map((entry) => [entry.name, entry])),
    brief: 'Write a durable result.',
    workspacePath: params.rootPath,
    spawnDepth: 0,
    rootSessionId: 'root-run',
    parentSessionId: 'root-run',
    taskId: 'task-one',
    productSessionId: 'session-one',
    executionAttemptId: params.attemptId ?? 'attempt-one',
  }
}

test('success atomically commits a content-addressed terminal outcome and reuses it', async () => {
  const current = fixture()
  try {
    let calls = 0
    const first = await runWorkflow({
      ...options(current),
      runTeamImpl: async (runOptions) => {
        calls += 1
        const assignmentPath = resolveAssignmentPath(
          current.rootPath,
          runOptions.childSessionId!,
        )
        const artifactPath = path.join(assignmentPath, 'final-draft.md')
        fs.mkdirSync(assignmentPath, { recursive: true })
        fs.writeFileSync(artifactPath, '# Durable final draft\n')
        return {
          text: '# Durable final draft\n',
          cost: 1.5,
          costTracked: true,
          durationMs: 1,
          artifactPath,
          assignmentPath,
          childSessionId: runOptions.childSessionId!,
          ...whenDefined(runOptions.requestedResultType, (requestedResultType) => ({ requestedResultType })),
          status: 'completed' as const,
          succeeded: true,
          exitCode: 0,
          exitSignal: null,
        }
      },
    })
    const store = new FileSystemWorkflowStateStore(
      resolveAssignmentPath(current.rootPath, 'root-run'),
    )
    const terminal = (await store.requireSnapshot()).state
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.terminalOutcome?.status, 'completed')
    assert.equal(terminal.terminalOutcome?.outputStepId, 'write')
    assert.equal(
      terminal.terminalOutcome?.requestedResultType,
      'artifact:final-draft.md',
    )
    assert.equal(
      terminal.terminalOutcome?.primaryArtifact?.sha256,
      hashWorkflowContent('# Durable final draft\n'),
    )
    assert.equal(
      terminal.terminalOutcome?.rootWrapperSha256,
      hashWorkflowContent(terminal.terminalOutcome!.rootWrapperBody),
    )
    assert.match(terminal.terminalOutcome!.rootWrapperBody, /# Workflow Result/)

    const recovered = await runWorkflow({
      ...options({ ...current, attemptId: 'attempt-two' }),
      recoveryMode: true,
      runTeamImpl: async () => {
        calls += 1
        throw new Error('A terminal workflow must not rerun its child.')
      },
    })
    assert.equal(calls, 1)
    assert.equal(recovered.status, first.status)
    assert.equal(recovered.summary, first.summary)
    assert.equal(recovered.primaryArtifact, first.primaryArtifact)
  } finally {
    fs.rmSync(current.rootPath, { recursive: true, force: true })
  }
})

test('an exception commits failed status and wrapper outcome in one revision', async () => {
  const current = fixture()
  try {
    await assert.rejects(
      runWorkflow({
        ...options(current),
        runTeamImpl: async (runOptions) => {
          fs.mkdirSync(
            resolveAssignmentPath(current.rootPath, runOptions.childSessionId!),
            { recursive: true },
          )
          throw new Error('Provider process exited unexpectedly.')
        },
      }),
      /Provider process exited unexpectedly/,
    )
    const terminal = (
      await new FileSystemWorkflowStateStore(
        resolveAssignmentPath(current.rootPath, 'root-run'),
      ).requireSnapshot()
    ).state
    assert.equal(terminal.status, 'failed')
    assert.equal(terminal.terminalOutcome?.status, 'failed')
    assert.match(terminal.terminalOutcome?.summary ?? '', /Provider process exited unexpectedly/)
    assert.match(terminal.terminalOutcome?.rootWrapperBody ?? '', /Status: failed/)
  } finally {
    fs.rmSync(current.rootPath, { recursive: true, force: true })
  }
})

test('blocked, budget, and output-contract terminal paths commit outcomes atomically', async (t) => {
  for (const scenario of ['blocked', 'budget', 'output-contract'] as const) {
    await t.test(scenario, async () => {
      const current = fixture()
      try {
        const result = await runWorkflow({
          ...options(current),
          ...(scenario === 'budget'
            ? { budgetUsd: 1, budgetPolicy: 'halt' as const }
            : {}),
          runTeamImpl: async (runOptions) => {
            const assignmentPath = resolveAssignmentPath(
              current.rootPath,
              runOptions.childSessionId!,
            )
            fs.mkdirSync(assignmentPath, { recursive: true })
            const artifactPath = path.join(assignmentPath, 'final-draft.md')
            if (scenario !== 'output-contract') {
              fs.writeFileSync(artifactPath, '# Scenario result\n')
            }
            return {
              text: scenario === 'blocked' ? 'Waiting for user input.' : '# Scenario result\n',
              cost: scenario === 'budget' ? 2 : 0,
              costTracked: true,
              durationMs: 1,
              artifactPath: scenario === 'output-contract' ? '' : artifactPath,
              assignmentPath,
              childSessionId: runOptions.childSessionId!,
              ...whenDefined(runOptions.requestedResultType, (requestedResultType) => ({ requestedResultType })),
              status: scenario === 'blocked' ? 'blocked' as const : 'completed' as const,
              succeeded: scenario !== 'blocked',
              exitCode: scenario === 'blocked' ? 1 : 0,
              exitSignal: null,
            }
          },
        })
        const state = (
          await new FileSystemWorkflowStateStore(
            resolveAssignmentPath(current.rootPath, 'root-run'),
          ).requireSnapshot()
        ).state
        assert.equal(state.status, result.status)
        assert.equal(state.terminalOutcome?.status, result.status)
        assert.equal(state.terminalOutcome?.summary, result.summary)
        assert.equal(state.terminalOutcome?.outputStepId, 'write')
        assert.equal(state.terminalOutcome?.primaryArtifact, undefined)
        if (scenario === 'blocked') assert.equal(result.status, 'blocked')
        if (scenario === 'budget') assert.match(result.summary, /budget limit reached/i)
        if (scenario === 'output-contract') {
          assert.match(result.summary, /expected artifact 'final-draft\.md'/)
        }
      } finally {
        fs.rmSync(current.rootPath, { recursive: true, force: true })
      }
    })
  }
})
