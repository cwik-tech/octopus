# Pipeline Design Specification

## Purpose and contract

- Pipeline ID and owner:
- Business outcome and consumers:
- Source and target contracts:
- Acceptance criteria:

## Flow

| Stage | Responsibility | Input | Output | Owner | Timeout | Failure behavior |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

## Processing semantics

- Ingestion mode and rationale:
- Grain, identity, and deduplication key:
- Checkpoint or watermark:
- Ordering and late data:
- Delivery guarantee and bounded scope:
- Idempotency behavior:
- Schema validation and evolution:

## Failure and recovery

- Retry classes and limits:
- Quarantine or dead-letter handling:
- Partial completion and restart:
- Dependency outage:
- Backfill and replay isolation:
- Reconciliation:
- Rollback or roll-forward:
- Disaster recovery, RTO, and RPO:

## Operations

- Schedule or trigger:
- Concurrency and backpressure:
- Deployment and ownership:
- Quality rules:
- Metadata and lineage capture:
- SLIs, SLOs, alerts, dashboards, and runbook:
- Capacity and cost assumptions:

## Decisions and gaps

- Decision records:
- Assumptions:
- Open questions:
