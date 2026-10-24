# B4: Hierarchical Budget Accounting

Enforces a dispatch boundary on pipeline execution. When reported session
spend reaches the configured limit, the runtime either refuses the next
dispatch (halt: the crossing dispatch's paid result is returned with a notice)
or emits a warning. Budget enforcement propagates automatically
to child teams.

---

## Overview

Two modules implement this feature:

| Module | Purpose |
|--------|---------|
| `core/budget-ledger.ts` | Budget checks, FIFO enforced-budget dispatch slots, and reservations |
| `providers/cost.ts` | Normalized API/config/environment token pricing |

`state.totalCost` remains the spend source of truth. The ledger only holds
short-lived reservations while an enforced-budget dispatch is running, preventing
parallel calls from all passing the same stale pre-dispatch total.

---

## Configuration

### team.yaml — session budget

Add a top-level `budget` section:

```yaml
budget:
  cap_usd: 30.00        # Enforced dispatch limit for this session
  enforce: true          # true = create ledger; false = disable this team's ledger
  on_exceed: halt        # 'halt' or 'warn' (default)
```

When the entire section is absent, the runtime creates a finite `$25` warning
ledger. When a section is present, set `enforce: true` to activate its cap;
`enforce` currently parses as `false` when omitted from an explicit section.
Set `enforce: false` to opt that team out unless a parent supplies
`TEAM_BUDGET_CAP`.

> **Setting `cap_usd` without `enforce` is looser, not tighter.** Because an
> unstated `enforce` parses as `false`, `budget: { cap_usd: 5 }` leaves that cap
> inactive and, absent any runtime override, deletes the ledger entirely — weaker
> than writing no `budget` section at all, which still yields the `$25` advisory
> ledger. The parser now emits a warning naming this. The warning is scoped to the
> configured cap: `TEAM_BUDGET_CAP` can still supply one from the environment,
> which the parser cannot see. The check is `enforce == null`, so an absent key and
> an explicit `enforce: null` are treated alike as "not stated"; an explicit
> `enforce: false` is a deliberate opt-out and does not warn.

### Provider pricing

HTTP providers use API-reported cost when available (notably OpenRouter usage
cost). Otherwise they calculate USD cost from returned token counts and rates
in the agent's `provider_config`:

```yaml
provider_config:
  input_cost_per_million_usd: 2.00
  output_cost_per_million_usd: 8.00
```

Rates can also be supplied process-wide:

```bash
export TEAM_PROVIDER_PRICING_JSON='{"openai:gpt-example":{"inputPerMillion":2,"outputPerMillion":8},"deepseek:*":{"inputPerMillion":1,"outputPerMillion":3}}'
```

An explicit enforced limit fails closed if an HTTP provider returns token usage but
has no reported or configured USD price. Advisory mode keeps the result and
adds a visible pricing warning.

### team.yaml — stage constraints

```yaml
levels:
  - stages:
      - type: discussion
        constraints:
          max_budget_usd: 5.00          # existing advisory limit (unchanged)
          agent_timeout_minutes: 8       # per-dispatch timeout (B2 feature)
```

> Stage constraints reject `enforce` and `on_exceed` at parse time.
> Stage `max_budget_usd` is advisory; `agent_timeout_minutes` and
> `max_time_minutes` are consumed by the runtime.

---

## Budget Cap Priority

When the runtime boots it determines the effective cap in this order (first wins):

| Priority | Source |
|----------|--------|
| 1 | `TEAM_BUDGET_CAP` environment variable (set by parent team) |
| 2 | `budget.cap_usd` in `team.yaml` |
| 3 | `composition.spawn_limits.max_total_budget_usd` in `team.yaml` |
| 4 | `$25` advisory default |

`BudgetLedger` is created by default. `budget.enforce: false` disables it for a
team; a parent `TEAM_BUDGET_CAP` always takes precedence.

---

## How It Works

### Pre-dispatch check

Before every agent or team dispatch, `dispatchWithFailurePolicy()` checks:

For `halt` policy, dispatches also acquire a FIFO slot and reserve all remaining
capacity until completion. This deliberately serializes calls whose final cost
is not known until completion; the next caller then evaluates the updated total.

```
dispatchWithFailurePolicy(options)
  ├── budgetLedger.canDispatch(state.totalCost)
  │     ├── allowed: true  → continue to dispatch
  │     └── allowed: false
  │           ├── policy 'halt' → throw HaltError("Budget exceeded: $X >= $Y")
  │           └── policy 'warn' → append ⚠️ warning to result text, continue
  └── dispatch agent / team
```

After the provider reports final usage, `halt` returns the paid result with a
"Budget limit reached after dispatch" notice, and the next dispatch is refused
with `HaltError`; `warn` calls `applyPolicy()` and appends a visible message to
that result. A provider can still charge more than the remaining
amount during the final request because usage is known only after completion.
The configured amount is therefore an enforced dispatch boundary, not a
prepaid provider-side spending ceiling.

The `HaltError` path integrates with the existing engine halt mechanism — all
five engine types (`broadcast`, `discussion`, `pipeline`, `chain`, `review`)
already catch `HaltError` and surface it correctly.

### Child team budget propagation

When a parent team dispatches a child team, the remaining budget is forwarded
automatically:

```
parent remaining = Math.max(0, cap - state.totalCost)

child receives:
  TEAM_BUDGET_CAP    = remaining budget (clamped to 0 minimum, never negative)
  TEAM_BUDGET_POLICY = parent's policy ('halt' | 'warn')
```

The child reads these on boot, creates its own `BudgetLedger`, and enforces
against its own `state.totalCost`. When the parent spawns a second child, it
re-computes the remaining budget from its own accumulated total — so all children
collectively share the parent's cap.

### Warn policy visibility

When policy is `warn` and the cap is reached, the warning appears in the
**dispatch result text** (not just `console.error`):

```
⚠️ Budget warning: $28.50 of $30.00 spent (95%). Next dispatch may exceed cap.
```

This is visible in the pipeline coordinator's output even in subprocess contexts
where stderr is not surfaced.

---

## Budget ledger: `core/budget-ledger.ts`

```typescript
export type BudgetPolicy = 'halt' | 'warn'

export interface BudgetLedgerConfig {
  capUsd: number
  policy: BudgetPolicy
}

export class BudgetExceededError extends Error {
  readonly budgetCapUsd: number
  readonly totalSpent: number
  readonly policy: BudgetPolicy
}

export class BudgetLedger {
  constructor(config: BudgetLedgerConfig)

  // Pre-dispatch gate — pass state.totalCost
  canDispatch(currentTotalCost: number): {
    allowed: boolean
    remaining: number
    reason?: string
  }

  // Enforced-budget concurrency guard. Unknown-cost dispatches take a FIFO slot
  // and reserve currently available capacity until their result is recorded.
  acquireDispatchSlot(): Promise<() => void>
  reserveRemaining(currentTotalCost: number): number | null
  releaseReservation(id: number): void
  get reservedUsd(): number

  // Stage-level gate — pass stage's own accumulated cost and its limit
  checkStageBudget(stageCostSoFar: number, stageLimit: number): {
    allowed: boolean
    remaining: number
  }

  // Throws BudgetExceededError (halt) or logs to console.error (warn)
  applyPolicy(currentTotalCost: number): void

  get capUsd(): number
  get policy(): BudgetPolicy
}
```

> `BudgetExceededError` is used by `applyPolicy()` for callers that want
> fine-grained error handling. Within `dispatchWithFailurePolicy()`, budget
> exceeded with `halt` policy is translated to `HaltError` for engine
> compatibility.

---

## Type Changes

### New: `SessionBudgetConfig`

```typescript
export interface SessionBudgetConfig {
  cap_usd: number
  enforce: boolean
  on_exceed: 'halt' | 'warn'
}
```

### `TeamConfig` (extended, backward-compatible)

```typescript
export interface TeamConfig {
  // ... existing fields ...
  budget?: SessionBudgetConfig   // NEW — optional, undefined when section absent
}
```

### `BaseEngineContext` (extended)

```typescript
export interface BaseEngineContext<TConfig extends StageConfig = StageConfig> {
  // ... existing fields ...
  budgetLedger?: BudgetLedger   // NEW — undefined when enforcement not configured
}
```

### `RuntimeContext` (extended)

```typescript
export interface RuntimeContext {
  // ... existing fields ...
  budgetLedger?: BudgetLedger   // NEW
}
```

---

## Constants (in `core/constants.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_BUDGET_POLICY` | `'warn'` | Fallback when policy is not specified |
| `DEFAULT_SESSION_BUDGET_USD` | `25` | Finite advisory fallback |

---

## Out of Scope

**Stage-level constraint enforcement.** `enforce` and `on_exceed` are rejected
at parse time. Stage `max_time_minutes` and `max_budget_usd`
remain, but they are not alike: `max_budget_usd` is genuinely advisory, while
`max_time_minutes` is consumed as the delegated routing coordinator's timeout
(the delegated-routing branch of `startStageAutostart` in
`team-runtime/index.ts`) and as the time-remaining warning input.
Only session-level *budget* enforcement is active.
Stage-level enforcement remains a possible follow-up, to be designed on its own
terms rather than implied by an unread key.

**Real-time parent-child cost sync** — the parent tracks a child team's total cost
after the child completes (via `teamResult.cost`), not in real time during
execution. FIFO reservations protect parallel dispatches inside one runtime
process; there is no shared, atomic reservation ledger across separate parent
and child processes.

---

## Compatibility

- `budget.enforce: false` retains an explicit opt-out.
- `TEAM_BUDGET_CAP` / `TEAM_BUDGET_POLICY` are only set in child envs when a
  parent ledger exists.
- Subscription/local providers are marked as zero marginal cost; HTTP providers
  require reported or configured pricing for hard enforcement.
- A `warn` policy is advisory by definition: it records the warning and permits
  the dispatch to continue beyond the cap.
