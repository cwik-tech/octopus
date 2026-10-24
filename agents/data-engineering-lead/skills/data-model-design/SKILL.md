---
name: data-model-design
description: >
  Design or review conceptual, logical, physical, relational, dimensional, Data Vault, or event models with explicit grain, identity, relationships, history, naming, and evolution. Use when defining a dataset schema or changing its business meaning.
---

# Data Model Design

## Method

1. State the business process or subject area, consumers, authority, and one-sentence grain before naming fields.
2. Choose the model layer and pattern from the consumer and change requirements. Do not mix conceptual, logical, and physical concerns silently.
3. Define entities, facts, dimensions, events, relationships, cardinality, optionality, and lifecycle.
4. Define natural, surrogate, composite, and foreign keys; identity resolution; reference data; and duplicate semantics.
5. Define time and history, including effective time, recorded time, slowly changing dimensions, corrections, and late data.
6. Define types, units, null semantics, defaults, constraints, normalization or denormalization, and derived values.
7. Apply naming rules and attach business, technical, operational, classification, ownership, and lineage metadata.
8. Define compatibility, migrations, backfills, deprecation, validation, and consumer impact for evolution.

## Pattern checks

- Relational models protect transactional integrity and update behavior.
- Dimensional models begin with grain and consumer questions, then facts and dimensions.
- Data Vault separates stable business identity from changing descriptive context and relationships.
- Event models preserve the meaning, identity, ordering, and time of facts that occurred.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../templates/dataset-specification.md`
- `../../templates/data-model-review.md`
- `../../references/naming-conventions.md`
- `../../references/metadata-minimum-standard.md`

## Output

Return the grain, model diagram or structured definition, key and relationship rules, temporal behavior, constraints, metadata, quality implications, evolution plan, and open decisions.
