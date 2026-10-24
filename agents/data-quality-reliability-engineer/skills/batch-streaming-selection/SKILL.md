---
name: batch-streaming-selection
description: >
  Decide between batch, micro-batch, streaming, and hybrid processing using latency, event-time, ordering, replay, state, complexity, and cost. Use when ingestion cadence or processing mode is unsettled or when a streaming proposal needs justification.
---

# Batch and Streaming Selection

## Method

1. Quantify the consumer's maximum useful data age and response time. Distinguish true business deadlines from preference.
2. Define event-time requirements, ordering scope, late-arrival tolerance, correction behavior, and the effect of duplicates.
3. Define throughput, burst shape, retention, replay window, backfill frequency, and state size.
4. Compare batch, micro-batch, streaming, and hybrid options against the same requirements.
5. Include operational complexity, on-call load, deployment model, failure recovery, testability, team capability, and total cost.
6. Prefer the least complex option that meets the requirement with an explicit margin. Do not choose streaming because the source emits events.
7. If hybrid is selected, define one authority for shared semantics and how live and backfill paths reconcile.

## Decision table fields

- End-to-end latency and freshness
- Event-time and processing-time semantics
- Ordering and late data
- Delivery and deduplication guarantees
- Stateful processing and checkpoints
- Replay, backfill, and reconciliation
- Scaling and cost
- Operability and team readiness

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/architecture-decision-record.md`
- `../../references/architecture-pattern-catalog.md`
- `../../references/reliability-and-slo-guide.md`

## Output

Return the selected mode, the requirement that makes it necessary, rejected alternatives, operational consequences, and the condition that would justify moving to a different mode.
