import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import { CapabilityDispatcher } from '../../core/capability-dispatcher.js'
import { CapabilityInvocationBindings } from '../../core/capability-invocation-bindings.js'
import { PerAuthorityCapabilityExecutionScheduler } from '../../core/capability-execution-scheduler.js'
import { initializeExecutionJournal } from '../../core/execution-journal.js'
import { createJournalBackedDurableDispatch } from '../../core/durable-dispatch-journal.js'
import { createAssignmentCapabilityResultStore } from '../../services/capability-result-content-store.js'
import type { ExecutionJournalScopeIdentity } from '../../contracts/execution-journal.js'

async function main(): Promise<void> {
  const [scopeRoot, identityJson, mode, serverUrl, markerPath, gatePath, outputPath] =
    process.argv.slice(2)
  if (
    !scopeRoot ||
    !identityJson ||
    !mode ||
    !serverUrl ||
    !markerPath ||
    !gatePath ||
    !outputPath
  ) {
    throw new Error('crash-replay worker arguments are incomplete')
  }
  const identity = JSON.parse(identityJson) as ExecutionJournalScopeIdentity
  const journal = await initializeExecutionJournal({ scopeRoot, identity })
  try {
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
          // The assignment owns its results; the journal only names them.
          resultContentStore: createAssignmentCapabilityResultStore({
            assignmentPath: scopeRoot,
          }),
        }),
    })

    const adapter = makeAdapter(mode, serverUrl, markerPath, gatePath)
    const result = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(mode),
      adapter,
    })
    fs.writeFileSync(outputPath, JSON.stringify(summarizeResult(result)), 'utf8')
  } finally {
    await journal.close()
  }
}

function makeAdapter(
  mode: string,
  serverUrl: string,
  markerPath: string,
  gatePath: string,
): CapabilityAdapter {
  return {
    capabilityId: 'test.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      authorize: async ({ phase }) => {
        if (mode === 'prepared-run' && phase === 'before-execute') {
          fs.writeFileSync(markerPath, 'prepared', 'utf8')
          await waitForFile(gatePath)
        }
        return { kind: 'allow' }
      },
      execute: async () => {
        if (mode === 'effect-run') {
          await mutateExternalSystem(serverUrl)
          fs.writeFileSync(markerPath, 'executed', 'utf8')
          await waitForFile(gatePath)
        }
        if (mode === 'prepared-run' || mode === 'recover-run') {
          await mutateExternalSystem(serverUrl)
        }
        return { mutated: true }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

async function mutateExternalSystem(serverUrl: string): Promise<void> {
  const response = await fetch(`${serverUrl}/mutate`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Mutating effect failed with status ${response.status}`)
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-crash-replay',
    sessionId: 'session-crash',
    runId: 'run-crash',
    assignmentId: 'assignment-crash',
    agentPath: 'agents/crash-replay',
    providerCallOrdinal: 0,
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'crash-replay-worker',
    },
  }
}

function makeInvocation(mode: string): CapabilityInvocation {
  return {
    capabilityId: 'test.mutate',
    source: { kind: 'builtin', id: 'crash-replay', version: '1' },
    // Provider call IDs are live-turn identities and change when the provider
    // turn is recreated after a process crash. The persisted operation is the
    // same workflow call at ordinal zero, so recovery must restore the first
    // invocation identity rather than treating this as a new effect.
    toolCallId: `call-crash-replay-${mode}`,
    input: { target: 'loopback-counter' },
  }
}

function summarizeResult(result: CapabilityDispatchResult): {
  readonly status: string
  readonly code?: string
} {
  if (result.status === 'completed') return { status: result.status }
  return { status: result.status, code: result.code }
}

async function waitForFile(filePath: string): Promise<void> {
  while (!fs.existsSync(filePath)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
