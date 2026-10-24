import {
  DispatchResultValidationError,
  type FailurePolicyAttemptRecord,
} from '../agent-execution/failure-policy.js'
import type { EvidencePacket } from '../../contracts/deep-research.js'
import { DeepResearchValidationError } from './deep-research-validation.js'
import { parseDeepResearchEvidenceResult } from './deep-research-pipeline-adapter.js'
import {
  appendDeepResearchWorkerFailure,
  persistDeepResearchWorkerAttemptRecord,
  type DeepResearchWorkerAttemptValidator,
  type DeepResearchWorkerFailureCategory,
} from './deep-research-worker-logging.js'

export function classifyResearchEvidenceError(
  error: unknown,
): Extract<
  DeepResearchWorkerFailureCategory,
  'response_schema_invalid' | 'binding_invalid'
> {
  return error instanceof DeepResearchValidationError ||
    (error instanceof Error && /only one valid EvidencePacket JSON object/i.test(error.message))
    ? 'response_schema_invalid'
    : 'binding_invalid'
}

export function researchEvidenceRetryInstruction(
  error: unknown,
  category: Extract<
    DeepResearchWorkerFailureCategory,
    'response_schema_invalid' | 'binding_invalid'
  >,
): string {
  if (error instanceof DeepResearchValidationError) {
    return `Correct field "${error.field}": ${error.message}`
  }
  if (category === 'response_schema_invalid') {
    return 'Return exactly one raw EvidencePacket JSON object with no Markdown fences or surrounding prose.'
  }
  const detail = error instanceof Error
    ? error.message.replace(/\s+/g, ' ').trim().slice(0, 750)
    : 'The packet identifiers, sources, receipts, or excerpts did not match the approved lane.'
  return `Correct the EvidencePacket binding: ${detail}`
}

function describeAttemptValidator(
  error: unknown,
): DeepResearchWorkerAttemptValidator {
  if (error instanceof DispatchResultValidationError) {
    return {
      name: 'DispatchResultValidationError',
      message: error.message,
      category: error.category,
    }
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error
      ? error.message
      : String(error),
    category: 'provider_failure',
  }
}

function mergeUnderlyingValidationError(
  base: DeepResearchWorkerAttemptValidator,
  underlying: unknown,
): DeepResearchWorkerAttemptValidator {
  if (underlying instanceof DeepResearchValidationError) {
    return {
      name: underlying.name,
      field: underlying.field,
      message: underlying.message,
      category: base.category,
    }
  }
  if (underlying instanceof Error) {
    return { ...base, message: underlying.message }
  }
  return base
}

export interface DeepResearchWorkerAttemptSummary {
  readonly attempts: number
  readonly lastOutcome: 'accepted' | 'rejected' | 'no_response' | undefined
  readonly lastValidator?: DeepResearchWorkerAttemptValidator
  readonly lastResponseText?: string
}

/**
 * Runtime-owned observers for one research worker dispatch: strict evidence
 * validation plus one private attempt record per concrete attempt, indexed by
 * the sanitized per-lane validation log.
 */
export function createDeepResearchWorkerAttemptObservers(input: {
  readonly assignmentPath: string
  readonly laneId: string
  readonly taskId: string
  readonly sectionId: string
  readonly workerSpecHash: string
}): {
  readonly validateResult: (text: string) => string
  readonly onAttemptRecord: (record: FailurePolicyAttemptRecord) => void
  readonly onAttemptFailure: (
    agentName: string,
    error: unknown,
    attempt: number,
  ) => void
  readonly validatedPacket: () => EvidencePacket | undefined
  readonly attemptSummary: () => DeepResearchWorkerAttemptSummary
} {
  let lastAttemptDirName: string | undefined
  let lastValidationError: unknown
  let validatedPacket: EvidencePacket | undefined
  let attempts = 0
  let lastOutcome: 'accepted' | 'rejected' | 'no_response' | undefined
  let lastValidator: DeepResearchWorkerAttemptValidator | undefined
  let lastResponseText: string | undefined

  return {
    validateResult: (text: string) => {
      try {
        const packet = parseDeepResearchEvidenceResult({
          text,
          taskId: input.taskId,
          sectionId: input.sectionId,
          assignmentId: input.laneId,
          workerSpecHash: input.workerSpecHash,
          assignmentPath: input.assignmentPath,
        })
        validatedPacket = packet
        lastValidationError = undefined
        return JSON.stringify(packet)
      } catch (error) {
        validatedPacket = undefined
        lastValidationError = error
        const category = classifyResearchEvidenceError(error)
        throw new DispatchResultValidationError(
          category === 'response_schema_invalid'
            ? 'Deep Research worker returned an invalid evidence response.'
            : 'Deep Research worker evidence did not match its approved lane and source observation receipts.',
          category,
          researchEvidenceRetryInstruction(error, category),
        )
      }
    },
    onAttemptRecord: (record) => {
      attempts += 1
      lastResponseText = record.responseText
      if (record.error === undefined) {
        lastOutcome = 'accepted'
        lastValidator = undefined
        lastAttemptDirName = persistDeepResearchWorkerAttemptRecord({
          assignmentPath: input.assignmentPath,
          laneId: input.laneId,
          taskId: input.taskId,
          attempt: record.attempt,
          systemPrompt: record.prompt,
          userMessage: record.userMessage,
          ...(record.responseText === undefined ? {} : { responseText: record.responseText }),
          outcome: 'accepted',
          attemptStartedAtMs: record.attemptStartedAtMs,
          elapsedMs: record.elapsedMs,
        }) ?? lastAttemptDirName
        return
      }
      const validator = record.error instanceof DispatchResultValidationError
        ? mergeUnderlyingValidationError(
          describeAttemptValidator(record.error),
          lastValidationError,
        )
        : describeAttemptValidator(record.error)
      lastOutcome = record.error instanceof DispatchResultValidationError
        ? 'rejected'
        : 'no_response'
      lastValidator = validator
      lastAttemptDirName = persistDeepResearchWorkerAttemptRecord({
        assignmentPath: input.assignmentPath,
        laneId: input.laneId,
        taskId: input.taskId,
        attempt: record.attempt,
        systemPrompt: record.prompt,
        userMessage: record.userMessage,
        ...(record.responseText === undefined ? {} : { responseText: record.responseText }),
        outcome: record.error instanceof DispatchResultValidationError
          ? 'rejected'
          : 'no_response',
        validator,
        attemptStartedAtMs: record.attemptStartedAtMs,
        elapsedMs: record.elapsedMs,
      }) ?? lastAttemptDirName
    },
    onAttemptFailure: (
      _agentName: string,
      error: unknown,
      attempt: number,
    ) => {
      // Every failed attempt is indexed, not only the ones that reached
      // validation. A timeout, a crash, or a stall abort writes an attempt
      // directory too, and leaving those unindexed makes the per-lane index
      // read as "this lane produced no failures" when it produced nothing.
      const category: DeepResearchWorkerFailureCategory =
        error instanceof DispatchResultValidationError &&
        (error.category === 'response_schema_invalid' ||
          error.category === 'binding_invalid')
          ? error.category
          : 'dispatch_failed'
      appendDeepResearchWorkerFailure({
        assignmentPath: input.assignmentPath,
        taskId: input.taskId,
        laneId: input.laneId,
        attempt,
        category,
        ...(lastAttemptDirName ? { attemptDirName: lastAttemptDirName } : {}),
      })
    },
    validatedPacket: () => validatedPacket,
    attemptSummary: () => ({
      attempts,
      lastOutcome,
      ...(lastValidator !== undefined ? { lastValidator } : {}),
      ...(lastResponseText !== undefined ? { lastResponseText } : {}),
    }),
  }
}
