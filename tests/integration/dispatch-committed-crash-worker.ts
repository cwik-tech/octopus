import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'
import { createAssignmentCapabilityResultStore } from '../../services/capability-result-content-store.js'
import { CAPABILITY_EVIDENCE_PROJECTION_ID } from '../../core/capability-dispatch-projection.js'

const EFFECT_TIMEOUT_MS = 10_000
const DISPATCH_ID_INPUT = { n: 1 } as const

type Phase = 'crash' | 'resume'

/**
 * One half of the AC13 capability 2 journey, run as a real process.
 *
 * `crash` dispatches one mutating effect through a real `CapabilityDispatcher`
 * on a real journal. The effect runs and `capability.dispatch.committed` is
 * appended; the process is then expected to die before
 * `capability.dispatch.accepted`, which is the window in which the derived
 * evidence view is still only a buffer in memory. `resume` reopens the same
 * assignment and must report the committed-but-unaccepted effect for
 * reconciliation without executing it again, then bring the view current.
 *
 * The kill is the failpoint's, not this worker's: nothing here calls
 * `process.kill`. Until that failpoint exists this phase runs to completion and
 * exits cleanly without publishing a marker, which is the package's Red.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const phase = parsePhase(argv[0])
  const scopeRoot = requireArgument(argv[1], 'scopeRoot')
  const ledgerUrl = requireArgument(argv[2], 'ledgerUrl')
  const evidencePath = requireArgument(argv[3], 'evidencePath')
  const outcomePath = requireArgument(argv[4], 'outcomePath')

  fs.mkdirSync(scopeRoot, { recursive: true })
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
  const journal = await initializeExecutionJournal({
    scopeRoot,
    identity: journalIdentity(),
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
      durable: async () =>
        createJournalBackedDurableDispatch(journal, {
          capabilityEvidenceProjectionPath: evidencePath,
          // The assignment owns its results; the journal only names them.
          resultContentStore: createAssignmentCapabilityResultStore({
            assignmentPath: scopeRoot,
          }),
        }),
    })

    const result = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(ledgerUrl, () => {
        executions += 1
      }),
    })

    if (phase === 'crash') {
      // Only reachable while the failpoint is absent. Recorded rather than
      // thrown so the parent sees a clean, bounded exit and can name the
      // missing failpoint instead of reporting a stall.
      writeOutcome(outcomePath, {
        phase,
        reachedSeam: false,
        status: result.status,
        code: resultCode(result),
        executions,
        projectionStatus: 'not-inspected',
      })
      return
    }

    // The port the dispatcher used is not reachable from here, so the view is
    // brought current through a port of this process's own over the same
    // journal and the same projection file.
    const port = createJournalBackedDurableDispatch(journal, {
      capabilityEvidenceProjectionPath: evidencePath,
      // The assignment owns its results; the journal only names them.
      resultContentStore: createAssignmentCapabilityResultStore({
        assignmentPath: scopeRoot,
      }),
    })
    await port.flushProjections()
    const projectionStatus = await port.projectionStatus(
      CAPABILITY_EVIDENCE_PROJECTION_ID,
    )

    writeOutcome(outcomePath, {
      phase,
      reachedSeam: true,
      status: result.status,
      code: resultCode(result),
      executions,
      projectionStatus,
    })
  } finally {
    await journal.close()
  }
}

function parsePhase(value: string | undefined): Phase {
  if (value === 'crash' || value === 'resume') return value
  throw new Error(`Unknown phase: ${String(value)}. Expected "crash" or "resume".`)
}

function requireArgument(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required argument: ${name}`)
  }
  return value
}

function resultCode(result: CapabilityDispatchResult): string {
  if (result.status === 'completed') return ''
  return result.code
}

interface WorkerOutcome {
  readonly phase: Phase
  readonly reachedSeam: boolean
  readonly status: string
  readonly code: string
  readonly executions: number
  readonly projectionStatus: string
}

function writeOutcome(outcomePath: string, outcome: WorkerOutcome): void {
  fs.writeFileSync(outcomePath, `${JSON.stringify(outcome)}\n`, { mode: 0o600 })
}

function makeAdapter(ledgerUrl: string, onExecute: () => void): CapabilityAdapter {
  return {
    capabilityId: 'test.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['n'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable',
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        onExecute()
        const response = await fetch(`${ledgerUrl}/mutate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ effect: 'dispatch' }),
          // A hung ledger must fail the worker rather than stall the journey.
          signal: AbortSignal.timeout(EFFECT_TIMEOUT_MS),
        })
        if (!response.ok) {
          throw new Error(`the ledger rejected the effect: ${response.status}`)
        }
        return { acknowledged: true }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-committed-crash',
    sessionId: 'product-session',
    runId: 'root-run',
    assignmentId: 'root-run',
    agentPath: 'agents/committed-crash',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'committed-crash-worker',
    },
  }
}

/**
 * Identical across both processes: the restart has to be recognised as the
 * same invocation, which is what makes the committed effect replayable rather
 * than a new dispatch.
 */
function makeInvocation(): CapabilityInvocation {
  return {
    capabilityId: 'test.mutate',
    source: { kind: 'builtin', id: 'committed-crash', version: '1' },
    toolCallId: 'call-committed-crash',
    input: { ...DISPATCH_ID_INPUT },
  }
}

function journalIdentity(): ExecutionJournalScopeIdentity {
  return {
    scopeKind: 'assignment',
    scopeId: 'root-run',
    tenantId: 'local',
    sessionId: 'product-session',
    runId: 'root-run',
    assignmentId: 'root-run',
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
