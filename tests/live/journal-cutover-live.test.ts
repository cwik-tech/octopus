import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { readExecutionJournal } from '../../core/execution-journal.js'
import { parseTeamRegistry } from '../../parsers/team-registry.js'
import { DURABLE_DISPATCH_STREAM_KIND } from '../../core/durable-dispatch.js'
import { parseWorkflowRegistry } from '../../workflows/loader.js'
import { runWorkflow } from '../../workflows/runner.js'
import {
  rebuildWorkflowStateProjection,
  WORKFLOW_STATE_STREAM_KIND,
} from '../../workflows/workflow-journal.js'
import { FileSystemWorkflowStateStore } from '../../workflows/workflow-state-store.js'
import { createWorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import {
  attributeCanaryOutcome,
  parseArmOutcome,
  type CanaryArmOutcome,
} from './journal-canary-attribution.js'
import { seedCanaryRuntimeAuthority } from './journal-canary-authority.js'

/**
 * The durable execution journal against real providers (Phase 8 cutover).
 *
 * Everything else that exercises the journal substitutes the team runner, so
 * no test has ever run a real provider-backed workflow with
 * `PIPELINE_DURABLE_JOURNAL=authoritative`. The offline suite proves the journal
 * is correct; this proves the product still works with it switched on.
 *
 * Opt-in and costed: it spends real provider credit. Run with
 *   PIPELINE_LIVE_JOURNAL_CUTOVER=1 npm run test:live:journal-cutover
 */

const REPO_ROOT = process.cwd()
const WORKFLOW_ID = 'discussion-to-writing3'
const MODE = process.env.PIPELINE_LIVE_JOURNAL_CUTOVER
const ENABLED = MODE === '1' || MODE === 'control'
/**
 * `control` runs the identical workflow with the journal OFF. Without it, a
 * provider-side failure and a journal-caused failure look the same, and the
 * whole point of this test is to tell them apart.
 */
const CONTROL = MODE === 'control'

/**
 * Where each arm records how it ended, so the four-case attribution rule can be
 * applied (AC15). No arm can reach a verdict alone: it holds only its own
 * outcome. The journal arm, run second, reads the control arm's record and
 * prints the verdict.
 */
const OUTCOME_DIR = process.env.PIPELINE_CANARY_OUTCOME_DIR

function recordArmOutcome(
  arm: 'control' | 'journal',
  outcome: CanaryArmOutcome,
): void {
  process.stdout.write(`canary arm ${arm}: ${JSON.stringify(outcome)}\n`)
  if (!OUTCOME_DIR) return
  fs.mkdirSync(OUTCOME_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUTCOME_DIR, `${arm}.json`),
    `${JSON.stringify(outcome)}\n`,
    { mode: 0o600 },
  )
}

/**
 * The other arm's recorded outcome, when it has already run.
 *
 * Absence is normal — the first arm has no counterpart yet — and returns null.
 * A file that exists but cannot be read as an outcome is not absence: it is
 * corruption, and `parseArmOutcome` throws a diagnostic naming the arm rather
 * than letting the gate report a verdict from data it did not understand.
 */
function readArmOutcome(arm: 'control' | 'journal'): CanaryArmOutcome | null {
  if (!OUTCOME_DIR) return null
  let raw: string
  try {
    raw = fs.readFileSync(path.join(OUTCOME_DIR, `${arm}.json`), 'utf8')
  } catch {
    return null
  }
  return parseArmOutcome(arm, raw)
}

/** One line, so the failure is comparable between arms rather than merely present. */
function failureSignatureOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]?.trim() ?? 'unknown failure'
}

test(
  'a real provider-backed workflow completes with the durable journal as its authority',
  { timeout: 20 * 60_000, skip: ENABLED ? false : 'set PIPELINE_LIVE_JOURNAL_CUTOVER=1 to run' },
  async (t) => {
    const arm = CONTROL ? 'control' : 'journal'
    try {
      await runCanaryArm(t)
    } catch (error) {
      recordArmOutcome(arm, {
        completed: false,
        failureSignature: failureSignatureOf(error),
      })
      reportAttribution()
      throw error
    }
    recordArmOutcome(arm, { completed: true })
    reportAttribution()
  },
)

/**
 * Print the four-case verdict once both arms are known. With only one arm
 * recorded there is no verdict to reach, and saying so is the honest output.
 */
function reportAttribution(): void {
  const journal = readArmOutcome('journal')
  const control = readArmOutcome('control')
  if (!journal || !control) {
    process.stdout.write(
      'canary attribution: pending — both arms must run before a verdict exists\n',
    )
    return
  }
  const attribution = attributeCanaryOutcome({ journal, control })
  process.stdout.write(
    `canary attribution: ${attribution.verdict}\ncanary attribution: ${attribution.summary}\n`,
  )
}

async function runCanaryArm(t: TestContext): Promise<void> {
    // One disposable workspace for both arms when the driver supplies it, so
    // the canary is a single workspace observed twice rather than two unrelated
    // runs. Falling back to a fresh temporary directory keeps a single arm
    // runnable on its own for debugging.
    const suppliedWorkspace = process.env.PIPELINE_CANARY_WORKSPACE
    const workspacePath = fs.realpathSync(
      suppliedWorkspace
        ? (fs.mkdirSync(suppliedWorkspace, { recursive: true }), suppliedWorkspace)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'journal-cutover-live-')),
    )
    // The driver owns a supplied workspace's lifetime; an arm that created its
    // own still cleans up unless retention was asked for.
    const keepWorkspace =
      process.env.PIPELINE_KEEP_LIVE_WORKSPACE === '1' || Boolean(suppliedWorkspace)

    // The flag is what production reads; set it here rather than constructing
    // the registry directly, so the test exercises the real enrollment path.
    //
    // Both arms state their mode. Since A-14 an absent flag means
    // `authoritative`, so a control arm that merely removed it would enrol and
    // stop being a control — the two arms would run the same configuration and
    // the comparison would silently mean nothing.
    const previousFlag = process.env.PIPELINE_DURABLE_JOURNAL
    process.env.PIPELINE_DURABLE_JOURNAL = CONTROL ? 'disabled' : 'authoritative'
    t.after(() => {
      if (previousFlag === undefined) delete process.env.PIPELINE_DURABLE_JOURNAL
      else process.env.PIPELINE_DURABLE_JOURNAL = previousFlag
      if (!keepWorkspace) {
        fs.rmSync(workspacePath, { recursive: true, force: true })
      } else {
        process.stdout.write(`live journal workspace retained at ${workspacePath}\n`)
      }
    })

    // Every e2e that drives a real run gives the child a fresh agent state
    // directory. Without it the spawned host inherits the developer's own
    // ~/.pi/agent — hooks, extensions and session state included — which is
    // both unrepresentative and, in practice, enough to make the child shut
    // down before it calls the provider.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    const agentStateDir = path.join(workspacePath, '.pi-agent')
    fs.mkdirSync(agentStateDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentStateDir
    t.after(() => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    })

    // A registry exists in every mode (ADR §16): the mode governs enrollment of
    // new assignments, not whether the registry exists. What distinguishes the
    // control run is that it enrols nothing, asserted below against the disk.
    const registry = createWorkspaceExecutionJournalRegistry(workspacePath)
    t.after(() => registry.close())

    const teamRegistryResult = parseTeamRegistry(path.join(REPO_ROOT, 'teams.yaml'))
    assert.deepEqual(teamRegistryResult.errors, [])
    const workflowRegistryResult = parseWorkflowRegistry(
      path.join(REPO_ROOT, 'workflows', 'registry.yaml'),
    )
    assert.deepEqual(workflowRegistryResult.errors, [])
    const workflowEntry = workflowRegistryResult.entries.find(
      (entry) => entry.name === WORKFLOW_ID,
    )
    assert.ok(workflowEntry, `workflow ${WORKFLOW_ID} is not registered`)

    // A session-scoped durable run: the layout the desktop and API produce,
    // and the only one the journal enrolls.
    const sessionId = `journal-live-${randomUUID()}`
    const runId = randomUUID()
    // The same identity the run claims below, put where the runtime reads it.
    // `runWorkflow` options alone do not reach
    // `prepareDelegatedRuntimeAssignmentAuthority`, which resolves the managed
    // parent from `process.env` exactly as production seeds it in
    // `services/task-service.ts`. Without this the child team runtime fails
    // closed with "Managed Team Runtime capability authority is unavailable" —
    // correctly, because there was no authority to delegate.
    const restoreAuthority = seedCanaryRuntimeAuthority({
      taskId: `task-${runId}`,
      processIdentity: `attempt-${runId}`,
    })
    t.after(restoreAuthority)
    const scope = { sessionId, runId, assignmentId: runId }
    const location = buildSessionRunAssignmentLocation(workspacePath, scope)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })

    const result = await runWorkflow({
      workflowEntry,
      teamRegistry: new Map(
        teamRegistryResult.entries.map((entry) => [entry.name, entry]),
      ),
      brief:
        'Summarise the trade-offs of write-ahead logging for a desktop application. Keep it under one page.',
      workspacePath,
      spawnDepth: 0,
      persistenceMode: 'required',
      rootSessionId: runId,
      parentSessionId: runId,
      productSessionId: sessionId,
      taskId: `task-${runId}`,
      executionAttemptId: `attempt-${runId}`,
      assignmentLocation: location,
      ...(registry ? { journalRegistry: registry } : {}),
    })

    // 1. The product still works with the journal switched on.
    assert.ok(
      ['completed', 'completed_with_warnings'].includes(result.status),
      `workflow did not complete: ${result.summary}`,
    )
    assert.ok(result.primaryArtifact, 'no primary artifact was produced')
    assert.equal(fs.existsSync(result.primaryArtifact), true)
    assert.ok(
      result.steps.every((step) =>
        ['completed', 'completed_with_warnings'].includes(step.status),
      ),
      `a step did not complete: ${JSON.stringify(result.steps.map((s) => [s.stepId, s.status]))}`,
    )

    if (CONTROL) {
      assert.equal(
        fs.existsSync(
          path.join(location.assignmentPath, '.runtime', 'execution-journal'),
        ),
        false,
        'the control run must enrol no journal at all',
      )
      process.stdout.write('control run completed with the journal off\n')
      return
    }

    // 2. The journal was actually the authority, not an unused side file.
    const read = await readExecutionJournal(location.assignmentPath)
    assert.equal(read.kind, 'ok', 'no readable journal was created for the run')
    if (read.kind !== 'ok') return
    const workflowEvents = read.events.filter(
      (event) => event.streamKind === WORKFLOW_STATE_STREAM_KIND,
    )
    assert.ok(
      workflowEvents.length >= result.steps.length,
      `expected a journaled transition per step, saw ${workflowEvents.length}`,
    )

    // Capability dispatches are journaled only if the agents used tools. Report
    // rather than require it: which tools a live agent chooses is not this
    // test's contract, and asserting it would make the test flaky by design.
    const dispatchEvents = read.events.filter(
      (event) => event.streamKind === DURABLE_DISPATCH_STREAM_KIND,
    )
    process.stdout.write(
      `journal: ${read.events.length} events (${workflowEvents.length} workflow, ${dispatchEvents.length} capability-dispatch)\n`,
    )

    // 3. The state file is a projection: delete it and rebuild from the journal.
    const store = new FileSystemWorkflowStateStore(location.assignmentPath)
    const before = await store.requireSnapshot()
    fs.rmSync(store.paths.statePath)

    const journal = await registry.resolveJournalHandle({
      context: {
        contractVersion: 1,
        requestId: 'live-rebuild',
        sessionId,
        runId,
        assignmentId: scope.assignmentId,
        agentPath: 'workflows/runner',
        authority: {
          kind: 'runtime-assignment',
          processIdentity: `attempt-${runId}`,
        },
      },
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 30_000,
    })
    assert.ok(journal, 'the enrolled assignment must resolve its journal')
    await rebuildWorkflowStateProjection(journal, store)

    const after = await store.requireSnapshot()
    assert.deepEqual(
      after.state,
      before.state,
      'workflow state did not survive a rebuild from the canonical journal',
    )
}
