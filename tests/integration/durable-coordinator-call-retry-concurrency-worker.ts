import * as fs from 'node:fs'
import { once } from 'node:events'

import type { AgentRunResult } from '../../core/types.js'
import {
  CoordinatorCallIndeterminateError,
  CoordinatorCallRejectedError,
  CoordinatorCallRejectionExhaustedError,
  executeDurableCoordinatorCall,
} from '../../team-runtime/durable-coordinator-call.js'

/**
 * One process contending for a single durable coordinator slot.
 *
 * The parent seeds a terminal receipt, starts several of these, waits for every
 * one to announce readiness, and only then releases them together. Readiness
 * and release both travel over this process's own stdio, so the race is opened
 * by an event rather than by a sleep or a poll.
 */

interface WorkerArguments {
  readonly assignmentPath: string
  readonly invocationId: string
  readonly workerId: string
  readonly invocationLogPath: string
  readonly outcomePath: string
  readonly baseTotalCost: number
}

const COORDINATOR_REQUEST = {
  provider: 'claude',
  model: 'claude-haiku-4-5',
  thinking: 'low',
  systemPrompt: 'Coordinate this task.',
  userMessage: 'Choose the next step.',
} as const

function readWorkerArguments(): WorkerArguments {
  const [payload] = process.argv.slice(2)
  if (!payload) throw new Error('retry-concurrency worker arguments are missing')
  const parsed: unknown = JSON.parse(payload)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('retry-concurrency worker arguments are not an object')
  }
  const record: Record<string, unknown> = { ...parsed }
  return {
    assignmentPath: requireString(record.assignmentPath, 'assignmentPath'),
    invocationId: requireString(record.invocationId, 'invocationId'),
    workerId: requireString(record.workerId, 'workerId'),
    invocationLogPath: requireString(record.invocationLogPath, 'invocationLogPath'),
    outcomePath: requireString(record.outcomePath, 'outcomePath'),
    baseTotalCost: requireNumber(record.baseTotalCost, 'baseTotalCost'),
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`retry-concurrency worker argument '${label}' must be a string`)
  }
  return value
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`retry-concurrency worker argument '${label}' must be a number`)
  }
  return value
}

function providerResult(text: string): AgentRunResult {
  return {
    text,
    cost: 0.4,
    durationMs: 20,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    model: 'claude-haiku-4-5',
    costTracked: true,
    costSource: 'reported',
  }
}

function classifyFailure(error: unknown): string {
  if (error instanceof CoordinatorCallIndeterminateError) return 'indeterminate'
  if (error instanceof CoordinatorCallRejectionExhaustedError) {
    return 'rejection_exhausted'
  }
  if (error instanceof CoordinatorCallRejectedError) return 'rejected'
  return 'error'
}

async function main(): Promise<void> {
  const args = readWorkerArguments()
  process.stdout.write('ready\n')
  await once(process.stdin, 'data')

  let outcome: Record<string, unknown>
  try {
    const call = await executeDurableCoordinatorCall({
      assignmentPath: args.assignmentPath,
      invocationId: args.invocationId,
      request: COORDINATOR_REQUEST,
      baseTotalCost: args.baseTotalCost,
      now: () => '2026-09-07T12:00:00.000Z',
      invoke: async () => {
        // The one externally visible effect that must happen exactly once.
        fs.appendFileSync(args.invocationLogPath, `${args.workerId}\n`)
        return providerResult(`{"agents":["a"],"by":"${args.workerId}"}`)
      },
      accept: (result) => result.text,
    })
    outcome = {
      kind: call.replayed ? 'replayed' : 'claimed',
      workerId: args.workerId,
      value: call.value,
    }
  } catch (error) {
    outcome = {
      kind: classifyFailure(error),
      workerId: args.workerId,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  fs.writeFileSync(args.outcomePath, `${JSON.stringify(outcome)}\n`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
