import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { runWorkflow } from '../../workflows/runner.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import { WORKFLOW_STATE_STREAM_KIND } from '../../workflows/workflow-journal.js'
import { createWorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

/**
 * AC4: authority is sticky per assignment (ADR §16). Once an assignment holds
 * canonical events it is consulted whatever the flag says — the flag governs
 * enrollment of *new* assignments only.
 *
 * The parent process honours that: it always builds a registry and lets
 * `resolveJournal` decide per assignment. The task worker did not. It called
 * `createWorkspaceExecutionJournalRegistry`, which returned `undefined` for a
 * disabled flag, so `resolveWorkflowJournal` short-circuited *before any
 * enrollment check* and the store was built with no recorder. A workflow that
 * had enrolled therefore fell silently back to the snapshot-first authority —
 * the split ADR §16 exists to forbid.
 *
 * **This file is inner coverage.** It drives the production factory and the
 * production runner in one process; it does not restart a worker. AC4's outer
 * acceptance journey — two real worker processes, a crash, a resume with
 * enrolment turned off, and a rebuild from the journal — lives in
 * `tests/integration/durable-workflow-process-recovery.test.ts`
 * ("an enrolled workflow keeps journaling across a real worker restart with
 * enrolment turned off"), because that file already owns the real-process
 * harness.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

const TASK_ID = 'task-authority-restart'

const SCOPE = {
  sessionId: 'session-authority-restart',
  runId: 'run-authority-restart',
  assignmentId: 'run-authority-restart',
} as const

function withFlag(
  t: { after: (fn: () => unknown) => void },
  value: string | undefined,
): void {
  const previousFlag = process.env.PIPELINE_DURABLE_JOURNAL
  const previousTenant = process.env.TEAM_TENANT_ID
  if (value === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
  else process.env.PIPELINE_DURABLE_JOURNAL = value
  process.env.TEAM_TENANT_ID = 'tenant-authority-restart'
  t.after(() => {
    if (previousFlag === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
    else process.env.PIPELINE_DURABLE_JOURNAL = previousFlag
    if (previousTenant === undefined) delete process.env.TEAM_TENANT_ID
    else process.env.TEAM_TENANT_ID = previousTenant
  })
}

/** A fake team that adopts the child identity the durable runner allocates. */
function makeRunTeamImpl(workspacePath: string) {
  return async (options: {
    childSessionId?: string
    outputArtifact?: string
  }) => {
    const childRunId = options.childSessionId
    assert.ok(childRunId, 'the durable runner must supply the child run id')
    const childLocation = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: SCOPE.sessionId,
      runId: SCOPE.runId,
      assignmentId: childRunId,
    })
    assert.ok(childLocation)
    const assignmentPath = childLocation.assignmentPath
    fs.mkdirSync(assignmentPath, { recursive: true })
    const artifactPath = path.join(
      assignmentPath,
      options.outputArtifact ?? 'out.md',
    )
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(
      artifactPath,
      ['---', 'artifact_type: "report"', '---', '', '# Output', '', 'Body.', ''].join('\n'),
      'utf8',
    )
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
}

async function runOnce(
  workspacePath: string,
  taskId: string,
  attemptId: string,
): Promise<void> {
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  const workflowRegistry = parseWorkflowRegistry(
    path.join(repoRoot, 'workflows', 'registry.yaml'),
  )
  const teamRegistry = parseTeamRegistry(path.join(repoRoot, 'teams.yaml'))
  const workflowEntry = workflowRegistry.entries.find(
    (entry) => path.basename(entry.template_path) === 'discussion-to-writing.yaml',
  )
  assert.ok(workflowEntry)

  // Exactly what the task worker does: resolve a registry from the ambient
  // configuration, then hand whatever it produced to the runner.
  const registry = createWorkspaceExecutionJournalRegistry(workspacePath)
  try {
    const result = await runWorkflow({
      workflowEntry,
      teamRegistry: new Map(teamRegistry.entries.map((entry) => [entry.name, entry])),
      brief: 'Journal across a restart.',
      workspacePath,
      spawnDepth: 0,
      persistenceMode: 'required',
      rootSessionId: SCOPE.runId,
      taskId,
      productSessionId: SCOPE.sessionId,
      assignmentLocation: location,
      executionAttemptId: attemptId,
      ...(registry ? { journalRegistry: registry } : {}),
      runTeamImpl: makeRunTeamImpl(workspacePath),
    })
    assert.ok(
      ['completed', 'completed_with_warnings'].includes(result.status),
      `workflow did not complete: ${JSON.stringify(result)}`,
    )
  } finally {
    await registry?.close()
  }
}

test('the registry a restarted worker builds resolves an enrolled assignment with enrolment turned off', async (t) => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-authority-restart-')),
  )
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }))
  const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
  assert.ok(location)

  // First worker: the flag is on, so the assignment enrols.
  withFlag(t, 'authoritative')
  await runOnce(workspacePath, TASK_ID, 'attempt-authority-one')

  const enrolled = await readExecutionJournal(location.assignmentPath)
  assert.equal(enrolled.kind, 'ok', 'the first run must enrol the assignment')
  if (enrolled.kind !== 'ok') return
  const eventsAfterFirstRun = enrolled.events.filter(
    (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
  ).length
  assert.ok(eventsAfterFirstRun > 0, 'the first run must journal its transitions')

  // The worker restarts with enrolment turned off. Re-running a *completed*
  // workflow legitimately journals nothing more, so the observable is the seam
  // that actually broke: the registry a restarted worker builds must resolve
  // this assignment's journal, because that is what decides whether the
  // workflow store gets a recorder at all (`workflows/runner.ts` →
  // `resolveWorkflowJournal`).
  //
  // Stated explicitly rather than by deleting the flag: since A-14 an absent
  // flag means `authoritative`, which would resolve the journal for the
  // ordinary reason and prove nothing about stickiness.
  process.env.PIPELINE_DURABLE_JOURNAL = 'disabled'

  const restarted = createWorkspaceExecutionJournalRegistry(workspacePath)
  try {
    const journal = await restarted.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: 'workflow-restart',
        sessionId: SCOPE.sessionId,
        runId: SCOPE.runId,
        assignmentId: SCOPE.assignmentId,
        agentPath: 'workflows/runner',
        authority: {
          kind: 'runtime-assignment',
          processIdentity: 'attempt-authority-two',
        },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    })
    assert.ok(
      journal,
      'an enrolled assignment must resolve its journal with the flag off, or ' +
        'the restarted worker silently returns it to the snapshot-first authority',
    )

    // The same registry must still refuse to enrol anything new.
    const freshAssignment = buildSessionRunAssignmentLocation(workspacePath, {
      sessionId: SCOPE.sessionId,
      runId: SCOPE.runId,
      assignmentId: 'assignment-never-enrolled',
    })
    assert.ok(freshAssignment)
    fs.mkdirSync(freshAssignment.assignmentPath, { recursive: true })
    const fresh = await restarted.resolve({
      context: {
        contractVersion: 1,
        requestId: 'request-fresh',
        sessionId: SCOPE.sessionId,
        runId: SCOPE.runId,
        assignmentId: 'assignment-never-enrolled',
        agentPath: 'agents/probe',
        authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    assert.equal(fresh, undefined, 'the flag still governs new enrollment')
  } finally {
    await restarted.close()
  }

  // And the enrolled workflow's state is still the journal's to rebuild.
  const store = new FileSystemWorkflowStateStore(location.assignmentPath)
  const snapshot = await store.requireSnapshot()
  assert.equal(snapshot.state.taskId, TASK_ID)
})

test('a disabled flag still enrols nothing new, and still resolves what is enrolled', async (t) => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-authority-disabled-')),
  )
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }))
  withFlag(t, 'disabled')

  const registry = createWorkspaceExecutionJournalRegistry(workspacePath)
  assert.ok(
    registry,
    'a disabled flag must still produce a registry, or nothing consults the ' +
      'enrollment marker and sticky authority silently stops applying',
  )
  try {
    const location = buildSessionRunAssignmentLocation(workspacePath, SCOPE)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })

    const unenrolled = await registry.resolve({
      context: {
        contractVersion: 1,
        requestId: 'request-disabled',
        sessionId: SCOPE.sessionId,
        runId: SCOPE.runId,
        assignmentId: SCOPE.assignmentId,
        agentPath: 'agents/probe',
        authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    assert.equal(
      unenrolled,
      undefined,
      'a disabled flag must not enrol a new assignment',
    )
    assert.equal(
      fs.existsSync(
        path.join(location.assignmentPath, '.runtime', 'execution-journal'),
      ),
      false,
      'and must create no journal directory at all',
    )
  } finally {
    await registry.close()
  }
})
