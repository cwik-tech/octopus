import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'
import { createAssignmentCapabilityResultStore } from '../../services/capability-result-content-store.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { PROJECTION_RECOVERY_IDENTITY } from './execution-journal-projection-recovery-identity.js'

/**
 * A worker that enrolls, dispatches, and exits while the derived view cannot
 * be written.
 *
 * It exists so the parent has nothing to inherit. An in-memory requeue looks
 * identical to real recovery inside one process — the buffer is right there —
 * and only a process boundary tells them apart: this worker's buffer dies with
 * it, so anything the parent recovers came from the canonical journal.
 *
 * It runs a real dispatcher rather than calling the port's record methods,
 * because the invariant under test is about a *dispatch*: it must succeed and
 * stay durable while its projection is failing.
 */
async function main(): Promise<void> {
  const [scopeRoot, evidencePath, outputPath] = process.argv.slice(2)
  if (!scopeRoot || !evidencePath || !outputPath) {
    throw new Error('projection recovery worker arguments are incomplete')
  }
  // The identity is shared source, not an argument: parsing it back from JSON
  // would mean trusting unchecked external input for no benefit.
  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: PROJECTION_RECOVERY_IDENTITY,
  })
  const port = createJournalBackedDurableDispatch(journal, {
    capabilityEvidenceProjectionPath: evidencePath,
    // The assignment owns its results; the journal only names them.
    resultContentStore: createAssignmentCapabilityResultStore({
      assignmentPath: scopeRoot,
    }),
  })
  try {
    let executions = 0
    const dispatcher = new CapabilityDispatcher({
      bindings: new CapabilityInvocationBindings({
        maxActivePerScope: 4,
        maxRetainedPerScope: 32,
      }),
      authority: { authorize: async () => ({ kind: 'allow' }) },
      policy: { evaluate: async () => ({ kind: 'allow' }) },
      budget: {
        preflight: async () => ({ kind: 'not-metered' }),
        reserve: async () => ({ reservationId: 'unused' }),
        settle: async () => ({ costTracked: false, budgetOverrun: false }),
        release: async () => undefined,
      },
      evidence: { append: async () => undefined },
      scheduler: new PerAuthorityCapabilityExecutionScheduler(),
      clock: { now: () => Date.now() },
      ids: { nextAttemptId: () => `attempt-${randomUUID()}` },
      durable: async () => port,
    })

    const result = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(() => {
        executions += 1
      }),
    })

    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        status: result.status,
        dispatchId: result.dispatchId,
        executions,
        projection: await port.projectionStatus('capability-evidence'),
      }),
      'utf8',
    )
  } finally {
    // No lifecycle flush. `projectionStatus` above already attempted a
    // catch-up and failed, because the fault is still active; what this worker
    // never does is come back for the view after it clears. That is what a
    // process exiting without a clean teardown looks like, and it leaves the
    // parent nothing to inherit.
    await journal.close()
  }
}

function makeAdapter(onExecute: () => void): CapabilityAdapter {
  return {
    capabilityId: 'test.project',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        onExecute()
        return { ok: true }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-projection-recovery',
    sessionId: PROJECTION_RECOVERY_IDENTITY.sessionId,
    runId: PROJECTION_RECOVERY_IDENTITY.runId,
    assignmentId: PROJECTION_RECOVERY_IDENTITY.assignmentId,
    agentPath: 'agents/projection-recovery',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'projection-recovery-worker',
    },
  }
}

function makeInvocation(): CapabilityInvocation {
  return {
    capabilityId: 'test.project',
    source: { kind: 'builtin', id: 'projections', version: '1' },
    toolCallId: 'call-projection-recovery',
    input: { target: 'projection-view' },
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
