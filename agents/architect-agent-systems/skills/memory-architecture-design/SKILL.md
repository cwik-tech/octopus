---
name: memory-architecture-design
description: Design agent memory as three explicit tiers — working, episodic, long-term — each with a stated read and write policy, then budget the context window per turn and define the compaction trigger and strategy.
---

# Memory Architecture Design

## Purpose

"The agent should remember" is not a requirement. This skill converts it into three tiers with explicit policy, a token budget that is summed rather than estimated, and a compaction strategy that fires on a defined trigger. Memory systems fail on the write side far more often than the read side, so the write policy is the centre of this work.

## When to use

- State must persist across turns or across sessions.
- Someone describes memory without naming what is stored, for how long, or who writes it.
- The context window is filling and no one has measured what is in it.
- Retrieval quality is degrading over time as stored content accumulates.

## Step 1 — Tier the memory

Split into exactly three tiers. Resist inventing more; extra tiers usually indicate an unclear write policy rather than a genuine distinction.

| Tier | Lifetime | Typical content | Lives where |
|---|---|---|---|
| **Working** | Current turn or current task | Scratch reasoning, intermediate tool results, the active plan | In-context |
| **Episodic** | Current session or conversation | What happened this session, decisions made, corrections received | In-context, summarized, or external with recall |
| **Long-term** | Across sessions | Stable facts, preferences, learned patterns, durable artifacts | External store, retrieved on demand |

For each tier, if you cannot name concrete content it holds in *this* system, the tier is not needed.

## Step 2 — Write policy per tier

This is the step that is usually skipped, and it is the step that determines whether the system degrades. For each tier answer all six:

1. **Who writes?** The agent autonomously, the harness deterministically, or a human?
2. **What triggers a write?** Every turn, task completion, an explicit signal, a threshold?
3. **What is written?** Raw content, a summary, a structured record?
4. **What is overwritten or merged?** Does a new write supersede an old one, and on what key?
5. **What is the retention rule?** Expiry, count cap, size cap, or never expires?
6. **What is never written?** Secrets, transient errors, unconfirmed inferences, user PII.

A long-term tier that the agent writes to autonomously, every turn, with no retention rule and no "never write" list will fill with noise and degrade retrieval. If that is the proposed design, name it as the primary risk.

## Step 3 — Read policy per tier

For each tier answer:

- **When is it read?** Every turn, on demand via a tool, or on a trigger condition?
- **How much enters context?** A fixed budget in tokens, or unbounded?
- **How is relevance decided?** Recency, similarity, explicit key, or the agent asks?
- **What happens on a miss?** Proceed without it, ask the user, or fail?

Unbounded reads are the most common cause of context budget blowout. Every read path needs a ceiling.

## Step 4 — Budget the context window

Sum, do not estimate. Produce a table for turn 1, turn 5, and turn 20:

| Component | Turn 1 | Turn 5 | Turn 20 |
|---|---|---|---|
| System prompt | | | |
| Tool definitions | | | |
| Long-term memory read | | | |
| Episodic memory / history | | | |
| Working scratch | | | |
| Current turn input | | | |
| **Total** | | | |
| **Headroom** | | | |

If headroom at turn 20 is negative or thin, the design is wrong regardless of how good the capability story sounds. Fix the budget before adding capability.

## Step 5 — Compaction

Define:

- **Trigger** — a token threshold, a turn count, or a task boundary. Pick one; "when it gets full" is not a trigger.
- **Strategy** — summarize, evict oldest, evict least-relevant, or checkpoint to episodic and clear.
- **What survives compaction unconditionally** — the task goal, active constraints, and any user correction. Losing a correction to compaction produces the worst class of agent failure: confidently repeating a mistake the user already fixed.
- **What compaction costs** — the extra model call, its latency, and its own token cost.

## Step 6 — Boundary with retrieval

When a retrieval or knowledge-systems specialist is also in scope, state the split explicitly:

- **They own:** ingestion, chunking, index topology, hybrid search, reranking, retrieval evaluation.
- **You own:** what the agent writes back, when, the retention rule, and how much of the retrieved result enters the context budget.

Write this boundary down. Two specialists each designing half a memory system, without saying which half, is the common failure.

## Output

1. **Tier table** — the three tiers with concrete content for this system.
2. **Write policy table** — all six questions answered per tier.
3. **Read policy table** — trigger, ceiling, relevance rule, miss behavior per tier.
4. **Context budget** — summed at turn 1, 5, and 20, with headroom.
5. **Compaction** — trigger, strategy, protected content, cost.
6. **Retrieval boundary** — who owns what, if a retrieval specialist is in scope.
7. **Primary risk** — the single most likely degradation path for this design.

## Red lines

- Never accept a memory tier without a write policy.
- Never estimate the context budget when the components can be counted.
- Never allow compaction to evict a user correction or an active constraint.
- Never leave the retrieval/memory boundary implicit when both specialists are convened.
