import type {
  ConversationMessage,
  DiscussionContinuationAssignment,
  DiscussionContinuationProgress,
  DiscussionState,
  HumanInputRoutingContext,
} from './types.js'

export function deriveDiscussionContributionStatus(
  messages: readonly ConversationMessage[],
  approvedRoster: readonly string[],
): { successfulCount: number; failedParticipants: string[] } {
  const successfulParticipants = new Set<string>()
  const latestOutcomes = new Map<string, 'position' | 'error'>()
  for (const message of messages) {
    const target = message.target ?? message.from
    if (!approvedRoster.includes(target) || (message.type !== 'position' && message.type !== 'error')) continue
    if (message.type === 'position') successfulParticipants.add(target)
    latestOutcomes.set(target, message.type)
  }
  return {
    successfulCount: successfulParticipants.size,
    failedParticipants: approvedRoster.filter((target) => latestOutcomes.get(target) === 'error'),
  }
}

export type DiscussionContinuationAction =
  | {
      readonly kind: 'specialist_pass'
      readonly passNumber: number
      readonly input: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'reconcile_specialist_pass'
      readonly passNumber: number
      readonly targetCount: number
      readonly successfulCount: number
      readonly acceptedMessages: ConversationMessage[]
    }
  | { readonly kind: 'lead_decision' }
  | {
      readonly kind: 'publish_continuation'
      readonly reason: string
      readonly message: string
      readonly targets: string[]
    }
  | {
      readonly kind: 'publish_completion'
      readonly reason: string
      readonly finalResponse: string
    }

type AcceptedLeadDecision =
  | {
      readonly decision: 'continue'
      readonly reason: string
      readonly message: string
      readonly targets: string[]
    }
  | {
      readonly decision: 'complete'
      readonly reason: string
      readonly finalResponse: string
    }

export function beginDiscussionContinuation(
  startedAtMs: number,
): DiscussionContinuationProgress {
  requireValidTimestamp(startedAtMs)
  return { phase: 'awaiting_specialist_pass', startedAtMs }
}

export function markDiscussionPassComplete(
  progress: DiscussionContinuationProgress,
): DiscussionContinuationProgress {
  return {
    phase: 'awaiting_lead_decision',
    startedAtMs: progress.startedAtMs,
  }
}

export function beginDiscussionSpecialistPass(
  progress: DiscussionContinuationProgress,
  passNumber: number,
  targets: readonly string[],
): DiscussionContinuationProgress {
  if (
    progress.phase !== 'awaiting_specialist_pass' ||
    !Number.isInteger(passNumber) ||
    passNumber <= 0
  ) {
    throw new Error('A specialist pass can begin only from an awaiting pass state.')
  }
  requireNamedTargets(targets)
  return {
    phase: 'running_specialist_pass',
    startedAtMs: progress.startedAtMs,
    passNumber,
    attemptNumber: 0,
    targets: [...targets],
    ...(progress.assignment
      ? { assignment: {
          message: progress.assignment.message,
          targets: [...progress.assignment.targets],
        } }
      : {}),
    completedTargets: [],
    successfulTargets: [],
  }
}

export function beginDiscussionSpecialistPassAttempt(
  progress: DiscussionContinuationProgress,
): Extract<DiscussionContinuationProgress, { phase: 'running_specialist_pass' }> {
  if (
    progress.phase !== 'running_specialist_pass' ||
    !Number.isInteger(progress.attemptNumber) ||
    progress.attemptNumber < 0
  ) {
    throw new Error('A specialist pass attempt requires valid running pass state.')
  }
  return {
    ...progress,
    attemptNumber: progress.attemptNumber + 1,
    ...(progress.targets ? { targets: [...progress.targets] } : {}),
    ...(progress.assignment
      ? {
          assignment: {
            message: progress.assignment.message,
            targets: [...progress.assignment.targets],
          },
        }
      : {}),
    completedTargets: [...progress.completedTargets],
    successfulTargets: [...progress.successfulTargets],
  }
}

export function reopenDiscussionSpecialistPassForRecovery(
  progress: Extract<
    DiscussionContinuationProgress,
    { phase: 'running_specialist_pass' }
  >,
): Extract<DiscussionContinuationProgress, { phase: 'running_specialist_pass' }> {
  const successfulTargets = [...progress.successfulTargets]
  return {
    ...progress,
    ...(progress.targets ? { targets: [...progress.targets] } : {}),
    ...(progress.assignment
      ? {
          assignment: {
            message: progress.assignment.message,
            targets: [...progress.assignment.targets],
          },
        }
      : {}),
    completedTargets: progress.completedTargets.filter((target) =>
      successfulTargets.includes(target),
    ),
    successfulTargets,
  }
}

export function recordDiscussionTargetCompletion(
  progress: DiscussionContinuationProgress,
  target: string,
  successful: boolean,
): DiscussionContinuationProgress {
  if (progress.phase !== 'running_specialist_pass') {
    throw new Error('A target can complete only during a specialist pass.')
  }
  if (!target.trim()) throw new Error('A completed discussion target must be named.')
  const completedTargets = progress.completedTargets.includes(target)
    ? [...progress.completedTargets]
    : [...progress.completedTargets, target]
  const successfulTargets = successful && !progress.successfulTargets.includes(target)
    ? [...progress.successfulTargets, target]
    : [...progress.successfulTargets]
  return {
    ...progress,
    completedTargets,
    successfulTargets,
  }
}

export function markDiscussionLeadContinuation(
  progress: DiscussionContinuationProgress,
  assignment: DiscussionContinuationAssignment,
): DiscussionContinuationProgress {
  if (!assignment.message.trim() || assignment.targets.length === 0) {
    throw new Error('A discussion continuation assignment must name work and targets.')
  }
  return {
    phase: 'awaiting_specialist_pass',
    startedAtMs: progress.startedAtMs,
    assignment: {
      message: assignment.message,
      targets: [...assignment.targets],
    },
  }
}

export function acceptDiscussionLeadDecision(
  progress: DiscussionContinuationProgress,
  decision: AcceptedLeadDecision,
): DiscussionContinuationProgress {
  if (!decision.reason.trim()) {
    throw new Error('A discussion lead decision must include a reason.')
  }
  if (decision.decision === 'complete') {
    if (!decision.finalResponse.trim()) {
      throw new Error('A discussion completion must include a final response.')
    }
    return {
      phase: 'publishing_completion',
      startedAtMs: progress.startedAtMs,
      reason: decision.reason,
      finalResponse: decision.finalResponse,
    }
  }
  if (!decision.message.trim() || decision.targets.length === 0) {
    throw new Error('A discussion continuation must include work and targets.')
  }
  return {
    phase: 'publishing_continuation',
    startedAtMs: progress.startedAtMs,
    reason: decision.reason,
    message: decision.message,
    targets: [...decision.targets],
  }
}

export function resolveDiscussionContinuationAction(
  discussion: DiscussionState,
  maxRounds: number,
  fallbackStartedAtMs: number,
  minRounds = 1,
  options: {
    /**
     * The stage has spent its configured time allowance.
     *
     * Two rules exist to stop a lead finishing prematurely: it may not ask for
     * a decision before any pass has run, and it may not publish a completion
     * below the configured floor. Both assume the remaining passes are still
     * possible. Once the clock is spent they are not, and holding either rule
     * would convert a usable synthesis into a failed run — so this states the
     * exception rather than smuggling it through `minRounds`, which cannot
     * express "no floor" because a policy of zero is invalid.
     */
    outOfTime?: boolean
    minSuccessfulParticipants?: number
  } = {},
): DiscussionContinuationAction {
  requireValidRoundPolicy(minRounds, maxRounds)
  const progress = discussion.continuation ?? inferLegacyProgress(
    discussion.round,
    fallbackStartedAtMs,
  )
  if (progress.phase === 'publishing_continuation') {
    if (discussion.round >= maxRounds) {
      throw new Error(
        'The discussion safety ceiling was reached before another continuation could publish.',
      )
    }
    requireLockedRosterTargets(discussion, progress.targets)
    return {
      kind: 'publish_continuation',
      reason: progress.reason,
      message: progress.message,
      targets: [...progress.targets],
    }
  }
  if (progress.phase === 'publishing_completion') {
    const contributions = deriveDiscussionContributionStatus(discussion.messages, discussion.approvedRoster ?? [])
    const partialAnswer = contributions.failedParticipants.length > 0 &&
      contributions.successfulCount >= Math.max(1, options.minSuccessfulParticipants ?? 1)
    if (!options.outOfTime && !partialAnswer && discussion.round < minRounds) {
      throw new Error(
        'A discussion completion cannot publish before the minimum pass floor is satisfied.',
      )
    }
    if (discussion.round > maxRounds) {
      throw new Error(
        'A discussion completion cannot publish beyond the safety ceiling.',
      )
    }
    return {
      kind: 'publish_completion',
      reason: progress.reason,
      finalResponse: progress.finalResponse,
    }
  }
  if (progress.phase === 'running_specialist_pass') {
    if (progress.passNumber > maxRounds) {
      throw new Error('A recovered specialist pass exceeds the discussion safety ceiling.')
    }
    if (
      discussion.round !== progress.passNumber - 1 &&
      discussion.round !== progress.passNumber
    ) {
      throw new Error('Recovered specialist pass does not match the discussion round.')
    }
    if (progress.assignment) {
      requireLockedRosterTargets(discussion, progress.assignment.targets)
    }
    const targets = progress.targets ??
      progress.assignment?.targets ??
      discussion.approvedRoster ??
      []
    if (targets.length === 0) {
      throw new Error('A recovered specialist pass has no locked roster targets.')
    }
    if (targets.every((target) => progress.completedTargets.includes(target))) {
      const acceptedMessages = progress.successfulTargets.map((target) => {
        const message = [...discussion.messages].reverse().find(
          (candidate) =>
            (candidate.target ?? candidate.from) === target &&
            candidate.round === progress.passNumber &&
            candidate.type === 'position' &&
            Boolean(candidate.dispatchId),
        )
        if (!message) {
          throw new Error(
            `Recovered specialist target '${target}' has no accepted same-pass message.`,
          )
        }
        return { ...message }
      })
      return {
        kind: 'reconcile_specialist_pass',
        passNumber: progress.passNumber,
        targetCount: targets.length,
        successfulCount: progress.successfulTargets.filter((target) =>
          targets.includes(target),
        ).length,
        acceptedMessages,
      }
    }
    return {
      kind: 'specialist_pass',
      passNumber: progress.passNumber,
      input: progress.assignment
        ? {
            to: [...progress.assignment.targets],
            message: progress.assignment.message,
          }
        : {},
    }
  }
  if (progress.phase === 'awaiting_lead_decision') {
    if (!options.outOfTime && discussion.round <= 0) {
      throw new Error('A discussion cannot request a lead decision before a specialist pass.')
    }
    return { kind: 'lead_decision' }
  }
  if (discussion.round >= maxRounds) {
    throw new Error(
      'The discussion safety ceiling was reached before another specialist pass could begin.',
    )
  }
  if (progress.assignment) {
    requireLockedRosterTargets(discussion, progress.assignment.targets)
  }
  return {
    kind: 'specialist_pass',
    passNumber: discussion.round + 1,
    input: progress.assignment
      ? {
          to: [...progress.assignment.targets],
          message: progress.assignment.message,
        }
      : {},
  }
}

export function resolveDiscussionEffectiveTargets(
  plannedTargets: readonly string[],
  passNumber: number,
  routing?: HumanInputRoutingContext,
): string[] {
  requireNamedTargets(plannedTargets)
  if (!Number.isInteger(passNumber) || passNumber <= 0) {
    throw new Error('A discussion pass number must be a positive integer.')
  }
  if (
    passNumber !== 1 ||
    !routing ||
    routing.messages.length === 0 ||
    routing.messages.some((message) => message.recipients === 'all')
  ) {
    return [...plannedTargets]
  }
  const directRecipients = new Set(
    routing.messages.flatMap((message) =>
      message.recipients === 'all' ? [] : message.recipients,
    ),
  )
  return plannedTargets.filter((target) => directRecipients.has(target))
}

function requireNamedTargets(targets: readonly string[]): void {
  if (
    targets.length === 0 ||
    targets.some((target) => !target.trim()) ||
    new Set(targets).size !== targets.length
  ) {
    throw new Error('A discussion specialist pass requires unique named targets.')
  }
}

function requireValidRoundPolicy(minRounds: number, maxRounds: number): void {
  if (
    !Number.isInteger(minRounds) ||
    !Number.isInteger(maxRounds) ||
    minRounds <= 0 ||
    maxRounds < minRounds
  ) {
    throw new Error('Discussion pass limits must define a valid minimum and maximum.')
  }
}

function requireLockedRosterTargets(
  discussion: DiscussionState,
  targets: readonly string[],
): void {
  const lockedRoster = new Set(discussion.approvedRoster ?? [])
  const invalidTarget = targets.find((target) => !lockedRoster.has(target))
  if (invalidTarget) {
    throw new Error(
      `Discussion continuation target '${invalidTarget}' is outside the locked roster.`,
    )
  }
}

/**
 * How long the next dispatch may take, and whether the budget is already spent.
 *
 * `max_time_minutes` is a constraint on the work, not a kill switch. The
 * non-chat discussion path has always treated a breached constraint as
 * something to report alongside a completed stage, and a run the user is
 * watching deserves the same: reaching the limit means "stop taking on new
 * work and produce the answer you have", never "throw away everything the
 * specialists already said".
 *
 * A spent budget therefore still returns a usable timeout. Exactly one more
 * dispatch happens on it — the lead's wrap-up — and `exhausted` is what tells
 * the caller to ask for a synthesis rather than another round. A lead decision
 * also receives at least that allowance just before expiry: a few seconds left
 * for work must not turn the final synthesis into a shorter, failing call.
 * Specialist passes and roster selection retain the remaining work deadline.
 */
export const DISCUSSION_WRAP_UP_MINUTES = 2

export function resolveDiscussionDispatchBudget(
  progress: DiscussionContinuationProgress,
  maxTimeMinutes: number,
  nowMs: number,
  dispatchKind: 'work' | 'lead-decision' = 'work',
): { exhausted: boolean; timeoutMinutes: number } {
  requireValidTimestamp(progress.startedAtMs)
  if (!Number.isFinite(maxTimeMinutes) || maxTimeMinutes <= 0) {
    throw new Error('The discussion time limit must be a positive number of minutes.')
  }
  const remainingMs = maxTimeMinutes * 60_000 - (nowMs - progress.startedAtMs)
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { exhausted: true, timeoutMinutes: DISCUSSION_WRAP_UP_MINUTES }
  }
  const remainingMinutes = remainingMs / 60_000
  return {
    exhausted: false,
    timeoutMinutes: dispatchKind === 'lead-decision'
      ? Math.max(DISCUSSION_WRAP_UP_MINUTES, remainingMinutes)
      : remainingMinutes,
  }
}

export function buildDiscussionRosterDispatchId(
  levelId: string,
  visitCount: number,
): string {
  return `roster-announcement:${discussionVisitKey(levelId, visitCount)}`
}

export function buildDiscussionSpecialistInvocationId(input: {
  sessionId: string
  levelId: string
  visitCount: number
  round: number
  target: string
}): string {
  requireIdentityText(input.sessionId, 'session')
  requireIdentityText(input.target, 'specialist target')
  requirePositiveRound(input.round)
  return (
    `${input.sessionId}:discussion:` +
    `${discussionVisitKey(input.levelId, input.visitCount)}:` +
    `round:${input.round}:${input.target}`
  )
}

/**
 * Round 0 is allowed here, unlike a specialist identity.
 *
 * A specialist identity names the round it answered, so zero is meaningless.
 * A lead decision can legitimately precede every pass: when the stage spends
 * its time allowance before pass 1, the lead is still asked to close the
 * discussion, and that dispatch needs an identity.
 */
export function buildDiscussionLeadDispatchId(input: {
  levelId: string
  visitCount: number
  round: number
}): string {
  requireRoundOrdinal(input.round)
  return (
    `lead-decision:${discussionVisitKey(input.levelId, input.visitCount)}:` +
    `round:${input.round}`
  )
}

/**
 * Which entry into this level a dispatch belongs to.
 *
 * Deliberately the level's visit count and not its loopback count: the latter
 * advances only for the level a gate loops back to, because it also bounds
 * `max_loopbacks`. Every level inside a loopback's reset scope re-runs, so
 * keying identity on the loopback count would make those levels reproduce
 * their previous visit's identities — and the durable message boundary would
 * then drop their new contributions as duplicates.
 */
function discussionVisitKey(levelId: string, visitCount: number): string {
  requireIdentityText(levelId, 'level')
  if (!Number.isInteger(visitCount) || visitCount < 0) {
    throw new Error('A discussion visit count must be a non-negative integer.')
  }
  return `${levelId}:visit:${visitCount}`
}

function requireIdentityText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`A discussion ${label} identity must be named.`)
}

function requirePositiveRound(round: number): void {
  if (!Number.isInteger(round) || round <= 0) {
    throw new Error('A discussion identity round must be a positive integer.')
  }
}

function requireRoundOrdinal(round: number): void {
  if (!Number.isInteger(round) || round < 0) {
    throw new Error('A discussion identity round must be a non-negative integer.')
  }
}

function inferLegacyProgress(
  completedRounds: number,
  fallbackStartedAtMs: number,
): DiscussionContinuationProgress {
  requireValidTimestamp(fallbackStartedAtMs)
  return completedRounds > 0
    ? { phase: 'awaiting_lead_decision', startedAtMs: fallbackStartedAtMs }
    : { phase: 'awaiting_specialist_pass', startedAtMs: fallbackStartedAtMs }
}

function requireValidTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('The discussion start timestamp is invalid.')
  }
}

/**
 * The durable slot a lead decision is bought in.
 *
 * A slot's receipt is bound to a digest of the exact request that created it,
 * so two different requests must never share one. A wrap-up decision — the one
 * asked for once the stage is out of time — carries a different instruction and
 * a different schema from an in-budget decision at the same round, so it gets
 * its own slot. Without that separation, a decision attempted before the
 * deadline and retried after it would find its own slot holding a receipt for a
 * request that no longer matches, and the retry the attempt budget exists to
 * allow would be refused instead.
 */
export function buildDiscussionLeadDecisionInvocationId(input: {
  sessionId: string
  levelId: string
  visitCount: number
  round: number
  outOfTime: boolean
}): string {
  return (
    `${input.sessionId}:discussion:` +
    `${discussionVisitKey(input.levelId, input.visitCount)}:` +
    `decision:${input.round}${input.outOfTime ? ':wrap-up' : ''}`
  )
}
