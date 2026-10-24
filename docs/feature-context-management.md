# Feature: Context Window Management

Implemented 2026-03-31.

## Overview

By default, the discussion engine passes the full conversation history to every agent on every round. In an 8-agent, 5-round discussion this means each agent call on round 5 includes 32 prior messages before seeing the new question — input token costs grow linearly and unboundedly with round count.

Context window management lets you cap that growth. Three strategies cover the realistic range:

| Strategy | How it works | When to use |
|---|---|---|
| `full` | All history verbatim (default) | Short discussions (≤3 rounds), when full fidelity matters |
| `recent_N` | Keep only the last N rounds, discard earlier | Discussions where early framing is less important than recent exchanges |
| `rolling_summary` | Compress older rounds on the application default model; keep recent rounds verbatim | Long discussions where early context must be preserved but costs must stay bounded |

---

## Configuration

Context management is configured per discussion stage inside `team.yaml`:

```yaml
levels:
  - id: deliberation
    stage:
      type: discussion
      coordinator: facilitator
      participants:
        - agent-a
        - agent-b
      config:
        mode: deliberate

        # full (default — omit for backward compatibility)
        # context_strategy: full

        # recent_N: keep last 2 rounds
        context_strategy: recent_N
        context_window_rounds: 2

        # rolling_summary: compress every 3 rounds via haiku
        context_strategy: rolling_summary
        summarize_after_rounds: 3
```

> Only one `context_strategy` value is active at a time; the examples above show all three options as alternatives.

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `context_strategy` | `full \| recent_N \| rolling_summary` | `full` | Which strategy to apply |
| `context_window_rounds` | integer ≥ 1 | required with `recent_N` | **`recent_N` only.** Number of most-recent rounds to keep (the current round counts as one). |
| `summarize_after_rounds` | integer ≥ 1 | `3` | **`rolling_summary` only.** Compress after this many uncompressed rounds accumulate. |

---

## How `rolling_summary` compression works

1. At the start of each discussion round, `maybeCompressHistory` (in `engines/discussion.ts`) compresses when the completed rounds not yet compressed (`completedRounds - compressedUpToRound`) reach `summarize_after_rounds`.
2. When the trigger fires, `compressConversation()` (in `domains/agent-execution/context-compressor.ts`) sends the oldest uncompressed rounds to the application default model (or compresses mechanically when no default is usable or no run identity exists), with a prompt that asks it to preserve decisions, action items, disagreements, and key context.
3. The resulting summary replaces those raw messages in the active context. New rounds are appended verbatim until the next trigger.
4. From round `summarize_after_rounds + 1` onward, each agent call receives: `[compressed summary of rounds 1–N] + [verbatim messages from rounds N+1 to current]`.

**Failure handling:** If the compression call fails for any reason other than shutdown/abort (which rethrows), `compressConversation()` produces a mechanical fallback — a truncated-first-paragraph summary of each message — and the round proceeds without crashing. The fallback is noted in structured logs but does not surface as an error to the user.

---

## Cost impact

Example: 8-agent discussion, 5 rounds, ~500 words per agent response.

| Strategy | Input tokens / agent / round (round 5) | Total input tokens (all agents, round 5) |
|---|---|---|
| `full` (baseline) | ~5 000 | ~40 000 |
| `recent_N` (N=2) | ~1 250 | ~10 000 |
| `rolling_summary` (every 3) | ~2 000 | ~16 000 |

`rolling_summary` stabilises after the first compression cycle. A discussion that costs $2/round at round 3 stays near $2/round at round 10; without management it would cost ~$6/round at round 10.

---

## Relationship to `minutes.ts`

These are separate concerns:

- **`minutes.ts`** produces a narrative `minutes.md` log artifact written to the workspace after a discussion completes. It is a read-only record.
- **Context management** actively shapes what history each agent sees during the discussion. It does not affect `minutes.md`.

Both can be active at the same time. The minutes document always reflects the full uncompressed conversation; context management only affects runtime agent context.

---

## How to test

### Test `rolling_summary` compression

Edit `examples/team.yaml` — in the `brainstorm` level config, enable rolling summary and increase max rounds so compression has a chance to trigger:

```yaml
config:
  mode: brainstorm
  min_rounds: 1
  max_rounds: 5
  context_strategy: rolling_summary
  summarize_after_rounds: 2
  constraints:
    max_time_minutes: 10
    max_budget_usd: 10
```

Run:

```bash
cp examples/team.yaml examples/brainstorm-team/team.yaml   # edit this copy instead of examples/team.yaml
cd examples/brainstorm-team
pi -e ../../team-runtime/index.ts
```

**What to look for:**
1. Rounds 1–2 run normally with full history
2. At round 3, a brief pause occurs before agents respond — this is the haiku compression call firing (2 uncompressed rounds ≥ `summarize_after_rounds: 2`)
3. The dashboard cost ticks up slightly from the haiku call (~$0.001)
4. From round 3 onward, agents receive a compressed summary of rounds 1–2 plus raw messages from round 3+
5. Cost per round stabilises instead of growing linearly

To verify compression is active, compare the token counts shown on agent cards between round 2 and round 4 — round 4 should be similar to or smaller than round 2 despite more total conversation having occurred.

### Test `recent_N` truncation

Same setup, but use:

```yaml
config:
  mode: brainstorm
  min_rounds: 1
  max_rounds: 5
  context_strategy: recent_N
  context_window_rounds: 1
```

Run the team and let it go for 3+ rounds.

**What to look for:**
1. Agents in round 3 see only round-3 messages (the coordinator's round-3 prompt and any peer answers already given this round). The window counts the in-progress round, so positions from rounds 1 and 2 are not visible.
2. Token counts per agent stay flat across rounds (no growth)
3. Early context is lost — this is the expected tradeoff

### Test backward compatibility (`full`)

Run the brainstorm example with **no changes** to `team.yaml`:

```bash
cd examples/brainstorm-team
pi -e ../../team-runtime/index.ts
```

**What to look for:** Identical behavior to before these features were added — no new warnings, no compression, cost grows linearly with rounds as it always did.

### Test config validation

Temporarily add invalid config to `examples/team.yaml`:

```yaml
# Test 1: invalid strategy name
context_strategy: invalid_value
# Expected: config error on boot listing valid strategies

# Test 2: recent_N without required field
context_strategy: recent_N
# (omit context_window_rounds)
# Expected: config error requiring context_window_rounds

# Test 3: zero value clamping
context_strategy: recent_N
context_window_rounds: 0
# Expected: config warning, value clamped to 1
```

Run `pi -e ../../team-runtime/index.ts` after each change. The runtime should report config errors/warnings in the console at boot time without crashing.

**Remember to revert** `examples/team.yaml` after testing.

---

## Edge cases

- **`summarize_after_rounds` > total rounds:** No compression ever triggers. Behaves identically to `full`.
- **`context_window_rounds` > total rounds:** All rounds are kept. Behaves identically to `full`.
- **`context_strategy` omitted:** Defaults to `full` — fully backward-compatible.
- **Compression failure:** Mechanical fallback activates automatically; the round is not blocked.
- **`recent_N` with `context_window_rounds: 1`:** Each agent sees only the most recent round's messages — maximum cost reduction, but earlier context is lost entirely.
