# Data Architecture Pattern Catalog

Use these as comparison frames, not defaults.

## Ownership topology

| Pattern | Fits when | Main cost or risk |
|---|---|---|
| Centralized | Shared standards, scarce specialists, and common platforms outweigh domain autonomy | Bottlenecks and distance from business semantics |
| Federated | Domains have real decision rights, engineering capacity, and enforceable interoperability standards | Inconsistent execution and duplicated platform work |
| Hybrid | A central platform can own shared controls while domains own semantics and products | Ambiguous boundaries unless decision rights are explicit |

## Processing topology

| Pattern | Fits when | Main cost or risk |
|---|---|---|
| Batch | Consumer deadlines tolerate scheduled processing and simpler recovery | Staleness between runs and large recovery windows |
| Micro-batch | Near-real-time freshness is useful without continuous stateful processing | Boundary effects and more frequent orchestration |
| Streaming | Continuous low latency, event-time handling, or immediate reactions are required | Stateful recovery, ordering, replay, and on-call complexity |
| Hybrid | Live and historical paths have genuinely different execution needs | Semantic drift and reconciliation between paths |

## Storage families

| Family | Typical strength | Review focus |
|---|---|---|
| Relational | Transactions, constraints, joins, update integrity | Isolation, indexing, scaling, schema evolution |
| Columnar | Analytical scans, compression, aggregation | Partitioning, concurrency, freshness, workload isolation |
| Object | Durable low-cost files and open analytical formats | Catalog, small files, consistency, lifecycle, governance |
| Key-value | Predictable access by stable key | Key design, hot spots, secondary access, consistency |
| Document | Aggregate-shaped records and flexible schemas | Validation, cross-document queries, schema drift |
| Graph | Relationship traversal as the primary workload | Identity, traversal shape, scale, operational maturity |

## Integration patterns

- File or object exchange for bounded asynchronous delivery
- Database replication or CDC for source changes
- APIs for request-driven operational exchange
- Messaging or event streams for asynchronous reactions
- Query federation or virtualization for access without physical movement

For every pattern, define authority, semantics, delivery, change, security, failure, recovery, and cost.
