import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { runWorkflow, type WorkflowRunnerOptions } from '../../workflows/runner.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import type { WorkflowExecutionResult } from '../../workflows/types.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import {
  rebuildWorkflowStateProjection,
  WORKFLOW_STATE_STREAM_KIND,
} from '../../workflows/workflow-journal.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

/**
 * Phase 5 cutover acceptance (ADR §9). The existing journal tests drive the
 * store directly, so nothing observes whether the production runner journals
 * its own transitions. This drives `runWorkflow` and then rebuilds the
 * workflow state from the journal alone.
 *
 * AC9 adds the other half of the same journey: the projection is derived, so
 * losing it must not lose the run. A workflow whose `workflow-state.json` is
 * deleted or truncated resumes through the production load path, rebuilding
 * from the canonical journal rather than failing the task.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

const SCOPE = {
  sessionId: 'session-runner-journal',
  runId: 'run-runner-journal',
  assignmentId: 'run-runner-journal',
} as const

type RunTeamImpl = NonNullable<WorkflowRunnerOptions['runTeamImpl']>

interface JournaledWorkflowFixture {
  readonly registry: WorkspaceExecutionJournalRegistry
  readonly store: FileSystemWorkflowStateStore
  /** Workflow step ids the fake team was asked to execute, in order. */
  readonly stepCalls: () => readonly string[]
  run(overrides?: {
    executionAttemptId?: string
    recoveryMode?: boolean
    runTeamImpl?: RunTeamImpl
    /** Runs inside the team call, before the step's receipt is written. */
    onTeamCall?: (stepId: string) => void
  }): Promise<WorkflowExecutionResult>
  workflowEventCount(): Promise<number>
}

/**
 * Drive the real runner against a real workspace, journal registry, and
 * assignment layout. The fake team only writes the artifact the runner
 * allocated for it; everything durable is production code.
 */
async function withJournaledWorkflow(
  body: (fixture: JournaledWorkflowFixture) => Promise<void>,
): Promise<void> {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-runner-journal-')),
  )
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'tenant-runner-journal',
    mode: 'authoritative',
  })
  try {
    const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })

    const workflowRegistry = parseWorkflowRegistry(
      path.join(repoRoot, 'workflows', 'registry.yaml'),
    )
    const teamRegistry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
    assert.equal(workflowRegistry.errors.length, 0)
    assert.equal(teamRegistry.errors.length, 0)
    const workflowEntry = workflowRegistry.entries.find(
      (entry) => path.basename(entry.template_path) === 'discussion-to-writing.yaml',
    )
    assert.ok(workflowEntry)

    const stepCalls: string[] = []
    let onTeamCall: ((stepId: string) => void) | undefined
    const writeAllocatedArtifact: RunTeamImpl = async (options) => {
      stepCalls.push(options.workflowStepId ?? '')
      // Durable execution owns child identity: the runner allocates the
      // child run id and its assignment path, and refuses a result that
      // does not match. The fake team adopts what it was given.
      const childRunId = options.childSessionId
      assert.ok(childRunId, 'durable runner must supply the child run id')
      const childLocation = buildSessionRunAssignmentLocation(workspacePath, {
        sessionId: SCOPE.sessionId,
        runId: SCOPE.runId,
        assignmentId: childRunId,
      })
      assert.ok(childLocation)
      const assignmentPath = childLocation.assignmentPath
      fs.mkdirSync(assignmentPath, { recursive: true })
      const artifactPath = path.join(assignmentPath, options.outputArtifact ?? 'out.md')
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
      fs.writeFileSync(
        artifactPath,
        ['---', 'artifact_type: "report"', '---', '', '# Output', '', 'Body.', ''].join('\n'),
        'utf8',
      )
      onTeamCall?.(options.workflowStepId ?? '')
      return {
        text: 'Body.',
        cost: 0,
        durationMs: 5,
        artifactPath,
        assignmentPath,
        childSessionId: childRunId,
        succeeded: true,
        exitCode: 0,
        exitSignal: null,
      }
    }

    await body({
      registry,
      store: new FileSystemWorkflowStateStore(location.assignmentPath),
      stepCalls: () => [...stepCalls],
      run: (overrides = {}) => {
        onTeamCall = overrides.onTeamCall
        return runWorkflow({
          workflowEntry,
          teamRegistry: new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
          brief: 'Journal this workflow.',
          workspacePath,
          spawnDepth: 0,
          persistenceMode: 'required',
          rootSessionId: SCOPE.runId,
          taskId: 'task-runner-journal',
          productSessionId: SCOPE.sessionId,
          assignmentLocation: location,
          executionAttemptId: overrides.executionAttemptId ?? 'attempt-runner-journal',
          journalRegistry: registry,
          runTeamImpl: overrides.runTeamImpl ?? writeAllocatedArtifact,
          ...(overrides.recoveryMode ? { recoveryMode: true } : {}),
        })
      },
      workflowEventCount: async () => {
        const read = await readExecutionJournal(location.assignmentPath)
        assert.equal(read.kind, 'ok', 'the runner must have opened a journal')
        if (read.kind !== 'ok') return 0
        return read.events.filter(
          (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
        ).length
      },
    })
  } finally {
    await registry.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
}

test('the workflow runner journals its transitions, and the state rebuilds from the journal', async () => {
  await withJournaledWorkflow(async (fixture) => {
    const result = await fixture.run()
    assert.ok(
      ['completed', 'completed_with_warnings'].includes(result.status),
      `workflow did not complete: ${JSON.stringify(result)}`,
    )

    // The journal must actually hold the workflow stream the runner produced.
    assert.ok(
      (await fixture.workflowEventCount()) > 0,
      'the runner must journal its workflow transitions',
    )

    // ADR §9: the state file is a projection, so it rebuilds from the journal.
    const before = await fixture.store.requireSnapshot()
    fs.rmSync(fixture.store.paths.statePath)

    const journal = await fixture.registry.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: 'rebuild',
        sessionId: SCOPE.sessionId,
        runId: SCOPE.runId,
        assignmentId: SCOPE.assignmentId,
        agentPath: 'agents/rebuild',
        authority: { kind: 'runtime-assignment', processIdentity: 'rebuild' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(journal)
    await rebuildWorkflowStateProjection(journal, fixture.store)

    const after = await fixture.store.requireSnapshot()
    assert.deepEqual(after.state, before.state)
  })
})

/**
 * AC9. `workflow-state.json` is derived, so losing it mid-run must not lose the
 * run. Each journey damages the projection while the workflow is genuinely
 * unfinished — the first step's team has run and its receipt is about to be
 * written — and then resumes through the production runner. The completed step
 * is adopted from its durable receipt rather than executed again, and the
 * remaining step runs for the first time.
 */
async function assertProjectionDamageStopsTheRun(
  run: Promise<WorkflowExecutionResult>,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /workflow (state|execution)/i)
    return true
  })
}

test('a journaled workflow resumes mid-run after its state projection is deleted', async () => {
  await withJournaledWorkflow(async (fixture) => {
    await assertProjectionDamageStopsTheRun(
      fixture.run({
        onTeamCall: (stepId) => {
          if (stepId === 'discuss') fs.rmSync(fixture.store.paths.statePath)
        },
      }),
    )
    assert.deepEqual(fixture.stepCalls(), ['discuss'])
    assert.equal(fs.existsSync(fixture.store.paths.statePath), false)
    const journaledEvents = await fixture.workflowEventCount()
    assert.ok(journaledEvents > 0, 'the interrupted run must have journaled its progress')

    const resumed = await fixture.run({
      executionAttemptId: 'attempt-runner-journal-resume',
      recoveryMode: true,
    })

    assert.ok(
      ['completed', 'completed_with_warnings'].includes(resumed.status),
      `the resumed workflow did not complete: ${JSON.stringify(resumed)}`,
    )
    assert.deepEqual(
      fixture.stepCalls(),
      ['discuss', 'write'],
      'the completed step must be adopted from its receipt, not executed again',
    )
    const finished = await fixture.store.requireSnapshot()
    assert.equal(finished.state.status, 'completed')
    assert.equal(finished.state.recoveryCount, 1)
    assert.deepEqual(
      finished.state.steps.map((step) => step.status),
      ['completed', 'completed'],
    )
    assert.ok(
      (await fixture.workflowEventCount()) > journaledEvents,
      'the resumed run must keep journaling its own transitions',
    )
  })
})

test('a journaled workflow resumes mid-run after its state projection is truncated to invalid JSON', async () => {
  await withJournaledWorkflow(async (fixture) => {
    await assertProjectionDamageStopsTheRun(
      fixture.run({
        onTeamCall: (stepId) => {
          if (stepId === 'discuss') {
            fs.writeFileSync(fixture.store.paths.statePath, '{broken-json')
          }
        },
      }),
    )
    assert.deepEqual(fixture.stepCalls(), ['discuss'])
    assert.equal(
      fs.readFileSync(fixture.store.paths.statePath, 'utf8'),
      '{broken-json',
    )

    const resumed = await fixture.run({
      executionAttemptId: 'attempt-runner-journal-truncated-resume',
      recoveryMode: true,
    })

    assert.ok(
      ['completed', 'completed_with_warnings'].includes(resumed.status),
      `the resumed workflow did not complete: ${JSON.stringify(resumed)}`,
    )
    assert.deepEqual(
      fixture.stepCalls(),
      ['discuss', 'write'],
      'the completed step must be adopted from its receipt, not executed again',
    )
    const finished = await fixture.store.requireSnapshot()
    assert.equal(finished.state.status, 'completed')
    assert.equal(finished.state.recoveryCount, 1)
  })
})
