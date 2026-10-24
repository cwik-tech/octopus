---
name: metadata-lineage-design
description: >
  Define business, technical, and operational metadata, ownership, source-to-target and transformation lineage, catalog publication, impact analysis, and auditability. Use for catalogs, lineage, dataset handoffs, change analysis, or discoverability requirements.
---

# Metadata and Lineage Design

## Outcome

Create a minimum metadata and lineage contract that supports discovery, operation, impact analysis, quality, security, and audit.

## Method

1. Identify the dataset, event, field, pipeline, report, model, or control whose metadata is governed.
2. Define business metadata such as meaning, owner, steward, domain, grain, terms, classification, and intended use.
3. Define technical metadata such as schema, types, keys, locations, formats, versions, partitions, and interfaces.
4. Define operational metadata such as runs, freshness, volume, quality status, incidents, SLOs, retention, and support route.
5. Capture source-to-target and transformation lineage at the lowest level needed for impact analysis. Mark observed, declared, and inferred lineage distinctly.
6. Define capture points, automation, update timing, validation, versioning, and responsible owner.
7. Define catalog publication, search terms, access request route, and the consumer-visible indicators for quality and freshness.
8. Test impact analysis in both directions for one representative field and one dataset-level change.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/lineage-record.yaml`
- `../../templates/source-to-target-mapping.md`
- `../../references/metadata-minimum-standard.md`
- `../../references/terminology-glossary.md`
- `../../references/evidence-citation-guide.md`

## Completion check

Metadata is incomplete when ownership is a team name with no response route, lineage omits transformations, or impact analysis cannot identify affected consumers.
