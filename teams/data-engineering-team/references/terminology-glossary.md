# Data Engineering Terminology

| Term | Working definition |
|---|---|
| Accuracy | Degree to which data represents the real-world value or trusted reference; often not directly measurable without an authority |
| Availability | Proportion of time a service or data product is usable under its contract |
| Backfill | Processing historical data for a range not completed by the normal live path |
| CDC | Change data capture; a method for observing inserts, updates, and deletes from a source |
| Completeness | Degree to which required records or values are present |
| Contract | Versioned producer-consumer agreement covering meaning, shape, delivery, quality, ownership, and change |
| Event time | Time at which a business event occurred |
| Freshness | Age of the newest data available to the consumer relative to its expected availability |
| Grain | What one row, record, or event represents |
| Idempotency | Property that makes repeated application produce the same intended state as one application |
| Lineage | Recorded relationship from sources through transformations to outputs and consumers |
| Processing time | Time at which a system processes an event |
| Quarantine | Controlled isolation of data that cannot safely enter the normal path |
| Replay | Reprocessing previously observed input, normally through versioned logic and reconciliation |
| RPO | Maximum acceptable amount of data loss measured in time |
| RTO | Maximum acceptable time to restore service or data availability |
| SLA | Commitment between accountable parties, usually with consequences for breach |
| SLI | Measured indicator of service or data-product behavior |
| SLO | Target value or range for an SLI over a measurement window |
| Watermark | Progress indicator describing how far a pipeline believes event-time processing is complete |
