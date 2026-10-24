# Feature: Rate Limiting

Implemented 2026-03-31.

## Overview

The broadcast engine fires all agents simultaneously via `Promise.all`. For a broadcast with 10 agents this means 10 subprocess spawns in parallel, potentially saturating the Anthropic API, exceeding OS file-descriptor limits, or triggering rate-limit errors from the model provider.

Rate limiting introduces a concurrency semaphore and an inter-dispatch delay to throttle how many agent subprocesses run at once.

---

## Configuration

Rate limiting is configured at the top level of `team.yaml` and applies to the entire team session:

```yaml
rate_limiting:
  max_concurrent: 2      # maximum simultaneous agent subprocesses
  delay_between_ms: 500  # milliseconds to wait after acquiring the semaphore
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `max_concurrent` | integer ≥ 1 | `3` | Maximum simultaneous agent subprocesses across all broadcast stages |
| `delay_between_ms` | integer ≥ 0 | `500` | After semaphore acquisition, waits whatever remains of this many ms since the previous dispatch start (nothing if that much time has already passed) |

---

## Which engines are affected

| Engine | Affected? | Notes |
|---|---|---|
| **Broadcast** | ✅ Yes | Agents run concurrently — rate limiting wraps each dispatch |
| **Pipeline** | No | Tasks are dispatched one at a time by the coordinator |
| **Chain** | No | Steps run sequentially by design |
| **Review** | No | Producer/reviewer alternate; inherently serialized |
| **Discussion** | No | Agents receive the `converse` tool sequentially within each round |

Rate limiting is currently meaningful only for broadcast stages. The semaphore is session-wide, so if you run multiple broadcast stages in sequence, the limit applies across all of them.

---

## How it interacts with failure policies

When an agent dispatch triggers a retry (via `on_failure.policy: retry`), the retry holds the semaphore slot until the retry completes or all attempts are exhausted. This is intentional: a retrying agent is still an active subprocess from the system's perspective.

If an agent is skipped (policy: `skip`) the semaphore slot is released immediately after the first failure — no additional hold.

---

## Dashboard behavior

Without rate limiting, all broadcast agents transition from `IDLE` to `ACTIVE` simultaneously. With rate limiting enabled, agents appear `IDLE` on the dashboard until the semaphore has a free slot, then transition to `ACTIVE` one (or `max_concurrent`) at a time. This makes it easy to see that throttling is in effect — the IDLE→ACTIVE transitions are staggered rather than instantaneous.

---

## How to test

### Test rate-limited broadcast

You need a team config with a broadcast stage. If you don't have one, add this to a test `team.yaml`:

```yaml
rate_limiting:
  max_concurrent: 1          # serialize all dispatches — easiest to observe
  delay_between_ms: 1000     # 1 second gap between each agent

levels:
  - id: research
    name: Research
    order: 0
    stage:
      type: broadcast
      coordinator: facilitator
      fan_out:
        - agent-a
        - agent-b
        - agent-c
      config:
        aggregation: merge
        constraints:
          max_time_minutes: 5
          max_budget_usd: 5
        output:
          format: research.md
```

Alternatively, add the `rate_limiting:` block to any existing team config that already has a broadcast level.

Run:

```bash
pi -e /path/to/Pipeline-template/team-runtime/index.ts
```

**What to look for:**
1. Dashboard shows agents transitioning IDLE → ACTIVE → DONE **one at a time** (with `max_concurrent: 1`)
2. There is a visible ~1 second gap between each agent starting (`delay_between_ms: 1000`)
3. All agents still complete and results are aggregated normally
4. No rate-limit errors from the model provider

### Test with higher concurrency

Change to `max_concurrent: 2` with 4+ fan-out agents:

```yaml
rate_limiting:
  max_concurrent: 2
  delay_between_ms: 500
```

**What to look for:** At most 2 agents show ACTIVE simultaneously on the dashboard. As one completes, the next waiting agent starts within ~500ms.

### Test backward compatibility (no rate limiting)

Remove or comment out the `rate_limiting:` section entirely, then run a broadcast stage:

```bash
pi -e /path/to/Pipeline-template/team-runtime/index.ts
```

**What to look for:** All broadcast agents go ACTIVE simultaneously (the pre-rate-limiting behavior). No warnings, no changes.

### Test config validation

Temporarily set an invalid value:

```yaml
rate_limiting:
  max_concurrent: 0
```

**Expected:** Config warning on boot — value is clamped to 1. The runtime starts normally with effective `max_concurrent: 1`.

**Remember to revert** your config after testing.

---

## Defaults and tuning guidance

**Defaults (`max_concurrent: 3`, `delay_between_ms: 500`)** provide a conservative starting point — 3 agents running at once with a 500 ms gap between each new dispatch, enough to avoid bursting the API while keeping throughput reasonable.

**Higher throughput:** `max_concurrent: 5`, `delay_between_ms: 200`. Good for cheap models (haiku) where rate limits are generous.

**Heavy broadcast stages (10+ agents):** `max_concurrent: 2`, `delay_between_ms: 500`. Slower but least likely to trigger provider rate limits.

**Single-agent broadcast (testing):** `max_concurrent: 1` serializes all dispatches completely — useful for debugging ordering issues.

`delay_between_ms` adds latency even when the semaphore has free slots. Set it to `0` if you want pure concurrency limiting without inter-dispatch delay — the semaphore alone may be sufficient for providers with generous rate limits.
