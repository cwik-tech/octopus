---
name: schema-evolution-strategy
description: Produce the migration path for a storage design — how live data reaches v1, how the design survives to v3, and whether the route between them requires a rewrite — covering relational schema and ontology structure alike.
---

# Schema Evolution Strategy

## Purpose

Treat migration as a property of the design being chosen, not as a later phase. A storage design is unfinished until someone can describe how production data gets into it and how it changes shape twice more without a rewrite.

## When to use

Use this on every question that will produce a decision record touching persistence. Apply it to relational schema, to document structure, to vector index layout, and to ontology structure — the evolution problem is the same shape in all four.

## Core principle

**A design without a migration path is a drawing, not a design.** The question is never whether the target schema is good; it is whether the system can reach it on live data within an acceptable window, and leave it again later.

## Procedure

### Step 1 — Establish migration constraints

Before designing anything, capture the envelope:

- **Downtime tolerance:** zero, a maintenance window of stated length, or unconstrained?
- **Data volume** at migration time, and the projected volume one and two years out.
- **Version skew requirement:** must old and new application code run simultaneously against the database during rollout? For most deployed systems the answer is yes, and it constrains every subsequent choice.
- **Rollback requirement:** must the migration be reversible after it completes, or only during?
- **Client-side schema:** for desktop or local-first systems, users may run arbitrarily old versions. What is the oldest version that must still be able to migrate forward?

These constraints determine which migration techniques are available. A zero-downtime, version-skew-tolerant requirement rules out any change that is not backward-compatible in a single step.

### Step 2 — Classify each intended change

Sort every schema change by its migration difficulty:

- **Additive:** new nullable column, new table, new index. Safe, online, no skew problem.
- **Widening:** loosening a constraint or growing a type. Usually safe; verify no code depends on the old bound.
- **Backfilling:** new column that must be populated from existing data. Requires a batched backfill and a dual-write or default-on-read period.
- **Narrowing:** adding a constraint, shrinking a type, making a column non-null. Requires the data to already conform, verified before the constraint is applied.
- **Restructuring:** splitting or merging tables, changing a relationship's cardinality, moving a field between entities. Requires the expand-migrate-contract sequence and cannot be done in one step under version skew.
- **Destructive:** dropping a column or table. Irreversible once data is gone; always the last step, separated from the deploy that stopped using it.

Any change classified as restructuring or destructive requires a multi-phase plan, never a single migration.

### Step 3 — Sequence with expand-migrate-contract

For every non-additive change under version-skew constraints, write the sequence explicitly:

1. **Expand:** add the new structure alongside the old. Both exist. No code reads the new one yet.
2. **Dual-write:** deploy code that writes to both structures and reads from the old. Old and new application versions both function.
3. **Backfill:** batch-migrate historical data into the new structure. Estimate the runtime at production volume — this is the number most often skipped and most often wrong.
4. **Flip reads:** deploy code that reads from the new structure. Still writing both.
5. **Stop dual-write:** deploy code that writes only to the new structure.
6. **Contract:** drop the old structure, in a separate deploy, after a soak period long enough to roll back without it.

Each numbered step is a separate deploy. Compressing them is what turns a routine migration into an outage.

### Step 4 — Estimate the backfill window

For every backfilling or restructuring change, estimate concretely:

- Rows to process at migration-time volume.
- Achievable batch throughput given lock behavior and production load headroom.
- Total wall-clock duration, and whether it fits the operational window.
- Behavior if the backfill is interrupted midway — is it resumable and idempotent?

If the estimated window exceeds what operations will accept, the design must change now, not at migration time.

### Step 5 — Handle ontology and semantic evolution

Ontology structure evolves under the same discipline but with an extra concern: meaning drift. When an entity type is split, a relation's semantics narrowed, or an attribute redefined, historical records carry the old meaning.

For each semantic change specify:

- Whether historical data is **reinterpreted** (old records now mean the new thing) or **preserved** (old records keep old semantics and are marked as such).
- How consumers distinguish the two. An unversioned semantic change silently corrupts every downstream analysis built on the old meaning.
- Whether derived artifacts — embeddings, indexes, materialized views, caches — must be rebuilt, and what that rebuild costs.

Derived-artifact rebuild is the most commonly underestimated cost in knowledge-system evolution. A re-embedding pass across a large corpus can dominate the entire migration.

### Step 6 — Test the v1-to-v3 path

The real question is not whether v1 to v2 works, but whether the v1 design admits a plausible v3 without a rewrite. Sketch two credible future requirements — a new access pattern, a scale increase, a tenancy change — and trace whether the proposed design reaches them through the change classes in Step 2, or whether it requires restructuring so extensive that a rewrite is the honest description.

If a plausible v3 requires a rewrite, say so explicitly and let the board decide whether to accept that with open eyes or change the v1 design now.

## Output

Produce:

1. The migration constraint envelope.
2. Each intended change, classified by difficulty.
3. The expand-migrate-contract sequence for every non-additive change, deploy by deploy.
4. Backfill window estimates at production volume, with resumability noted.
5. Semantic-evolution handling and derived-artifact rebuild cost, where ontology is in scope.
6. The v1-to-v3 assessment: reachable by migration, or requires rewrite.

## Red lines

- Never present a restructuring change as a single migration step under version skew.
- Never omit the backfill duration estimate — "it'll be fine" is not an estimate.
- Never combine the contract step with the deploy that stopped using the old structure.
- Never let a semantic change ship without a way for consumers to distinguish old meaning from new.
- Never omit the derived-artifact rebuild cost when embeddings or indexes depend on the changing structure.
- Never claim a design survives to v3 without tracing at least one concrete future requirement through it.
