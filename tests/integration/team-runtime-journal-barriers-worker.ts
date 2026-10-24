import * as fs from 'node:fs'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityExecutionContext,
} from '../../contracts/capability-dispatch.js'
import { buildSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { startWorkspaceExecutionJournal } from '../../services/execution-journal-tenant-pin.js'
import { createWorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { createTeamRuntimeCapabilityDispatcher } from '../../team-runtime/capability-dispatch-factory.js'
import { requireTeamRuntimeCapabilityIdentity } from '../../team-runtime/runtime-capability-context.js'

/**
 * Dispatches one mutating effect through the production Team Runtime
 * dispatcher construction path inside its own process: session-layout
 * assignment location, env-derived managed identity, and the same dispatcher
 * factory `ensureCapabilityDispatcher` uses. The parent test reads the
 * assignment's durable state afterwards.
 */

const EFFECT_FETCH_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  const [
    workspacePath,
    sessionId,
    runId,
    assignmentId,
    taskId,
    processIdentity,
    serverUrl,
    outputPath,
  ] = process.argv.slice(2)
  if (
    !workspacePath ||
    !sessionId ||
    !runId ||
    !assignmentId ||
    !taskId ||
    !processIdentity ||
    !serverUrl ||
    !outputPath
  ) {
    throw new Error('team-runtime-journal-barriers worker arguments are incomplete')
  }

  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId,
    runId,
    assignmentId,
  })
  if (!location) {
    throw new Error('The session assignment location could not be built.')
  }

  const identity = requireTeamRuntimeCapabilityIdentity({
    location,
    runtimeSessionId: sessionId,
    environment: {
      ...process.env,
      TEAM_RUNTIME_TASK_ID: taskId,
      TEAM_RUNTIME_PROCESS_IDENTITY: processIdentity,
    },
  })

  const journalOptions = await startWorkspaceExecutionJournal({ workspacePath })
  const journalRegistry = createWorkspaceExecutionJournalRegistry(
    workspacePath,
    journalOptions,
  )

  const { dispatcher, evidenceWriter } = createTeamRuntimeCapabilityDispatcher({
    assignmentPath: location.assignmentPath,
    sessionId: identity.sessionId,
    runId: identity.runId,
    assignmentId: identity.assignmentId,
    authority: {
      authorize: async (input) =>
        input.context.sessionId === identity.sessionId &&
        input.context.runId === identity.runId &&
        input.context.assignmentId === identity.assignmentId &&
        input.context.taskId === identity.taskId &&
        input.context.agentPath === 'runtime' &&
        input.context.authority.kind === 'runtime-assignment' &&
        input.context.authority.processIdentity === identity.processIdentity
          ? { kind: 'allow' }
          : {
              kind: 'deny',
              code: 'runtime_assignment_invalid',
              reason: 'The Team Runtime assignment authority changed.',
            },
    },
    policy: { evaluate: async () => ({ kind: 'allow' }) },
    budget: {
      ledger: undefined,
      readTotalCostUsd: () => 0,
      isMetered: () => false,
    },
    clock: { now: () => Date.now() },
    ids: { nextAttemptId: () => 'attempt-team-runtime-barriers' },
    durable: (input) => journalRegistry.resolve(input),
  })

  const context: CapabilityExecutionContext = {
    contractVersion: 1,
    requestId: 'team-runtime-barriers-request',
    sessionId: identity.sessionId,
    runId: identity.runId,
    assignmentId: identity.assignmentId,
    taskId: identity.taskId,
    agentPath: 'runtime',
    authority: {
      kind: 'runtime-assignment',
      processIdentity: identity.processIdentity,
    },
  }

  let executions = 0
  let result: CapabilityDispatchResult
  try {
    result = await dispatcher.dispatch({
      context,
      invocation: {
        capabilityId: 'test.team-runtime.mutate',
        source: { kind: 'builtin', id: 'team-runtime-barriers', version: '1' },
        toolCallId: 'call-team-runtime-barriers',
        input: { probe: true },
      },
      adapter: makeMutatingAdapter(serverUrl, () => {
        executions += 1
      }),
    })
  } finally {
    // Closes even when the dispatch throws, so neither the evidence writer
    // nor the journal registry leaks an open handle on the failure path.
    await evidenceWriter.close()
    await journalRegistry.close()
  }
  fs.writeFileSync(outputPath, JSON.stringify(summarizeResult(result, executions)), 'utf8')
}

function makeMutatingAdapter(
  serverUrl: string,
  onExecute: () => void,
): CapabilityAdapter {
  return {
    capabilityId: 'test.team-runtime.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['probe'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable',
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        onExecute()
        const response = await fetch(`${serverUrl}/mutate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ effect: 'dispatch' }),
          signal: AbortSignal.timeout(EFFECT_FETCH_TIMEOUT_MS),
        })
        if (!response.ok) {
          throw new Error(`Mutating effect failed with status ${response.status}`)
        }
        return await response.json()
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function summarizeResult(
  result: CapabilityDispatchResult,
  executions: number,
): {
  readonly status: string
  readonly code?: string
  readonly executions: number
} {
  if (result.status === 'completed') {
    return { status: result.status, executions }
  }
  return { status: result.status, code: result.code, executions }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
