import type { DiscussionContinuationProgress } from '../core/types.js'
import { beginDiscussionSpecialistPassAttempt } from '../core/discussion-continuation-control.js'

export interface PreparedDiscussionPassAttempt {
  readonly continuation: Extract<
    DiscussionContinuationProgress,
    { phase: 'running_specialist_pass' }
  >
  readonly toolCallId: string
}

export type DiscussionSetupStep = 'set-roster' | 'create-brief'

export function buildDiscussionSetupToolCallId(
  runtimeAttemptId: string,
  step: DiscussionSetupStep,
): string {
  if (!runtimeAttemptId.trim()) {
    throw new Error('A discussion setup call requires a runtime attempt id.')
  }
  return `${runtimeAttemptId}:${step}`
}

export function prepareDiscussionPassAttempt(
  progress: DiscussionContinuationProgress,
  levelId: string,
): PreparedDiscussionPassAttempt {
  if (!levelId.trim()) {
    throw new Error('A discussion pass attempt requires a level id.')
  }
  const continuation = beginDiscussionSpecialistPassAttempt(progress)
  return {
    continuation,
    toolCallId:
      `discussion-pass:${levelId}:${continuation.passNumber}:attempt:${continuation.attemptNumber}`,
  }
}
