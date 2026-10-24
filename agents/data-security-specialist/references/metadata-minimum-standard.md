# Metadata Minimum Standard

## Dataset identity

- Stable identifier, name, version, status, domain, owner, steward, and support route
- Business purpose, intended consumers, authority, grain, and source systems

## Technical metadata

- Schema, fields, types, keys, nullability, units, constraints, format, location, partitions, and interface
- Compatibility classification, change history, deprecation state, and retention

## Operational metadata

- Producer pipeline, cadence, latest successful run, freshness, volume, quality status, SLOs, incidents, and runbook

## Governance and security metadata

- Classification, sensitive fields, access policy, residency, masking, retention, deletion, and audit requirements

## Lineage

- Upstream sources, transformations, downstream datasets, reports, models, and consumers
- Capture method and status labeled as observed, declared, or inferred
- Field-level lineage where field changes can cause material consumer impact

## Publication rule

Metadata must be available where consumers discover or request the dataset. A document known only to the creating team is not a catalog entry.
