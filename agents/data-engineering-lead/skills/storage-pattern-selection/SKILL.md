---
name: storage-pattern-selection
description: >
  Select relational, columnar, document, object, key-value, graph, or hybrid storage from workload, consistency, scale, retention, recovery, cost, and migration requirements. Use for a new data store, a major workload change, or a storage migration decision.
---

# Storage Pattern Selection

## Method

1. Characterize writes, reads, joins, aggregations, point lookups, scans, concurrency, latency, and data size with measured or stated evidence.
2. Define consistency, transaction, isolation, ordering, durability, availability, and recovery requirements.
3. Define partitioning keys, skew risk, hot spots, indexing, compaction, replication, retention, archival, deletion, and schema evolution.
4. Compare only viable storage families against the same workload and operational criteria.
5. Include backup and restore evidence, disaster recovery, security boundaries, observability, staffing, licensing, egress, and total cost.
6. Assess migration, dual-write or change-capture needs, portability, lock-in, and exit cost.
7. Use a hybrid only when each store has a distinct authoritative responsibility and synchronization failure is designed explicitly.

## Pattern prompts

- Relational for transactions, constraints, and relational queries
- Columnar for analytical scans and aggregations
- Object for durable, economical files and open table formats
- Key-value for bounded access by stable key
- Document for aggregate-shaped flexible records
- Graph for relationship traversal that dominates the workload

These are prompts, not conclusions. Validate against the actual workload and current product capabilities.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/architecture-decision-record.md`
- `../../references/architecture-pattern-catalog.md`
- `../../references/reliability-and-slo-guide.md`
- `../../references/security-control-baseline.md`

## Output

Return the chosen pattern, workload evidence, physical implications, rejected options, operational consequences, migration path, and reversal conditions.
