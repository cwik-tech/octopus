/**
 * Team Runtime — Failure Policy Module
 *
 * Implements agent failure recovery with stage-aware defaults,
 * adaptive exponential backoff, circuit-breaker integration,
 * and provider-error taxonomy awareness.
 *
 * Policy resolution order (highest priority first):
 *   1. Stage-level on_agent_failure override (blanket emergency control)
 *   2. Per-agent on_failure config
 *   3. Stage-type default:
 *      - pipeline / chain / review  → retry(2) → halt
 *      - discussion / broadcast     → skip
 *
 * Retry delay: exponential backoff with jitter for retryable errors;
 * non-retryable errors escalate immediately without wasting retries.
 */

import { whenDefined } from "../../core/optional-properties.js"
import type {
  AgentFailurePolicy,
  AgentErrorEvent,
  RosterEntrySlim,
  LoadedAgent,
} from "../../core/types.js";
import type { DispatchOptions } from "./agent-runner.js";
import { dispatchToAgentOrTeam } from "./agent-runner.js";
import { SubTeamFailedError } from "./sub-team-failure.js";
import type {
  BudgetDispatchAdmission,
  BudgetLedger,
} from "../../core/budget-ledger.js";
import { logAgentError, logAgentRun } from "../runtime/logger.js";
import {
  DEFAULT_MAX_RETRIES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  BUDGET_WARN_THRESHOLD_PCT,
  CRITICAL_STAGE_TYPES,
} from "../../core/constants.js";
import { ProviderError } from "../provider/provider-error.js";
import { globalCircuitBreaker } from "../runtime/circuit-breaker.js";
import { randomUUID } from "node:crypto";

// ─── Resolved Policy ─────────────────────────────────────────────────────────

export interface FailurePolicyAttemptRecord {
  /** Agent that was dispatched for this attempt. */
  readonly agentName: string;
  /** 1-based primary-loop attempt number. */
  readonly attempt: number;
  /** Exact system prompt dispatched for this attempt. */
  readonly prompt: string;
  /** Exact user message dispatched for this attempt, including retry instructions. */
  readonly userMessage: string;
  /** Raw provider output for this attempt, before validation. */
  readonly responseText: string | undefined;
  /** Thrown error when the attempt failed; undefined when it was accepted. */
  readonly error: unknown;
  /** Wall-clock start of the concrete dispatch, in epoch milliseconds. */
  readonly attemptStartedAtMs: number;
  /** Wall-clock duration of the concrete dispatch in milliseconds. */
  readonly elapsedMs: number;
}

export interface ResolvedFailurePolicy {
  policy: "retry" | "fallback" | "skip" | "halt";
  maxRetries: number;
  fallbackAgent?: string;
}

// ─── Dispatch Options ────────────────────────────────────────────────────────

export interface FailurePolicyDispatchOptions extends DispatchOptions {
  /** Resolved failure policy for this dispatch. */
  policy: ResolvedFailurePolicy;
  /** Loaded fallback agent (used when policy includes a fallback_agent). */
  fallbackAgent?: LoadedAgent;
  /** Roster entry for the fallback agent. */
  fallbackRosterEntry?: RosterEntrySlim;
  /** Final system prompt for fallback agent. */
  fallbackFinalPrompt?: string;
  /** Level identifier (for error log). */
  levelId: string;
  /** Stage type (for error log). */
  stageType: string;
  /** Current session ID (for error log). */
  sessionId: string;
  /** Root session ID for cross-team observability (optional). */
  rootSessionId?: string;
  /** Exact assignment path where agent-errors.jsonl is written. */
  errorLogPath: string;
  /**
   * Called on every failed dispatch attempt (before retry, on skip, on halt).
   * Engines use this to update AgentMetrics without importing RuntimeContext.
   */
  onFailureRecorded?: (agentName: string, error: string) => void;
  /** Called once for each concrete primary dispatch attempt that fails. */
  onAttemptFailure?: (
    agentName: string,
    error: unknown,
    attempt: number,
  ) => void;
  /**
   * Called once for each concrete primary dispatch attempt, success or
   * failure, with the exact prompt, raw response, and error. Observability
   * only; exceptions are swallowed and never affect the retry policy.
   */
  onAttemptRecord?: (record: FailurePolicyAttemptRecord) => void;
  /** B4: Budget ledger for pre-dispatch enforcement check. */
  budgetLedger?: BudgetLedger;
  /** B4: Current accumulated session cost (pass state.totalCost). */
  totalCost?: number;
  /** Dispatcher-owned envelope admission; avoids a second ledger reservation. */
  budgetAdmission?: BudgetDispatchAdmission;
  /** Absolute wall-clock deadline shared by every primary and fallback attempt. */
  retryDeadlineMs?: number;
  /**
   * Validate and optionally normalize a provider result before an attempt is
   * considered successful. Thrown errors follow the same bounded retry and
   * fallback policy as provider failures.
   */
  validateResult?: (text: string) => string;
}

/** A retryable model-output contract failure, distinct from provider health. */
export class DispatchResultValidationError extends Error {
  readonly retryInstruction: string | undefined

  constructor(
    message: string,
    readonly category: string,
    retryInstruction?: string,
  ) {
    super(message)
    this.name = 'DispatchResultValidationError'
    this.retryInstruction = normalizeRetryInstruction(retryInstruction)
  }
}

function normalizeRetryInstruction(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim().slice(0, 1_000)
  return normalized || undefined
}

/**
 * Fold a rejection reason back into the prompt that produced the bad answer.
 *
 * Exported because the discussion coordinator needs the same shape. Its call is
 * not a dispatch, so it cannot reuse `dispatchWithFailurePolicy`'s loop, but a
 * model told what was wrong with its last reply should be told the same way
 * wherever the rejection happened.
 */
export function appendValidationRetryInstruction(
  userMessage: string,
  retryInstruction: string | undefined,
): string {
  if (!retryInstruction) return userMessage
  return [
    userMessage,
    '',
    '# Runtime Validation Feedback',
    `Your previous response was rejected. ${retryInstruction}`,
    'Return a complete replacement response that satisfies the original contract.',
  ].join('\n')
}

// ─── HaltError ───────────────────────────────────────────────────────────────

/**
 * Thrown by dispatchWithFailurePolicy when the halt policy is triggered.
 * Engines catch this to stop their processing and surface the error.
 */
export class HaltError extends Error {
  readonly agentName: string;
  readonly originalError: string;

  constructor(agentName: string, originalError: string) {
    super(`Agent "${agentName}" halted: ${originalError}`);
    this.name = "HaltError";
    this.agentName = agentName;
    this.originalError = originalError;
  }
}

// ─── Policy Resolution ───────────────────────────────────────────────────────

/**
 * Resolve the effective failure policy for an agent dispatch.
 *
 * Priority order:
 *   1. stageOverride (on_agent_failure from stage config)
 *   2. agentPolicy (on_failure from agent roster entry)
 *   3. Stage-type default
 */
export function resolveFailurePolicy(
  _agentName: string,
  stageType: string,
  stageOverride?: string,
  agentPolicy?: AgentFailurePolicy,
): ResolvedFailurePolicy {
  // 1. Stage override wins over everything
  if (stageOverride) {
    return {
      policy: stageOverride as ResolvedFailurePolicy["policy"],
      maxRetries: stageOverride === "retry" ? DEFAULT_MAX_RETRIES : 0,
    };
  }

  // 2. Per-agent config
  if (agentPolicy) {
    return {
      policy: agentPolicy.policy,
      maxRetries:
        agentPolicy.max_retries ??
        (agentPolicy.policy === "retry" ? DEFAULT_MAX_RETRIES : 0),
      ...whenDefined(agentPolicy.fallback_agent, (fallbackAgent) => ({ fallbackAgent })),
    };
  }

  // 3. Stage-type default
  if (CRITICAL_STAGE_TYPES.has(stageType)) {
    return { policy: "retry", maxRetries: DEFAULT_MAX_RETRIES };
  }

  // Additive stages (discussion, broadcast) and unknown stage types default to skip
  return { policy: "skip", maxRetries: 0 };
}

// ─── Adaptive Delay ──────────────────────────────────────────────────────────

/**
 * Compute the delay before the next retry attempt.
 * Uses exponential backoff with jitter, capped at RETRY_BACKOFF_MAX_MS.
 * If the provider error includes a Retry-After header, honor it.
 */
export function computeRetryDelay(
  attempt: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs;
  }
  // attempt 1 = first retry (0-based in loop), so exponent starts at 0
  const exponent = Math.max(0, attempt - 1);
  const base = RETRY_BACKOFF_BASE_MS * Math.pow(2, exponent);
  const jitter = Math.random() * 500;
  return Math.min(RETRY_BACKOFF_MAX_MS, base + jitter);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

/** Wait for retry backoff without delaying cancellation. */
export function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs))
  const abortSignal = signal
  if (abortSignal.aborted) return Promise.reject(abortReason(abortSignal))

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(cleanupAndResolve, delayMs)
    const onAbort = () => {
      clearTimeout(timeout)
      abortSignal.removeEventListener('abort', onAbort)
      reject(abortReason(abortSignal))
    }
    function cleanupAndResolve(): void {
      abortSignal.removeEventListener('abort', onAbort)
      resolve()
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Check whether the budget is in warning territory (>= 90% of cap).
 * When true, reduce max retries to 1 to save spend.
 */
export function getBudgetAdjustedMaxRetries(
  policyMaxRetries: number,
  budgetLedger: BudgetLedger | undefined,
  totalCost: number | undefined,
): number {
  if (!budgetLedger || totalCost === undefined) return policyMaxRetries;
  if (budgetLedger.capUsd <= 0 || !Number.isFinite(budgetLedger.capUsd))
    return policyMaxRetries;
  const ratio = totalCost / budgetLedger.capUsd;
  if (ratio >= BUDGET_WARN_THRESHOLD_PCT && policyMaxRetries > 1) {
    return 1;
  }
  return policyMaxRetries;
}

// ─── Dispatch with Failure Policy ────────────────────────────────────────────

/**
 * Dispatch to an agent or sub-team, applying the resolved failure policy
 * on any failures (retry / fallback / skip / halt).
 *
 * Returns the successful dispatch result, or a skip marker.
 * Throws HaltError if the halt policy is triggered.
 */
type FailurePolicyDispatchResult = {
  interruption?: import('../../contracts/agent-questions.js').AgentQuestionInterruption;
  text: string;
  cost: number;
  model?: string;
  costTracked?: boolean;
  skipped?: boolean;
  /**
   * The attempt that produced this text.
   *
   * Carried out so a durable record can name the exact attempt rather than the
   * agent: the same agent may have run twice, and only one of those runs is
   * the one the reader saw.
   */
  dispatchId?: string;
  /**
   * Who produced this text, which after a fallback is not the agent the stage
   * asked for. A durable message must name the speaker the reader saw.
   */
  agentName?: string;
};

/**
 * Whether a failed dispatch attempt should consume retry budget.
 *
 * Exported because it is the single decision the retry loop makes about an
 * error's identity, and driving it end-to-end would otherwise require sitting
 * through real exponential backoff to observe one boolean.
 *
 * A delegated child team carries its own retryability, derived from the child's
 * terminal status. Without that branch it falls into the permissive default and
 * a blocked child — which needs new input before it can proceed — is retried
 * against the identical brief.
 */
export function classifyDispatchRetryability(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  if (error instanceof SubTeamFailedError) return error.retryable;
  return true;
}

export async function dispatchWithFailurePolicy(
  options: FailurePolicyDispatchOptions,
): Promise<FailurePolicyDispatchResult> {
  if (options.budgetAdmission) {
    return options.budgetAdmission.runChildDispatch({
      ...(options.signal ? { signal: options.signal } : {}),
      operation: () => dispatchWithFailurePolicyOwnership(options, true),
    });
  }
  return dispatchWithFailurePolicyOwnership(options, false);
}

async function dispatchWithFailurePolicyOwnership(
  options: FailurePolicyDispatchOptions,
  reservationOwnedByCaller: boolean,
): Promise<FailurePolicyDispatchResult> {
  const ledger = options.budgetLedger;
  const releaseSlot =
    ledger?.policy === "halt" && !reservationOwnedByCaller
      ? await ledger.acquireDispatchSlot()
      : undefined;
  const currentTotal =
    ledger?.policy === "halt"
      ? Math.max(options.state.totalCost, options.totalCost ?? 0)
      : options.totalCost ?? options.state.totalCost;
  const reservation =
    ledger?.policy === "halt" &&
    !reservationOwnedByCaller &&
    currentTotal !== undefined
      ? ledger.reserveRemaining(currentTotal)
      : undefined;

  try {
    if (ledger && (!Number.isFinite(currentTotal) || currentTotal < 0)) {
      throw new HaltError(options.agent.name, 'Invalid accumulated budget total; refusing further dispatches.');
    }
    if (reservation === null) {
      if (!ledger) {
        throw new Error('A budget reservation was refused without a budget ledger.');
      }
      throw new HaltError(
        options.agent.name,
        `Budget exceeded at $${ledger.capUsd.toFixed(2)}`,
      );
    }
    const result = await dispatchWithFailurePolicyUnreserved({
      ...options,
      totalCost: currentTotal,
    });
    if (result.interruption) return result;
    // A skip produced while shutting down is an abort, not a skip — never let
    // a cancelled dispatch be reported as a completed stage result. Thrown
    // failures during shutdown are rethrown by the engine-level abort guards.
    if (result.skipped && options.signal?.aborted) {
      throw abortReason(options.signal);
    }
    const updatedTotal = options.state.totalCost;
    if (ledger && (!Number.isFinite(updatedTotal) || updatedTotal < 0)) {
      throw new HaltError(options.agent.name, 'Invalid accumulated budget total after dispatch.');
    }
    if (
      ledger &&
      currentTotal !== undefined &&
      updatedTotal >= ledger.capUsd &&
      updatedTotal > currentTotal
    ) {
      // The dispatch completed and was paid for, so its result is returned
      // rather than discarded. state.totalCost already reflects the spend, so
      // the pre-dispatch reservation/canDispatch checks halt the NEXT dispatch.
      if (ledger.policy === "halt") {
        return {
          ...result,
          text:
            `${result.text}\n\n` +
            `⚠️ Budget limit reached after dispatch: $${updatedTotal.toFixed(2)} >= ` +
            `$${ledger.capUsd.toFixed(2)}. Further dispatches are halted.`,
        };
      }
      ledger.applyPolicy(updatedTotal);
      return {
        ...result,
        text:
          `${result.text}\n\n` +
          `⚠️ Budget warning: $${updatedTotal.toFixed(2)} of ` +
          `$${ledger.capUsd.toFixed(2)} spent. The latest dispatch reached ` +
          `or crossed the configured limit.`,
      };
    }
    return result;
  } finally {
    if (typeof reservation === "number") ledger?.releaseReservation(reservation);
    releaseSlot?.();
  }
}

async function dispatchWithFailurePolicyUnreserved(
  options: FailurePolicyDispatchOptions,
): Promise<FailurePolicyDispatchResult> {
  const {
    policy,
    fallbackAgent,
    fallbackRosterEntry,
    fallbackFinalPrompt,
    levelId,
    stageType,
    sessionId,
    rootSessionId,
    errorLogPath,
    onFailureRecorded,
    onAttemptFailure,
    onAttemptRecord,
    validateResult,
    retryDeadlineMs,
    budgetAdmission: _budgetAdmission,
    agent,
    ...baseOptions
  } = {
    ...options,
    // Minted once for this logical step, then carried by the rest-spread into
    // every attempt below. A retry and a fallback are then recognisably the
    // same call rather than unrelated dispatches, which is what lets a new
    // attempt supersede the bubble before it.
    logicalInvocationId: options.logicalInvocationId ?? randomUUID(),
  };

  const agentName = agent.name;
  const budgetAdjustedMaxRetries = getBudgetAdjustedMaxRetries(
    policy.maxRetries,
    options.budgetLedger,
    options.totalCost,
  );
  const maxAttempts = budgetAdjustedMaxRetries + 1;
  let lastError = "";
  let lastDispatchAttempt = 0;
  let validationRetryInstruction: string | undefined;
  let deadlineExpired = false;
  const dispatchStart = Date.now();

  // B4: Compute child pass-through budget values (must clamp to 0 minimum)
  const budgetUsd = options.budgetLedger
    ? Math.max(0, options.budgetLedger.capUsd - (options.totalCost ?? 0))
    : undefined;
  const budgetPolicy = options.budgetLedger?.policy;

  // B4: Pre-dispatch budget check
  let budgetWarning: string | undefined;
  if (options.budgetLedger && options.totalCost !== undefined) {
    const check = options.budgetLedger.canDispatch(options.totalCost);
    if (!check.allowed) {
      if (options.budgetLedger.policy === "halt") {
        throw new HaltError(
          agentName,
          `Budget exceeded: $${options.totalCost.toFixed(2)} >= $${options.budgetLedger.capUsd.toFixed(2)}`,
        );
      }
      // warn policy: build warning string to append to result text
      const pct = (
        (options.totalCost / options.budgetLedger.capUsd) *
        100
      ).toFixed(0);
      budgetWarning =
        `\u26a0\ufe0f Budget warning: $${options.totalCost.toFixed(2)} of ` +
        `$${options.budgetLedger.capUsd.toFixed(2)} spent (${pct}%). ` +
        `Next dispatch may exceed cap.`;
    }
  }

  // ── Circuit breaker check ──────────────────────────────────────────────────
  const circuitCheck = globalCircuitBreaker.check(agent.provider);
  if (!circuitCheck.allowed) {
    const cbError = circuitCheck.reason;
    if (!cbError) {
      throw new Error(`Circuit breaker blocked provider '${agent.provider}' without a reason.`);
    }
    const cbEvent: AgentErrorEvent = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      level_id: levelId,
      agent_name: agentName,
      attempt: 1,
      max_attempts: maxAttempts,
      policy: policy.policy,
      error_message: cbError,
      error_type: "agent_failure",
      duration_ms: 0,
    };
    if (rootSessionId) cbEvent.root_session_id = rootSessionId;
    logAgentError(errorLogPath, cbEvent);
    if (onFailureRecorded) onFailureRecorded(agentName, cbError);
    lastError = cbError;

    // Circuit breaker blocks are non-retryable, but a configured fallback uses
    // a different agent/provider and is exactly the recovery path we need.
    if (policy.policy === "skip") {
      return { text: "", cost: 0, skipped: true };
    }
    if (policy.fallbackAgent && fallbackAgent) {
      const fallbackStart = Date.now();
      try {
        const result = await dispatchToAgentOrTeam({
          ...baseOptions,
          levelId, stageType,
          // A circuit-breaker fallback is its own attempt, and it runs a
          // different agent, so it gets its own bubble.
          attempt: 1,
          agent: fallbackAgent,
          ...whenDefined(fallbackRosterEntry ?? baseOptions.rosterEntry, (definedValue) => ({ rosterEntry: definedValue })),
          finalPrompt: fallbackFinalPrompt ?? baseOptions.finalPrompt,
          ...whenDefined(budgetUsd, (definedValue) => ({ budgetUsd: definedValue })),
          ...whenDefined(budgetPolicy, (definedValue) => ({ budgetPolicy: definedValue })),
        });
        if (result.interruption) return result;
        const validatedResult = validateResult
          ? { ...result, text: validateResult(result.text) }
          : result;
        logAgentError(errorLogPath, {
          ...cbEvent,
          agent_name: agentName,
          attempt: maxAttempts + 1,
          error_message: `Circuit open for primary; dispatched fallback: ${policy.fallbackAgent}`,
          fallback_agent: policy.fallbackAgent,
          duration_ms: Date.now() - fallbackStart,
        });
        return budgetWarning
          ? { ...validatedResult, text: validatedResult.text + "\n\n" + budgetWarning }
          : validatedResult;
      } catch (error) {
        const fallbackError = error instanceof Error ? error.message : String(error);
        try {
          onAttemptFailure?.(agentName, error, maxAttempts + 1)
        } catch {
          // Observability must not replace the dispatch failure.
        }
        logAgentError(errorLogPath, {
          ...cbEvent,
          attempt: maxAttempts + 1,
          error_message: fallbackError,
          error_type: "fallback_failure",
          fallback_agent: policy.fallbackAgent,
          duration_ms: Date.now() - fallbackStart,
        });
        if (onFailureRecorded) onFailureRecorded(agentName, fallbackError);
        throw new HaltError(agentName, fallbackError);
      }
    }
    throw new HaltError(agentName, lastError);
  }

  // ── Retry loop ─────────────────────────────────────────────────────────────
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingDeadlineMs = retryDeadlineMs === undefined
      ? undefined
      : retryDeadlineMs - Date.now();
    if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) {
      deadlineExpired = true;
      lastError = "Approved Deep Research deadline expired.";
      break;
    }
    lastDispatchAttempt = attempt;
    const attemptStart = Date.now();
    let attemptResponseText: string | undefined;
    try {
      const result = await dispatchToAgentOrTeam({
        ...baseOptions,
        levelId, stageType,
        attempt,
        ...(remainingDeadlineMs === undefined
          ? {}
          : {
              timeoutMinutes: Math.max(
                1 / 60_000,
                Math.min(
                  baseOptions.timeoutMinutes ?? Number.POSITIVE_INFINITY,
                  remainingDeadlineMs / 60_000,
                ),
              ),
            }),
        userMessage: appendValidationRetryInstruction(
          baseOptions.userMessage,
          validationRetryInstruction,
        ),
        agent,
        ...whenDefined(budgetUsd, (definedValue) => ({ budgetUsd: definedValue })),
        ...whenDefined(budgetPolicy, (definedValue) => ({ budgetPolicy: definedValue })),
      });
      if (result.interruption) return result;
      attemptResponseText = result.text;
      if (retryDeadlineMs !== undefined && Date.now() >= retryDeadlineMs) {
        throw new Error("Approved Deep Research deadline expired.");
      }
      const validatedResult = validateResult
        ? { ...result, text: validateResult(result.text) }
        : result;
      try {
        onAttemptRecord?.({
          agentName,
          attempt,
          prompt: baseOptions.finalPrompt,
          userMessage: appendValidationRetryInstruction(
            baseOptions.userMessage,
            validationRetryInstruction,
          ),
          responseText: attemptResponseText,
          error: undefined,
          attemptStartedAtMs: attemptStart,
          elapsedMs: Date.now() - attemptStart,
        });
      } catch {
        // Observability must not replace a successful dispatch.
      }
      globalCircuitBreaker.recordSuccess(agent.provider, errorLogPath);
      if (budgetWarning) {
        return {
          ...validatedResult,
          text: validatedResult.text + "\n\n" + budgetWarning,
        };
      }
      return validatedResult;
    } catch (err) {
      try {
        onAttemptRecord?.({
          agentName,
          attempt,
          prompt: baseOptions.finalPrompt,
          userMessage: appendValidationRetryInstruction(
            baseOptions.userMessage,
            validationRetryInstruction,
          ),
          responseText: attemptResponseText,
          error: err,
          attemptStartedAtMs: attemptStart,
          elapsedMs: Date.now() - attemptStart,
        });
      } catch {
        // Observability must not replace the dispatch failure.
      }
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof DispatchResultValidationError && err.retryInstruction) {
        validationRetryInstruction = err.retryInstruction;
      }
      const durationMs = Date.now() - attemptStart;
      const isRetryable = classifyDispatchRetryability(err);
      const retryAfterMs =
        err instanceof ProviderError ? err.retryAfterMs : undefined;

      // Log each failed attempt
      const errorEvent: AgentErrorEvent = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        level_id: levelId,
        agent_name: agentName,
        attempt,
        max_attempts: maxAttempts,
        policy: policy.policy,
        error_message: lastError,
        error_type: "agent_failure",
        duration_ms: durationMs,
      };
      if (rootSessionId) errorEvent.root_session_id = rootSessionId;
      logAgentError(errorLogPath, errorEvent);

      // Notify engine to update metrics
      if (onFailureRecorded) onFailureRecorded(agentName, lastError);
      try {
        onAttemptFailure?.(agentName, err, attempt)
      } catch {
        // Observability must not replace or bypass the retry policy.
      }

      // Record failure in circuit breaker.
      //
      // A delegated child team ending blocked or failed is deliberately not a
      // provider failure. Counting it here would poison the provider's circuit
      // and suppress unrelated future dispatches on a health signal the
      // provider never produced — the same reason a model-output contract
      // failure is excluded.
      if (
        !(err instanceof DispatchResultValidationError) &&
        !(err instanceof SubTeamFailedError)
      ) {
        globalCircuitBreaker.recordFailure(agent.provider, errorLogPath);
      }

      if (retryDeadlineMs !== undefined && Date.now() >= retryDeadlineMs) {
        deadlineExpired = true;
        lastError = "Approved Deep Research deadline expired.";
        break;
      }

      // Non-retryable errors escalate immediately without wasting retries
      if (!isRetryable && attempt < maxAttempts) {
        // Break out to fallback / final escalation
        break;
      }

      // If more retries remain, wait then continue
      if (attempt < maxAttempts) {
        const retryWindowMs = retryDeadlineMs === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, retryDeadlineMs - Date.now());
        const delay = Math.min(
          computeRetryDelay(attempt, retryAfterMs),
          retryWindowMs,
        );
        if (delay > 0) {
          await waitForRetryDelay(delay, options.signal);
        }
        continue;
      }
    }
  }

  // ── Retries exhausted — try fallback agent ─────────────────────────────────
  if (!deadlineExpired && policy.fallbackAgent && fallbackAgent) {
    lastDispatchAttempt = maxAttempts + 1;
    const fallbackStart = Date.now();
    try {
      const result = await dispatchToAgentOrTeam({
        ...baseOptions,
        levelId, stageType,
        attempt: maxAttempts + 1,
        userMessage: appendValidationRetryInstruction(
          baseOptions.userMessage,
          validationRetryInstruction,
        ),
        agent: fallbackAgent,
        ...whenDefined(fallbackRosterEntry ?? baseOptions.rosterEntry, (definedValue) => ({ rosterEntry: definedValue })),
        finalPrompt: fallbackFinalPrompt ?? baseOptions.finalPrompt,
        ...whenDefined(budgetUsd, (definedValue) => ({ budgetUsd: definedValue })),
        ...whenDefined(budgetPolicy, (definedValue) => ({ budgetPolicy: definedValue })),
      });
      if (result.interruption) return result;
      const validatedResult = validateResult
        ? { ...result, text: validateResult(result.text) }
        : result;

      // Log successful fallback dispatch (info event — still a failure_attempt record)
      const fallbackEvent: AgentErrorEvent = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        level_id: levelId,
        agent_name: agentName,
        attempt: maxAttempts + 1,
        max_attempts: maxAttempts,
        policy: policy.policy,
        error_message: `Primary agent failed; dispatched fallback: ${policy.fallbackAgent}`,
        error_type: "agent_failure",
        fallback_agent: policy.fallbackAgent,
        duration_ms: Date.now() - fallbackStart,
      };
      if (rootSessionId) fallbackEvent.root_session_id = rootSessionId;
      logAgentError(errorLogPath, fallbackEvent);

      if (budgetWarning) {
        return {
          ...validatedResult,
          text: validatedResult.text + "\n\n" + budgetWarning,
        };
      }
      return validatedResult;
    } catch (err) {
      const fallbackError = err instanceof Error ? err.message : String(err);
      try {
        onAttemptFailure?.(agentName, err, maxAttempts + 1)
      } catch {
        // Observability must not replace the fallback failure.
      }
      const durationMs = Date.now() - fallbackStart;

      // Log fallback failure
      const fallbackFailEvent: AgentErrorEvent = {
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        level_id: levelId,
        agent_name: agentName,
        attempt: maxAttempts + 1,
        max_attempts: maxAttempts,
        policy: policy.policy,
        error_message: fallbackError,
        error_type: "fallback_failure",
        fallback_agent: policy.fallbackAgent,
        duration_ms: durationMs,
      };
      if (rootSessionId) fallbackFailEvent.root_session_id = rootSessionId;
      logAgentError(errorLogPath, fallbackFailEvent);

      if (onFailureRecorded) onFailureRecorded(agentName, fallbackError);
      lastError = fallbackError;
    }
  }

  // ── Final escalation — skip or halt ───────────────────────────────────────
  const totalDuration = Date.now() - dispatchStart;

  if (policy.policy === "skip") {
    logAgentRun(options.outputPath, {
      timestamp: new Date().toISOString(),
      event: "skip",
      session_id: sessionId,
      ...whenDefined(rootSessionId, (definedValue) => ({ root_session_id: definedValue })),
      assignment_path: options.outputPath,
      team: options.teamName ?? "",
      level_id: levelId,
      stage_type: stageType,
      ...whenDefined(options.triggerTool, (definedValue) => ({ trigger_tool: definedValue })),
      agent_name: agentName,
      agent_type: options.rosterEntry?.type === "team" ? "team" : "agent",
      from: options.fromName ?? options.teamName ?? "runtime",
      to: agentName,
      status: "skipped",
      duration_ms: totalDuration,
      model: agent.model,
      provider: agent.provider,
    });
    const skipEvent: AgentErrorEvent = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      level_id: levelId,
      agent_name: agentName,
      attempt: lastDispatchAttempt || 1,
      max_attempts: maxAttempts,
      policy: "skip",
      error_message: lastError,
      error_type: "skipped",
      duration_ms: totalDuration,
    };
    if (rootSessionId) skipEvent.root_session_id = rootSessionId;
    logAgentError(errorLogPath, skipEvent);

    if (onFailureRecorded) onFailureRecorded(agentName, lastError);
    return { text: "", cost: 0, skipped: true };
  }

  // Halt (or retry that ran out — without fallback and without skip policy, halt)
  const haltEvent: AgentErrorEvent = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    level_id: levelId,
    agent_name: agentName,
    attempt: lastDispatchAttempt || 1,
    max_attempts: maxAttempts,
    policy: "halt",
    error_message: lastError,
    error_type: "halt",
    duration_ms: totalDuration,
  };
  if (rootSessionId) haltEvent.root_session_id = rootSessionId;
  logAgentError(errorLogPath, haltEvent);

  if (onFailureRecorded) onFailureRecorded(agentName, lastError);
  throw new HaltError(agentName, lastError);
}
