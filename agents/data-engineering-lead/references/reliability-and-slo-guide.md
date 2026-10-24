# Reliability and SLO Guide

## Consumer-first sequence

1. Name the consumer-visible outcome.
2. Define an SLI at the boundary where the consumer experiences it.
3. Set a target and window from business need and measured capability.
4. Define exclusions narrowly and before measurement.
5. Assign an owner and state the decision controlled by the SLO.

## Common data SLIs

- Freshness of the newest complete data
- End-to-end arrival or processing latency
- Delivery or availability of contracted partitions, files, tables, or events
- Completeness and quality-rule success over the declared population
- Successful recovery or replay within RTO and RPO

## Reliability design checks

- Timeouts and cancellation at external boundaries
- Bounded concurrency and backpressure
- Stable identities, checkpoints, deduplication, and idempotency
- Retry classification and terminal quarantine
- Versioned backfills and replay isolation
- Backup, restore, disaster recovery, reconciliation, and consumer validation
- Actionable alerts linked to lineage, impact, owner, and runbook

## Error budgets

Use an error budget only when the SLI is trustworthy and the organization has agreed what changes when the budget is consumed. Otherwise, report the measurement without pretending it governs decisions.
