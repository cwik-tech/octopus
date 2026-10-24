---
name: pipeline-design
description: >
  Design an ingestion, transformation, synchronization, or delivery pipeline with explicit semantics, recovery, and operations. Use for a new ETL or ELT pipeline, a material pipeline change, migration, CDC flow, backfill, or replay design.
---

# Pipeline Design

## Outcome

Produce an implementable pipeline specification whose normal, failure, replay, and change behavior are explicit.

## Method

1. Define source and target contracts, owners, extraction boundaries, transformation responsibilities, and consumer acceptance criteria.
2. Choose full, incremental, change-data-capture, event, or hybrid ingestion from source capabilities and required latency.
3. Define stable identities, checkpoints, watermarks, deduplication keys, ordering, idempotency, and delivery semantics.
4. Specify schema validation and compatibility behavior before transformation. Route invalid or unknown records deliberately.
5. Define retry classes, retry limits, dead-letter or quarantine behavior, dependency timeouts, cancellation, and bounded concurrency.
6. Design backfill and replay with isolation, rate limits, consumer impact, versioned logic, and reconciliation.
7. Define orchestration dependencies, partial completion, restart behavior, deployment, rollback or roll-forward, and ownership.
8. Attach metadata, lineage, quality rules, SLOs, alerts, dashboards, runbooks, capacity assumptions, and cost drivers.

## Required failure cases

- Duplicate input or repeated delivery
- Late, missing, malformed, or out-of-order data
- Source schema change and target incompatibility
- Partial write or downstream outage
- Retry exhaustion and poison records
- Backfill overlapping the live path

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/pipeline-design-specification.md`
- `../../templates/source-system-profile.md`
- `../../templates/source-to-target-mapping.md`
- `../../templates/data-contract.yaml`
- `../../references/data-engineering-principles.md`

## Completion check

If a replay can silently duplicate results, a schema change can silently alter meaning, or an operator cannot tell what to do after a terminal failure, the design is not complete.
