/**
 * Team Runtime — Constants
 *
 * Single source of truth for all repeated literal values.
 * Grouped by domain. Every magic string or number used in more than
 * one place lives here.
 */

// ─── Agent Tiers ────────────────────────────────────────────────────────────

export const AGENT_TIER = {
  ORCHESTRATION: "orchestration",
  STRATEGIC: "strategic",
  EXECUTION: "execution",
} as const;

export type AgentTier = (typeof AGENT_TIER)[keyof typeof AGENT_TIER];

// ─── Stage Types ────────────────────────────────────────────────────────────

export const STAGE_TYPE = {
  ROUTING: "routing",
  DISCUSSION: "discussion",
  PIPELINE: "pipeline",
  CHAIN: "chain",
  BROADCAST: "broadcast",
  REVIEW: "review",
} as const;

// ─── Discussion Modes ───────────────────────────────────────────────────────

export const DISCUSSION_MODE = {
  BRAINSTORM: "brainstorm",
  EVALUATE: "evaluate",
  DEBATE: "debate",
  DELIBERATE: "deliberate",
} as const;

// ─── Level Status ───────────────────────────────────────────────────────────

export const LEVEL_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// ─── Stage Lifecycle Status ─────────────────────────────────────────────────

export const STAGE_LIFECYCLE_STATUS = {
  NOT_STARTED: "not_started",
  READY: "ready",
  RUNNING: "running",
  WAITING_ON_WORKER: "waiting_on_worker",
  WAITING_ON_VALIDATOR: "waiting_on_validator",
  REVISING: "revising",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  FAILED: "failed",
} as const;

// ─── Agent State ────────────────────────────────────────────────────────────

export const AGENT_STATE = {
  IDLE: "idle",
  ACTIVE: "active",
  DONE: "done",
  ERROR: "error",
} as const;

// ─── Aggregation Modes ──────────────────────────────────────────────────────

export const AGGREGATION_MODE = {
  MERGE: "merge",
  VOTE: "vote",
  BEST: "best",
} as const;

// ─── Gate Strictness ────────────────────────────────────────────────────────

export const GATE_STRICTNESS = {
  HARD: "hard",
  SOFT: "soft",
  OFF: "off",
} as const;

// ─── Default Models ─────────────────────────────────────────────────────────

export const DEFAULT_MODEL = "default";
export const DEFAULT_PROVIDER = "codex";
export const DEFAULT_ORCHESTRATION_MODEL = "gpt-5.4-mini";
export const MINUTES_MODEL = "default";

// ─── Default Thinking Levels ────────────────────────────────────────────────

export const DEFAULT_THINKING = "medium" as const;
export const DEFAULT_ORCHESTRATION_THINKING = "high" as const;
export const DEFAULT_EXECUTION_THINKING = "low" as const;
export const MINUTES_THINKING = "low" as const;

// ─── Policy Limits ──────────────────────────────────────────────────────────

export const DEFAULT_MAX_SPAWN_DEPTH = 3;
export const DEFAULT_MAX_LOOPBACKS = 3;
export const DEFAULT_GATE_TRANSFORM_TIMEOUT_MS = 5 * 60 * 1000;
/** Bounded wait for auxiliary LLM calls (minutes, compression, gate validators, reflections). */
export const DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES = 5;

// ─── Default Constraints ────────────────────────────────────────────────────

export const DEFAULT_MAX_TIME_MINUTES = 10;
export const DEFAULT_MAX_BUDGET_USD = 10;

// ─── Templates ─────────────────────────────────────────────────────────────

export const MINUTES_TEMPLATE_FILENAME = "minutes-template.md";

// ─── UI ─────────────────────────────────────────────────────────────────────

export const MAX_NOTIFY_LENGTH = 3000;

// ─── Failure Policy ─────────────────────────────────────────────────────────

export const FAILURE_POLICY = {
  RETRY: "retry",
  FALLBACK: "fallback",
  SKIP: "skip",
  HALT: "halt",
} as const;

export const DEFAULT_MAX_RETRIES = 2;
export const MAX_ALLOWED_RETRIES = 5;
export const RETRY_DELAY_MS = 2000;
export const CRITICAL_STAGE_TYPES = new Set(["pipeline", "chain", "review"]);
export const ADDITIVE_STAGE_TYPES = new Set(["discussion", "broadcast"]);

// ─── Adaptive Retry & Circuit Breaker ────────────────────────────────────────

/** Base delay for exponential backoff (ms). */
export const RETRY_BACKOFF_BASE_MS = 1000;
/** Maximum delay between retries (ms). */
export const RETRY_BACKOFF_MAX_MS = 30000;
/** Budget warning threshold — when exceeded, reduce retries to save spend. */
export const BUDGET_WARN_THRESHOLD_PCT = 0.9;
/** Circuit breaker: consecutive failures before opening. */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
/** Circuit breaker: cooldown duration while open (ms). */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;

// ─── Context Management ─────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_STRATEGY = "full" as const;
export const DEFAULT_CONTEXT_WINDOW_ROUNDS = 2;
export const DEFAULT_SUMMARIZE_AFTER_ROUNDS = 3;

// ─── Rate Limiting ──────────────────────────────────────────────────────────

export const DEFAULT_MAX_CONCURRENT_AGENTS = 3;
export const DEFAULT_DISPATCH_DELAY_MS = 500;

// ─── Budget & Shutdown ───────────────────────────────────────────────────────

export const DEFAULT_BUDGET_POLICY = "warn" as const;
export const DEFAULT_SESSION_BUDGET_USD = 25;
export const SHUTDOWN_GRACE_PERIOD_MS = 5000;
export const SIGKILL_GRACE_PERIOD_MS = 10000;
/**
 * Graceful window the root task supervisor allows before it SIGKILLs the root
 * task's process group. This is the real default used by `terminateTaskProcess`.
 */
export const TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS = 1000;
/**
 * TERM -> SIGKILL grace for a delegated child's own process group.
 *
 * A delegated child is spawned `detached`, so it lives in a different process
 * group from the root task. The supervisor signals only the root's group, then
 * SIGKILLs it — uncatchably — after `TASK_SUPERVISOR_GRACEFUL_TIMEOUT_MS`. Any
 * escalation the root has merely *scheduled* dies with it. So the child's whole
 * TERM -> KILL -> confirmed-dead operation has to finish inside the window the
 * root is guaranteed to still be alive. Using the shared 10s value here meant
 * the outer kill always won by nine seconds and orphaned the group to PID 1.
 */
export const DELEGATED_SIGKILL_GRACE_PERIOD_MS = 250;
/**
 * Time allowed, after SIGKILL, to observe the delegated group actually gone.
 *
 * Budget inside the supervisor's 1000ms: 250ms grace + 250ms confirmation =
 * 500ms, leaving 500ms of margin. That margin is not slack for this operation —
 * it belongs to the supervisor, which polls process liveness every 25ms
 * (`pollIntervalMs`) and needs time to observe its own SIGTERM result before
 * escalating. Spending it here would race the very deadline this ordering
 * exists to stay inside.
 */
export const DELEGATED_TERMINATION_CONFIRM_MS = 250;
export const CLI_PROVIDER_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const CLI_PROVIDER_MAX_STDERR_BYTES = 1024 * 1024;
