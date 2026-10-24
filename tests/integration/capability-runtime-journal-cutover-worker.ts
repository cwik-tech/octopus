import * as fs from 'node:fs'
import * as path from 'node:path'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type {
  CapabilityAdapter,
  CapabilityDispatchResult,
  CapabilityExecutionContext,
  CapabilityInvocation,
} from '../../contracts/capability-dispatch.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { CapabilityDispatchRuntime } from '../../services/capability-dispatch-runtime.js'
import { resolveExecutionJournalOptions } from '../../server/composition.js'

/**
 * Drives the production `CapabilityDispatchRuntime` — its registry, its
 * assignment resolution, and its flag — rather than a bare dispatcher, so the
 * cutover wiring itself is what the acceptance test exercises.
 */
async function main(): Promise<void> {
  const [workspacePath, mode, serverUrl, outcomePath] = process.argv.slice(2)
  if (!workspacePath || !mode || !serverUrl || !outcomePath) {
    throw new Error('cutover worker arguments are incomplete')
  }
  const location = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  })
  if (!location) throw new Error('assignment location did not resolve')
  fs.mkdirSync(location.assignmentPath, { recursive: true })

  const runtime = new CapabilityDispatchRuntime({
    workspacePath,
    leaseResolver: () => null,
    runtimeAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-1',
        runPath: location.runPath,
        assignmentPath: location.assignmentPath,
      }),
    },
    // The production parsing decides the mode, so the flag's real behaviour
    // is what this acceptance test exercises.
    executionJournal: resolveExecutionJournalOptions(),
  })

  try {
    const result = await runtime.dispatcher.dispatch({
      context: makeContext(),
      invocation: makeInvocation(),
      adapter: makeAdapter(mode, serverUrl),
    })
    fs.writeFileSync(outcomePath, JSON.stringify(summarize(result)), 'utf8')
  } finally {
    await runtime.close()
  }
}

function makeAdapter(mode: string, serverUrl: string): CapabilityAdapter {
  return {
    capabilityId: 'test.mutate',
    prepare: async () => ({
      effect: serialCapabilityEffect('mutating'),
      risk: 'test-mutating',
      argumentNames: ['target'],
      policyDecision: { kind: 'allow' },
      recoveryPolicy: 'non_retryable' as const,
      authorize: async () => ({ kind: 'allow' }),
      execute: async () => {
        // The external effect happens here and is durable at the server.
        const response = await fetch(`${serverUrl}/mutate`, { method: 'POST' })
        const body: unknown = await response.json()
        if (mode === 'crash') {
          // Die after the effect but before acceptance is durable.
          process.exit(9)
        }
        return body
      },
      acceptResult: async ({ value }) => ({ value }),
    }),
  }
}

function makeContext(): CapabilityExecutionContext {
  return {
    contractVersion: 1,
    requestId: 'request-cutover',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    agentPath: 'agents/cutover',
    authority: { kind: 'runtime-assignment', processIdentity: 'cutover' },
  }
}

function makeInvocation(): CapabilityInvocation {
  return {
    capabilityId: 'test.mutate',
    source: { kind: 'builtin', id: 'cutover', version: '1' },
    toolCallId: 'call-cutover-stable',
    input: { target: 'counter' },
  }
}

function summarize(result: CapabilityDispatchResult): {
  status: string
  code?: string
} {
  return result.status === 'completed'
    ? { status: result.status }
    : { status: result.status, code: result.code }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
