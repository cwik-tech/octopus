---
name: data-integration-contracts
description: >
  Define producer and consumer responsibilities, schema and semantic compatibility, delivery, freshness, versioning, deprecation, ownership, and escalation. Use whenever data crosses a system, domain, team, vendor, or organizational boundary.
---

# Data Integration Contracts

## Outcome

Create a versioned contract that makes ownership and compatibility enforceable at the boundary rather than assumed inside downstream logic.

## Method

1. Name the dataset or event, producer, consumers, business purpose, authority, and grain.
2. Define fields, types, meanings, units, nullability, identities, temporal semantics, classification, and valid ranges.
3. Define transport, cadence, delivery guarantees, ordering, duplicate behavior, freshness, availability, and retention.
4. Classify compatible and breaking changes. Define versioning, notification, test evidence, parallel-run, migration, and deprecation windows.
5. Define producer obligations, consumer obligations, validation location, quarantine, replay, and reconciliation.
6. Assign owners, support channel, severity rules, escalation path, and decision rights.
7. Link the contract to source-to-target mapping, quality rules, metadata, lineage, SLOs, and security controls.

## Review rules

- Do not use a schema as a substitute for semantics.
- Do not promise exactly-once delivery without defining the bounded system in which it holds.
- Do not make a consumer infer whether missing means unknown, not applicable, redacted, or delayed.
- Do not permit silent breaking changes.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/data-contract.yaml`
- `../../templates/source-to-target-mapping.md`
- `../../references/metadata-minimum-standard.md`
- `../../references/naming-conventions.md`

## Output

Return the completed contract plus unresolved semantic, compatibility, ownership, and enforcement questions.
