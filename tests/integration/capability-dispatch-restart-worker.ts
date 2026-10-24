import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'

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

async function main(): Promise<void> {
  const [scopeRoot, identityJson, mode, serverUrl, outputPath, inputJson] =
    process.argv.slice(2)
  if (!scopeRoot || !identityJson || !mode || !serverUrl || !outputPath || !inputJson) {
    throw new Error('capability-dispatch-restart worker arguments are incomplete')
  }
  const identity = JSON.parse(identityJson) as ExecutionJournalScopeIdentity
  const invocationInput = JSON.parse(inputJson) as Record<string, unknown>
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

    let executions = 0
    const adapter = makeAdapter(serverUrl, invocationInput, () => {
      executions += 1
    })
    const result = await dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(mode, invocationInput),
      adapter,
    })
    fs.writeFileSync(
      outputPath,
      JSON.stringify(summarizeResult(result, executions)),
      'utf8',
    )
  } finally {
    await journal.close()
  }
}

function makeAdapter(
  serverUrl: string,
  invocationInput: Record<string, unknown>,
  onExecute: () => void,
): CapabilityAdapter {
  return {
    capabilityId: 'test.echo',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['n'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable',
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        onExecute()
        const response = await fetch(`${serverUrl}/mutate`, { method: 'POST' })
        if (!response.ok) {
          throw new Error(`Mutating effect failed with status ${response.status}`)
        }
        const body = (await response.json()) as { counter: number }
        const blob =
          invocationInput.large === true ? 'x'.repeat(200_000) : 'small'
        return { counter: body.counter, echo: invocationInput, blob }
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-restart',
    sessionId: 'session-restart',
    runId: 'run-restart',
    assignmentId: 'assignment-restart',
    agentPath: 'agents/restart',
    providerCallOrdinal: 0,
    authority: {
      kind: 'runtime-assignment',
      processIdentity: 'restart-worker',
    },
  }
}

function makeInvocation(
  mode: string,
  input: Record<string, unknown>,
): CapabilityInvocation {
  return {
    capabilityId: 'test.echo',
    source: { kind: 'builtin', id: 'restart', version: '1' },
    toolCallId: `call-restart-${mode}`,
    input,
  }
}

function summarizeResult(
  result: CapabilityDispatchResult,
  executions: number,
): {
  readonly status: string
  readonly code?: string
  readonly value?: unknown
  readonly executions: number
} {
  if (result.status === 'completed') {
    return { status: result.status, value: result.value, executions }
  }
  return { status: result.status, code: result.code, executions }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
