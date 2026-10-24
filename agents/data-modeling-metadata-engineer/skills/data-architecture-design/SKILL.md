---
name: data-architecture-design
description: >
  Design and review end-to-end operational and analytical data flows, platform boundaries, ownership, controls, and recovery paths. Use when defining a new data architecture, changing topology, or tracing a source-to-consumption journey across systems.
---

# Data Architecture Design

## Outcome

Produce a technology-neutral logical architecture and the minimum physical decisions needed to make it implementable and operable.

## Method

1. Define consumers, use cases, and the authoritative sources for each data domain.
2. Draw the source-to-consumption path and label every ingestion, storage, transformation, serving, and control-plane component.
3. Mark logical and physical boundaries separately. Identify ownership, trust, network, tenancy, and residency boundaries.
4. State the responsibility and interface of each layer. Remove layers whose responsibility cannot be stated distinctly.
5. Define data contracts, metadata capture, lineage, quality controls, access controls, and observability at the boundaries where they are enforced.
6. Trace normal flow, late or malformed data, dependency failure, partial completion, retry, replay, backfill, disaster recovery, and consumer notification.
7. Compare centralized, federated, and hybrid ownership only against the organization's real decision rights and operating capacity.
8. Record material physical choices in decision records; keep current vendor details out of the durable logical model.

## Review questions

- Can every dataset and control be assigned to a named owner?
- Can a consumer tell which copy is authoritative and how fresh it is?
- Can the design recover without duplicating, losing, or silently changing meaning?
- Are trust and enforcement boundaries visible rather than implied?
- Does every architectural layer buy a distinct capability?

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../references/architecture-pattern-catalog.md`
- `../../references/data-engineering-principles.md`
- `../../references/security-control-baseline.md`
- `../../templates/source-to-target-mapping.md`
- `../../templates/pipeline-design-specification.md`
