# B2: Subprocess Timeout + Graceful Shutdown

Prevents hung agent subprocesses from locking a pipeline indefinitely, and ensures
clean state persistence when the runtime receives an OS signal.

---

## Overview

Two new modules implement this feature:

| Module | Purpose |
|--------|---------|
| `core/timeout-manager.ts` | Per-dispatch `TimeoutError`; `AbortSignal` composition. The SIGTERM → SIGKILL cascade is in each provider's `killProc`, called from its abort handler |
| `core/lifecycle.ts` | SIGTERM/SIGINT handler installation; coordinated abort + persist + safety-net exit |

---

## Configuration

### Ordinary Agent chat replies

`AGENT_REPLY_PROVIDER_DEADLINE_MS` in `services/agent-reply-lifecycle.ts`
sets a 30-minute wall-clock ceiling for each ordinary chat or dialogue reply.
Expiry aborts that provider operation and records `provider_interrupted`; a
late answer is not published. Stop and the provider silence watchdog remain
independent cancellation paths.

This ceiling does not wrap Deep Research or other Workflow workers. Deep
Research uses its approved plan's research budget and dispatch constraints via
`domains/deep-research/deep-research-pipeline-adapter.ts`, including research
budgets longer than 30 minutes. Selecting a research Agent in ordinary chat
still uses the ordinary chat limit; a Deep Research Workflow is the separate
long-running operation.

Coverage: the default-boundary test in
`tests/integration/agent-reply-lifecycle.test.ts` and the two-hour plan test in
`tests/unit/deep-research-dispatch-budget.test.ts`.

### Per-agent timeout

Add `agent_timeout_minutes` to any stage's `constraints` block in `team.yaml`:

```yaml
levels:
  - stages:
      - type: discussion
        constraints:
          max_time_minutes: 60
          max_budget_usd: 5.00
          agent_timeout_minutes: 8        # NEW — per-dispatch subprocess timeout
```

When set, each individual agent subprocess call is given this many minutes.
If the model API hangs, the runtime sends **SIGTERM**, waits 10 seconds, then
sends **SIGKILL** if the process is still alive. The dispatch then rejects with
`TimeoutError`, and the stage's failure policy (`retry` / `fallback` / `halt`)
activates.

If `agent_timeout_minutes` is absent the subprocess runs until it completes or
the parent is shut down externally — existing behaviour is unchanged.

---

## How It Works

### Timeout flow (`runAgent`)

```
dispatchWithFailurePolicy()
  └── dispatchToAgentOrTeam(timeoutMinutes)
        └── runAgent(options)
              ├── setTimeout(abort, timeoutMs)          ← timeoutHandle
              │     └── aborts a timeout AbortController combined with options.signal
              │           └── provider killProc (e.g. providers/pi.ts):
              │                 SIGTERM, then SIGKILL after SIGKILL_GRACE_PERIOD_MS
              ├── catch: timeout abort → throw new TimeoutError(...)
              └── finally: clearTimeout(timeoutHandle)
```

`TimeoutError` is an `Error` subclass with prototype chain fixed for reliable
`instanceof` across module boundaries:

```typescript
import { TimeoutError } from './core/timeout-manager.js'

// Fields available on every TimeoutError:
error.agentName   // string — agent that timed out
error.timeoutMs   // number — configured limit
error.elapsedMs   // number — currently set to the configured limit (same value as timeoutMs)
```

### Signal composition (`combineAbortSignals`)

Each engine call combines the dispatch-level signal with the runtime's global
shutdown signal:

```typescript
import { combineAbortSignals } from '../core/timeout-manager.js'

const combined = combineAbortSignals(dispatchSignal, ctx.shutdownSignal)
// Aborting EITHER signal aborts the combined signal
```

Uses `AbortSignal.any()` unconditionally, with no fallback for older Node. With
no defined inputs it returns a signal that never aborts.

### Graceful shutdown on SIGTERM / SIGINT

`installShutdownHandlers` is called once during `session_start`. When either
signal fires:

1. All active subprocesses receive `proc.kill()` via the abort chain
2. Pipeline state is persisted synchronously via `persistState()`
3. No exit timer is armed. `gracefulShutdown()` in `core/lifecycle.ts` offers a
   5-second unreffed `process.exit(1)` safety net, but the runtime's signal
   handler does not call it. The handler aborts, stops dev services, clears
   timers and persists state.

Guards prevent double-execution:
- **Module-level registry**: every call adds a live registration behind one
  shared process listener per signal, so handlers do not accumulate. The call
  returns a registration the caller disposes; the runtime disposes the previous
  one before installing again on `session_start`.
- **Per-invocation `cleanedUp` flag** — SIGTERM and SIGINT can fire simultaneously
  on Ctrl+C in some terminals; `onShutdown` runs exactly once.

---

## Exports

### `core/timeout-manager.ts`

```typescript
export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal

export class TimeoutError extends Error {
  readonly agentName: string
  readonly timeoutMs: number
  readonly elapsedMs: number
}
```

### `core/lifecycle.ts`

```typescript
export interface ShutdownHandlerOptions {
  onShutdown: () => void
}

export function installShutdownHandlers(options: ShutdownHandlerOptions): ShutdownRegistration  // { dispose(): void }
export function gracefulShutdown(
  controller: AbortController,
  persistFn: () => void,
  gracePeriodMs?: number,   // default 5000 ms
): void
```

---

## Type Changes

### `ConstraintConfig` (B2 extension; current shape)

```typescript
export interface ConstraintConfig {
  max_time_minutes: number
  max_budget_usd: number
  agent_timeout_minutes?: number        // per-dispatch timeout — this feature's addition
}
```

> Stage constraints reject `enforce` and `on_exceed` at parse time.
> `agent_timeout_minutes` remains enforced by every engine. Only session-level
> budget configuration enables spend-cap enforcement.

### `BaseEngineContext`

```typescript
export interface BaseEngineContext<TConfig extends StageConfig = StageConfig> {
  // ... existing fields ...
  shutdownSignal?: AbortSignal   // NEW — runtime global abort signal
}
```

### `RuntimeContext` (extended)

```typescript
export interface RuntimeContext {
  // ... existing fields ...
  shutdownController: AbortController   // NEW — parent of shutdownSignal
}
```

---

## Constants (in `core/constants.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `SHUTDOWN_GRACE_PERIOD_MS` | `5000` | Safety-net timer after SIGTERM |
| `SIGKILL_GRACE_PERIOD_MS` | `10000` | SIGKILL fallback delay after SIGTERM |

---

## Configuration compatibility

- Omitting `agent_timeout_minutes` leaves the subprocess without a dispatch timeout.
- SIGTERM/SIGINT handlers are installed for graceful interruption.
- Stage-level `enforce` and `on_exceed` keys are rejected with a parse error.
