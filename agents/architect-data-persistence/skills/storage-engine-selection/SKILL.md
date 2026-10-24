---
name: storage-engine-selection
description: Select a storage topology from enumerated access patterns, defaulting to a single engine and justifying every additional store against a named pattern it uniquely serves.
---

# Storage Engine Selection

## Purpose

Turn a set of required access patterns into a defensible storage topology. This skill exists to prevent two failure modes: choosing an engine on familiarity before knowing the query shapes, and accreting stores until the operational surface exceeds what the team can actually run.

## When to use

Use this whenever a question involves where data lives — picking a primary store, deciding whether embeddings belong beside their source rows, evaluating a graph database against relational adjacency modeling, choosing an embedded store for desktop, or reviewing an existing multi-store design.

## Core principle

**One store until proven otherwise.** Every additional persistence engine is a permanent operational tax: backup and restore, migration tooling, cross-store consistency reasoning, monitoring, and on-call surface. Polyglot persistence is a conclusion reached under pressure from a specific measured pattern, never a starting posture.

## Procedure

### Step 1 — Enumerate access patterns before naming any engine

Build the pattern table first. Refuse to discuss engines until it exists.

| Pattern | Shape | Frequency | Latency budget | Consistency need |
|---|---|---|---|---|
| e.g. fetch document with related entities | point read + 1 join | high, per page load | < 50ms p95 | read-your-writes |
| e.g. semantic search over corpus | vector similarity, top-k | moderate | < 300ms p95 | eventual acceptable |
| e.g. multi-hop relationship traversal | graph, depth 3, fanout ~10 | low | < 1s | eventual acceptable |

For each row capture: is this pattern **known** (specified in the brief), **plausible** (a reasonable future need), or **speculative** (someone's hunch)? Only known and plausible patterns may drive engine selection. Speculative patterns are recorded as foreclosure risks, not as requirements.

### Step 2 — Test the single-store hypothesis

Start with the most general engine that plausibly serves the pattern table — usually a relational store. For each pattern, ask whether it can be served acceptably by that one engine, including with extensions.

Specifically check whether these extend the primary store far enough:

- **Vector search:** pgvector inside Postgres, or an equivalent in-database index. Adequate up to substantial corpus sizes and removes the consistency problem between an embedding and its source row entirely.
- **Document/JSON access:** native JSON column types with indexing.
- **Full-text search:** built-in text search before a dedicated search engine.
- **Graph traversal:** recursive CTEs for bounded depth before a dedicated graph store.
- **Queue and job state:** a table with skip-locked semantics before a broker.

Record which patterns the single store serves adequately, which it serves poorly, and which it cannot serve at all.

### Step 3 — Justify each additional store

An additional store is warranted only when a **known or plausible** pattern is served *unacceptably* by the primary engine — not merely suboptimally. Require, for each proposed addition:

- The specific pattern it exists to serve.
- Evidence the primary store fails it: a measurement at representative volume, or a structural argument for why no configuration of the primary store can meet the budget.
- The consistency boundary this creates — what can now be stale, and for how long.
- The operational cost accepted: who backs it up, who restores it, who migrates it, who is paged for it.

If any of these cannot be answered, the addition is not yet justified.

### Step 4 — Map the consistency boundaries

For every multi-store design that survives Step 3, draw the boundary explicitly. For each pair of stores state:

- What writes must propagate between them.
- The propagation mechanism and its failure mode.
- The maximum acceptable staleness, and what the user sees while stale.
- What happens when propagation fails permanently — is there a reconciliation path, or does the system silently drift?

An unmapped consistency boundary is the most common source of late-discovered correctness bugs in polyglot designs.

### Step 5 — Name the foreclosures

For the chosen topology, state what becomes expensive or impossible:

- Denormalization for read speed forecloses cheap schema change.
- An embedded single-writer store forecloses concurrent multi-user writes.
- A separate vector store forecloses transactional consistency between an embedding and its source.
- Aggressive partitioning forecloses cheap cross-partition queries.
- A schema-per-tenant model forecloses cheap cross-tenant analytics.

For each foreclosure, classify the cost of reversal as **recoverable in v2** (a migration, painful but bounded) or **locked in** (a rewrite). Locked-in foreclosures require explicit board acknowledgment.

## Output

Produce:

1. The access pattern table with known/plausible/speculative classification.
2. The recommended topology — engine or engines, and what each holds.
3. For each additional store beyond the first: the justifying pattern and the evidence.
4. The consistency boundary map for multi-store designs.
5. The foreclosure list with reversal cost classified.

## Red lines

- Never name an engine before the access pattern table exists.
- Never justify a store with a speculative pattern.
- Never accept vendor benchmarks as evidence of fit.
- Never leave a consistency boundary undrawn in a multi-store recommendation.
- Never omit the foreclosure list — a recommendation without it is incomplete.
