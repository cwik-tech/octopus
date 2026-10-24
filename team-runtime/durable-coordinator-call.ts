import { ProviderError } from '../domains/provider/provider-error.js'
import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'
import { agentQuestionInterruptionSchema } from '../contracts/agent-questions.js'
import { DirectAgentBudgetRefusedError } from './direct-agent-budget-admission.js'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { roundUsd } from '../core/budget-ledger.js'
import { hashCanonicalJson } from '../core/canonical-json-hash.js'
import {
  acquireProcessFileLock,
  createCrossProcessFileLockRecord,
  crossProcessFileLockAdapter,
} from '../core/cross-process-file-lock.js'
import { writeFileAtomicSync } from '../core/file-mutation.js'
import { hasErrorCode } from '../core/node-errors.js'
import type { AgentRunResult } from '../core/types.js'
import {
  ensureRunPrivateRuntimeDirectory,
  getRunRuntimePaths,
} from '../domains/runtime/runtime-paths.js'

/**
 * How many times one coordinator slot may be attempted.
 *
 * A crash mid-call leaves a `started` receipt and stays indeterminate for good:
 * the provider may have produced — and charged for — a result nobody read. A
 * failure this process actually caught is different. We know no result was
 * accepted, so refusing to try again would let one transient error (a schema
 * rejection, a timeout, a budget refusal) end the whole assignment. Retries are
 * bounded so a slot that always fails still stops instead of paying forever.
 */
export const MAX_COORDINATOR_CALL_ATTEMPTS = 3

/**
 * Failures known to have cost nothing.
 *
 * A caught error is not by itself proof that no result was produced: a timeout
 * or an abort can land after the provider finished and billed the call, and
 * retrying then re-pays it. Two kinds of failure are safe. A refusal the
 * provider made *of the request* — a malformed schema, a rejected key, a
 * missing model — never produced anything to charge for. So does a refusal
 * raised before the provider was contacted at all, which is the stronger
 * evidence of the two. Everything else, including a transport failure or
 * anything this module cannot recognise, is an unknown outcome and stays
 * indeterminate exactly as a crash does.
 */
const UNFULFILLED_PROVIDER_ERROR_KINDS: ReadonlySet<string> = new Set([
  'invalid_request',
  'request_too_large',
  'context_limit',
  'authentication',
  'permission',
  'not_found',
  'configuration',
])

function isDefinitelyUnfulfilled(error: unknown): boolean {
  // Raised before the operation that reaches the provider, so the call was
  // never sent. A Team that briefly hit its cap has to stay resumable.
  if (error instanceof DirectAgentBudgetRefusedError) return true
  if (!(error instanceof ProviderError)) return false
  return error.kind !== undefined &&
    UNFULFILLED_PROVIDER_ERROR_KINDS.has(error.kind)
}

const RECEIPT_VERSION = 1
const RECEIPT_DIRECTORY = 'coordinator-calls'

type CoordinatorCallReceipt =
  | {
      readonly version: 1
      readonly phase: 'started'
      readonly invocationId: string
      readonly requestDigest: string
      readonly attemptNumber: number
      readonly baseTotalCost: number
      readonly startedAt: string
    }
  | {
      readonly version: 1
      readonly phase: 'failed'
      readonly invocationId: string
      readonly requestDigest: string
      readonly attemptNumber: number
      readonly baseTotalCost: number
      readonly startedAt: string
      readonly failedAt: string
      readonly error: string
    }
  | {
      readonly version: 1
      readonly phase: 'rejected'
      readonly invocationId: string
      readonly requestDigest: string
      readonly attemptNumber: number
      readonly baseTotalCost: number
      readonly postTotalCost: number
      readonly startedAt: string
      readonly rejectedAt: string
      readonly result: AgentRunResult
      readonly rejectionReason: string
    }
  | {
      readonly version: 1
      readonly phase: 'completed'
      readonly invocationId: string
      readonly requestDigest: string
      readonly attemptNumber: number
      readonly baseTotalCost: number
      readonly postTotalCost: number
      readonly startedAt: string
      readonly completedAt: string
      readonly result: AgentRunResult
    }

export class CoordinatorCallIndeterminateError extends Error {
  constructor(invocationId: string) {
    super(
      `Coordinator call '${invocationId}' has an indeterminate provider outcome; ` +
        'automatic replay was refused to prevent a duplicate paid call.',
    )
    this.name = 'CoordinatorCallIndeterminateError'
  }
}

/**
 * A reply the provider produced, the run paid for, and the runtime then refused
 * on contract grounds — a roster selection that is not JSON, a schema the model
 * ignored.
 *
 * Deliberately distinct from `CoordinatorCallIndeterminateError`. There the
 * outcome is unknown and buying again risks paying twice; here the provider
 * demonstrably answered, the charge is already recorded on the receipt, and the
 * only thing wrong is the content. Such a slot may be bought again. Replaying
 * `accept` over the stored text instead re-throws for as long as the receipt
 * survives, which is a permanent failure on a call that was already paid for.
 */
export class CoordinatorCallRejectedError extends Error {
  constructor(
    readonly invocationId: string,
    readonly attemptNumber: number,
    readonly rejectionReason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Coordinator call '${invocationId}' returned a reply the runtime rejected ` +
        `on attempt ${attemptNumber}: ${rejectionReason}`,
      options,
    )
    this.name = 'CoordinatorCallRejectedError'
  }
}

/** Every attempt in the slot's budget produced a reply the runtime rejected. */
export class CoordinatorCallRejectionExhaustedError extends Error {
  constructor(
    readonly invocationId: string,
    readonly attemptNumber: number,
    readonly rejectionReason: string,
  ) {
    super(
      `Coordinator call '${invocationId}' had ${attemptNumber} consecutive ` +
        `replies rejected and has no attempts left. Last rejection: ${rejectionReason}`,
    )
    this.name = 'CoordinatorCallRejectionExhaustedError'
  }
}

export interface DurableCoordinatorCallResult<T> {
  readonly result: AgentRunResult
  readonly value: T
  readonly baseTotalCost: number
  readonly postTotalCost: number
  readonly startedAtMs: number
  readonly replayed: boolean
}

export interface DurableCoordinatorRequestIdentity {
  readonly provider: string
  readonly model: string
  readonly thinking: string
  readonly providerConfig?: Readonly<Record<string, unknown>>
  readonly systemPrompt: string
  readonly userMessage: string
  readonly outputSchema?: Readonly<Record<string, unknown>>
  readonly timeoutMinutes?: number
}

export function durableCoordinatorCallRequestDigest(
  request: DurableCoordinatorRequestIdentity,
): string {
  const requestIdentity = {
    provider: request.provider,
    model: request.model,
    thinking: request.thinking,
    providerConfig: request.providerConfig ?? null,
    systemPrompt: request.systemPrompt,
    userMessage: request.userMessage,
    outputSchema: request.outputSchema ?? null,
    timeoutMinutes: request.timeoutMinutes ?? null,
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(requestIdentity)
  } catch (error) {
    throw new Error('Coordinator call request identity is not serializable.', {
      cause: error,
    })
  }
  if (serialized === undefined) {
    throw new Error('Coordinator call request identity is not serializable.')
  }
  const jsonCompatibleIdentity: unknown = JSON.parse(serialized)
  return hashCanonicalJson(jsonCompatibleIdentity).value
}

export function reconcileDurableCoordinatorCost(
  currentTotalCost: number,
  baseTotalCost: number,
  postTotalCost: number,
): number {
  requireCost(currentTotalCost, 'current total cost')
  requireCost(baseTotalCost, 'base total cost')
  requireCost(postTotalCost, 'post-call total cost')
  if (currentTotalCost === baseTotalCost) return postTotalCost
  if (currentTotalCost === postTotalCost) return currentTotalCost
  throw new Error(
    'Durable coordinator cost cannot reconcile with the current run total.',
  )
}

export function durableCoordinatorCallReceiptPath(
  assignmentPath: string,
  invocationId: string,
): string {
  if (!invocationId.trim()) {
    throw new Error('A durable coordinator call requires an invocation identity.')
  }
  const digest = createHash('sha256').update(invocationId).digest('hex')
  return path.join(
    getRunRuntimePaths(assignmentPath).privateRuntimePath,
    RECEIPT_DIRECTORY,
    `${digest}.json`,
  )
}

export async function executeDurableCoordinatorCall<T>(input: {
  /** Set only by a recovered managed run admitted after a human answer. */
  readonly resumeAfterQuestion?: boolean
  readonly assignmentPath: string
  readonly invocationId: string
  readonly request: DurableCoordinatorRequestIdentity
  readonly baseTotalCost: number
  readonly now: () => string
  readonly invoke: () => Promise<AgentRunResult>
  readonly onDurableResult?: (
    result: AgentRunResult,
    baseTotalCost: number,
    postTotalCost: number,
  ) => void
  readonly prepare?: (result: AgentRunResult) => AgentRunResult
  readonly accept: (result: AgentRunResult) => T
  /** Cancels waiting for the receipt lock when the run is shutting down. */
  readonly signal?: AbortSignal
}): Promise<DurableCoordinatorCallResult<T>> {
  requireCost(input.baseTotalCost, 'base total cost')
  const requestDigest = durableCoordinatorCallRequestDigest(input.request)
  const receiptPath = durableCoordinatorCallReceiptPath(
    input.assignmentPath,
    input.invocationId,
  )
  ensureCoordinatorReceiptDirectory(input.assignmentPath)
  const started: Extract<CoordinatorCallReceipt, { phase: 'started' }> = {
    version: RECEIPT_VERSION,
    phase: 'started',
    invocationId: input.invocationId,
    requestDigest,
    attemptNumber: 1,
    baseTotalCost: input.baseTotalCost,
    startedAt: requireTimestamp(input.now()),
  }
  const claim = await claimCoordinatorAttempt({
    receiptPath,
    started,
    ...whenSignal(input.signal),
  })
  if (claim.kind === 'replayable') {
    const existing = claim.receipt
    if (input.resumeAfterQuestion && existing.result.interruption?.kind === 'awaiting_input') {
      // A human answer starts one new paid turn in the same logical slot. Its
      // own durable receipt preserves indeterminate-outcome protection.
      if (input.baseTotalCost === existing.baseTotalCost) {
        input.onDurableResult?.(existing.result, existing.baseTotalCost, existing.postTotalCost)
      }
      return executeDurableCoordinatorCall({
        ...input, resumeAfterQuestion: false,
        invocationId: `${input.invocationId}:answer:${existing.result.interruption.interactionId}`,
        baseTotalCost: existing.postTotalCost,
      })
    }
    input.onDurableResult?.(
      existing.result,
      existing.baseTotalCost,
      existing.postTotalCost,
    )
    const prepared = input.prepare
      ? input.prepare(existing.result)
      : existing.result
    return {
      result: existing.result,
      // A stored reply the runtime can no longer accept must not re-throw on
      // every future visit. Recording the rejection reopens the slot instead.
      value: await acceptOrRecordRejection({
        accept: input.accept,
        prepared,
        receiptPath,
        receipt: existing,
        now: input.now,
        ...whenSignal(input.signal),
      }),
      baseTotalCost: existing.baseTotalCost,
      postTotalCost: existing.postTotalCost,
      startedAtMs: Date.parse(existing.startedAt),
      replayed: true,
    }
  }
  if (claim.kind === 'in_flight' || claim.kind === 'failure_exhausted') {
    throw new CoordinatorCallIndeterminateError(input.invocationId)
  }
  if (claim.kind === 'rejection_exhausted') {
    // The provider answered and was paid every time; only the content was
    // refused. The refusal says what was wrong rather than calling the outcome
    // unknown, because the budget was spent on replies.
    throw new CoordinatorCallRejectionExhaustedError(
      input.invocationId,
      claim.attemptNumber,
      claim.rejectionReason,
    )
  }
  const { attemptNumber } = claim
  // The slot's start time belongs to the slot, not to an attempt within it.
  // A discussion reconciles its activation clock against the value returned
  // here, so letting a retry restamp it would quietly move the stage deadline.
  const { startedAt } = claim

  let invoked: Awaited<ReturnType<typeof input.invoke>>
  try {
    invoked = await input.invoke()
  } catch (error) {
    // Only a refusal of the request frees the slot. Anything else leaves the
    // `started` receipt in place, so a later attempt reports an indeterminate
    // outcome rather than paying for the same call twice.
    if (isDefinitelyUnfulfilled(error)) {
      await commitReceiptTransition({
        receiptPath,
        expectedPhase: 'started',
        expectedAttemptNumber: attemptNumber,
        invocationId: input.invocationId,
        requestDigest,
        next: {
          ...started,
          startedAt,
          attemptNumber,
          phase: 'failed',
          failedAt: requireTimestamp(input.now()),
          error: error instanceof Error ? error.message : String(error),
        },
        ...whenSignal(input.signal),
      })
    }
    throw error
  }
  const result = parseAgentRunResult(invoked, 'Coordinator provider result')
  const postTotalCost = roundUsd(started.baseTotalCost + result.cost)
  const completed: Extract<CoordinatorCallReceipt, { phase: 'completed' }> = {
    ...started,
    startedAt,
    attemptNumber,
    phase: 'completed',
    postTotalCost,
    completedAt: requireTimestamp(input.now()),
    result,
  }
  // If this durable write fails, the `started` receipt deliberately remains.
  // Recovery must then report an indeterminate outcome instead of charging the
  // provider again after a response that may already have completed.
  const recorded = await commitReceiptTransition({
    receiptPath,
    expectedPhase: 'started',
    expectedAttemptNumber: attemptNumber,
    invocationId: input.invocationId,
    requestDigest,
    next: completed,
    ...whenSignal(input.signal),
  })
  if (!recorded) {
    // Unreachable while this process still owns the slot: nobody else may take
    // a `started` receipt. Refusing rather than overwriting is still the safe
    // direction — a newer attempt's record outranks this stale one.
    throw new Error(
      `Coordinator call '${input.invocationId}' could not record attempt ` +
        `${attemptNumber}: the durable slot moved to another attempt.`,
    )
  }
  input.onDurableResult?.(result, started.baseTotalCost, postTotalCost)
  const prepared = input.prepare ? input.prepare(result) : result
  return {
    result,
    value: await acceptOrRecordRejection({
      accept: input.accept,
      prepared,
      receiptPath,
      receipt: completed,
      now: input.now,
      ...whenSignal(input.signal),
    }),
    baseTotalCost: started.baseTotalCost,
    postTotalCost,
    startedAtMs: Date.parse(startedAt),
    replayed: false,
  }
}

/** Spread an `AbortSignal` only when there is one, under exact optional types. */
function whenSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {}
}

/**
 * Run the caller's acceptance check, and record a refusal as a retryable phase.
 *
 * The provider result is already durable and its charge already reconciled when
 * this runs, so a refusal changes only the verdict: the receipt keeps
 * `postTotalCost` and gains the reason it was refused. Writing `rejected` is
 * what lets the next visit buy another reply instead of replaying `accept` over
 * the same stored text forever.
 */
async function acceptOrRecordRejection<T>(input: {
  readonly accept: (result: AgentRunResult) => T
  readonly prepared: AgentRunResult
  readonly receiptPath: string
  readonly receipt: Extract<CoordinatorCallReceipt, { phase: 'completed' }>
  readonly now: () => string
  readonly signal?: AbortSignal
}): Promise<T> {
  if (input.prepared.interruption) throw new AgentQuestionInterruptionError(input.prepared.interruption)
  let rejectionReason: string
  let cause: unknown
  try {
    return input.accept(input.prepared)
  } catch (error) {
    cause = error
    rejectionReason = error instanceof Error ? error.message : String(error)
  }
  // Refusing a stored reply reopens the slot, so it is a receipt transition
  // like any other and is conditional on the attempt it refuses still standing.
  await commitReceiptTransition({
    receiptPath: input.receiptPath,
    expectedPhase: 'completed',
    expectedAttemptNumber: input.receipt.attemptNumber,
    invocationId: input.receipt.invocationId,
    requestDigest: input.receipt.requestDigest,
    next: {
      version: RECEIPT_VERSION,
      phase: 'rejected',
      invocationId: input.receipt.invocationId,
      requestDigest: input.receipt.requestDigest,
      attemptNumber: input.receipt.attemptNumber,
      baseTotalCost: input.receipt.baseTotalCost,
      postTotalCost: input.receipt.postTotalCost,
      startedAt: input.receipt.startedAt,
      rejectedAt: requireTimestamp(input.now()),
      result: input.receipt.result,
      rejectionReason,
    },
    ...whenSignal(input.signal),
  })
  throw new CoordinatorCallRejectedError(
    input.receipt.invocationId,
    input.receipt.attemptNumber,
    rejectionReason,
    { cause },
  )
}

function writeReceipt(filePath: string, receipt: CoordinatorCallReceipt): void {
  writeFileAtomicSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`)
}

/**
 * What a process is allowed to do with a coordinator slot it has just read.
 *
 * Only `claimed` may call the provider. Everything else names why this process
 * must not: the answer is already stored, another process holds the slot, or
 * the slot has spent its attempts.
 */
type CoordinatorAttemptClaim =
  | {
      readonly kind: 'claimed'
      readonly attemptNumber: number
      readonly startedAt: string
    }
  | {
      readonly kind: 'replayable'
      readonly receipt: Extract<CoordinatorCallReceipt, { phase: 'completed' }>
    }
  | { readonly kind: 'in_flight' }
  | {
      readonly kind: 'rejection_exhausted'
      readonly attemptNumber: number
      readonly rejectionReason: string
    }
  | { readonly kind: 'failure_exhausted' }

/**
 * Decide, and publish, who owns the next attempt at one coordinator slot.
 *
 * Admission used to be exclusive only for the first attempt: an empty slot was
 * created with an exclusive link, but reopening a `rejected` or `failed` slot
 * was an ordinary atomic write. Two processes recovering the same terminal
 * receipt therefore both saw a retryable slot and both bought a reply — sixteen
 * provider invocations for one attempt, in the run that produced this fix.
 *
 * Reading the receipt and republishing it as `started` now happens under a
 * per-receipt cross-process lock, so every reopening is decided once. The lock
 * is released the moment `started` is published; the provider call itself runs
 * outside it, because holding a lock across a paid remote call would let one
 * stalled process block every recovery behind it.
 */
async function claimCoordinatorAttempt(input: {
  readonly receiptPath: string
  readonly started: Extract<CoordinatorCallReceipt, { phase: 'started' }>
  readonly signal?: AbortSignal
}): Promise<CoordinatorAttemptClaim> {
  const { started } = input
  return withCoordinatorReceiptLock(
    input.receiptPath,
    input.signal,
    (): CoordinatorAttemptClaim => {
      const existing = readReceipt(
        input.receiptPath,
        started.invocationId,
        started.requestDigest,
      )
      if (!existing) {
        writeReceipt(input.receiptPath, started)
        return {
          kind: 'claimed',
          attemptNumber: started.attemptNumber,
          startedAt: started.startedAt,
        }
      }
      if (existing.phase === 'completed') {
        return { kind: 'replayable', receipt: existing }
      }
      // A crash mid-call leaves `started` behind and the outcome unknown for
      // good. Waiting for the holder would only make a duplicate paid call
      // later, so this stays a refusal rather than a queue.
      if (existing.phase === 'started') return { kind: 'in_flight' }
      if (existing.attemptNumber >= MAX_COORDINATOR_CALL_ATTEMPTS) {
        return existing.phase === 'rejected'
          ? {
              kind: 'rejection_exhausted',
              attemptNumber: existing.attemptNumber,
              rejectionReason: existing.rejectionReason,
            }
          : { kind: 'failure_exhausted' }
      }
      const attemptNumber = existing.attemptNumber + 1
      // `started` carries the caller's current total, which already includes any
      // rejected attempt's charge, so the next attempt bases on money spent.
      writeReceipt(input.receiptPath, {
        ...started,
        startedAt: existing.startedAt,
        attemptNumber,
      })
      return { kind: 'claimed', attemptNumber, startedAt: existing.startedAt }
    },
  )
}

/**
 * Move a slot forward only if it is still where this process left it.
 *
 * Answers `false` rather than writing when the receipt has moved on, so a late
 * writer cannot overwrite a newer attempt with its own stale verdict. A digest
 * that no longer matches is louder than that and throws from `readReceipt`.
 */
async function commitReceiptTransition(input: {
  readonly receiptPath: string
  readonly expectedPhase: 'started' | 'completed'
  readonly expectedAttemptNumber: number
  readonly invocationId: string
  readonly requestDigest: string
  readonly next: CoordinatorCallReceipt
  readonly signal?: AbortSignal
}): Promise<boolean> {
  return withCoordinatorReceiptLock(
    input.receiptPath,
    input.signal,
    (): boolean => {
      const current = readReceipt(
        input.receiptPath,
        input.invocationId,
        input.requestDigest,
      )
      if (
        current?.phase !== input.expectedPhase ||
        current.attemptNumber !== input.expectedAttemptNumber
      ) {
        return false
      }
      writeReceipt(input.receiptPath, input.next)
      return true
    },
  )
}

/**
 * The lock guarding one receipt's transitions.
 *
 * Per receipt, not per assignment: two coordinator slots in the same run have
 * independent budgets and must not queue behind each other. A holder that dies
 * leaves a record naming its pid, which `acquireProcessFileLock` reclaims.
 */
async function withCoordinatorReceiptLock<T>(
  receiptPath: string,
  signal: AbortSignal | undefined,
  operation: () => T,
): Promise<T> {
  const lock = await acquireProcessFileLock({
    lockPath: `${receiptPath}.lock`,
    record: createCrossProcessFileLockRecord(),
    adapter: crossProcessFileLockAdapter,
    waitDescription: 'coordinator call receipt lock',
    corruptBehavior: 'wait',
    ...whenSignal(signal),
  })
  try {
    return operation()
  } finally {
    await lock.release()
  }
}

function ensureCoordinatorReceiptDirectory(assignmentPath: string): void {
  const privateRuntimePath = ensureRunPrivateRuntimeDirectory(assignmentPath)
  const directoryPath = path.join(privateRuntimePath, RECEIPT_DIRECTORY)
  try {
    fs.mkdirSync(directoryPath, { recursive: false, mode: 0o700 })
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
  }
  const stat = fs.lstatSync(directoryPath)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(
      'Coordinator call receipt directory must be a private directory.',
    )
  }
}

function readReceipt(
  filePath: string,
  invocationId: string,
  requestDigest: string,
): CoordinatorCallReceipt | undefined {
  if (!fs.existsSync(filePath)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error('Coordinator call receipt is unreadable.', { cause: error })
  }
  return parseReceipt(parsed, invocationId, requestDigest)
}

function parseReceipt(
  value: unknown,
  invocationId: string,
  requestDigest: string,
): CoordinatorCallReceipt {
  if (!isRecord(value) || value.version !== RECEIPT_VERSION) {
    throw new Error('Coordinator call receipt has an unsupported shape.')
  }
  if (value.invocationId !== invocationId) {
    throw new Error('Coordinator call receipt identity does not match its slot.')
  }
  if (value.requestDigest !== requestDigest) {
    throw new Error('Coordinator call request changed for an existing durable slot.')
  }
  const attemptNumber = requirePositiveInteger(value.attemptNumber, 'attempt number')
  const baseTotalCost = requireCost(value.baseTotalCost, 'base total cost')
  const startedAt = requireTimestamp(value.startedAt)
  if (value.phase === 'started') {
    return {
      version: RECEIPT_VERSION,
      phase: 'started',
      invocationId,
      requestDigest,
      attemptNumber,
      baseTotalCost,
      startedAt,
    }
  }
  if (value.phase === 'failed') {
    return {
      version: RECEIPT_VERSION,
      phase: 'failed',
      invocationId,
      requestDigest,
      attemptNumber,
      baseTotalCost,
      startedAt,
      failedAt: requireTimestamp(value.failedAt),
      error: typeof value.error === 'string' ? value.error : 'unknown error',
    }
  }
  if (value.phase === 'rejected') {
    const result = parseAgentRunResult(
      value.result,
      'Rejected coordinator result',
    )
    const postTotalCost = requireCost(
      value.postTotalCost,
      'post-call total cost',
    )
    const expectedPostTotalCost = roundUsd(baseTotalCost + result.cost)
    if (postTotalCost !== expectedPostTotalCost) {
      throw new Error('Coordinator call receipt has inconsistent cost totals.')
    }
    return {
      version: RECEIPT_VERSION,
      phase: 'rejected',
      invocationId,
      requestDigest,
      attemptNumber,
      baseTotalCost,
      postTotalCost: expectedPostTotalCost,
      startedAt,
      rejectedAt: requireTimestamp(value.rejectedAt),
      result,
      rejectionReason: typeof value.rejectionReason === 'string'
        ? value.rejectionReason
        : 'unknown rejection',
    }
  }
  if (value.phase === 'completed') {
    const result = parseAgentRunResult(
      value.result,
      'Persisted coordinator result',
    )
    const postTotalCost = requireCost(
      value.postTotalCost,
      'post-call total cost',
    )
    const expectedPostTotalCost = roundUsd(baseTotalCost + result.cost)
    if (postTotalCost !== expectedPostTotalCost) {
      throw new Error('Coordinator call receipt has inconsistent cost totals.')
    }
    return {
      version: RECEIPT_VERSION,
      phase: 'completed',
      invocationId,
      requestDigest,
      attemptNumber,
      baseTotalCost,
      postTotalCost: expectedPostTotalCost,
      startedAt,
      completedAt: requireTimestamp(value.completedAt),
      result,
    }
  }
  throw new Error('Coordinator call receipt has an invalid phase.')
}

function parseAgentRunResult(value: unknown, label: string): AgentRunResult {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  const text = requireString(value.text, `${label} text`)
  const model = requireText(value.model, `${label} model`)
  const cost = requireCost(value.cost, `${label} cost`)
  const durationMs = requireNonNegativeNumber(value.durationMs, `${label} duration`)
  const inputTokens = requireNonNegativeInteger(value.inputTokens, `${label} input tokens`)
  const outputTokens = requireNonNegativeInteger(value.outputTokens, `${label} output tokens`)
  const contextTokens = requireNonNegativeInteger(value.contextTokens, `${label} context tokens`)
  const result: AgentRunResult = {
    text,
    cost,
    durationMs,
    inputTokens,
    outputTokens,
    contextTokens,
    model,
  }
  if (typeof value.costTracked === 'boolean') result.costTracked = value.costTracked
  if (value.interruption !== undefined) result.interruption = agentQuestionInterruptionSchema.parse(value.interruption)
  if (isCostSource(value.costSource)) result.costSource = value.costSource
  return result
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new Error('Coordinator call receipt timestamp is invalid.')
  }
  return value
}

function requireCost(value: unknown, label: string): number {
  return requireNonNegativeNumber(value, label)
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`)
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return value
}

function isCostSource(value: unknown): value is NonNullable<AgentRunResult['costSource']> {
  return value === 'reported' ||
    value === 'provider_config' ||
    value === 'environment' ||
    value === 'zero_cost' ||
    value === 'untracked'
}
