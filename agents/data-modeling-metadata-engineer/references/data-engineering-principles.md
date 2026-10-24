# Data Engineering Principles

1. Begin with the consumer outcome and authoritative source, not the tool.
2. Make ownership explicit at every dataset, contract, pipeline, quality rule, and operational boundary.
3. Define semantics before physical representation and physical representation before optimization.
4. Design normal, failure, retry, replay, backfill, and recovery paths together.
5. Make repeated processing safe through stable identities, checkpoints, idempotency, and reconciliation.
6. Validate external data at the boundary and preserve invalid input for controlled diagnosis where policy permits.
7. Treat contracts, metadata, lineage, quality, security, and observability as part of the product, not post-build documentation.
8. Prefer the least complex architecture that meets measured latency, scale, reliability, and ownership needs.
9. Separate durable logical decisions from current vendor implementation details.
10. Record assumptions, evidence, trade-offs, operational consequences, and reversal conditions for material choices.
11. Prove recovery and consumer-visible outcomes; a green task graph alone is not sufficient.
12. Minimize sensitive-data copies and make retention and deletion propagate to derived data.
