---
name: graph-representation-selection
description: Choose between graph, relational, document, and hybrid representations for a logical domain model, decide labeled property graph versus RDF where a graph is warranted, and design the schema evolution and versioning strategy.
---

# Graph Representation Selection

## Purpose

Take a settled logical model and decide how it is represented. Cover the representation class, the graph flavor where a graph survives scrutiny, hybrid decomposition where one representation does not fit the whole domain, and schema evolution — because domain understanding always improves after launch and a model that cannot absorb that is unfinished.

## When To Use

After `domain-entity-modeling` has produced a pruned logical model with settled identity. Never before — representation chosen ahead of model shape is a bet, not a decision.

## Step 1 — The Traversal-Depth Test

This test decides more than any other input. Collect the actual queries the system must answer and classify each:

| Depth | Shape | Implication |
|---|---|---|
| 0 hops | Filter attributes on one entity type | Relational or document |
| 1 hop | Join to a directly related entity | Relational, comfortably |
| 2 hops, known shape | A fixed path known at design time | Relational; the join is writable and indexable |
| 2+ hops, variable shape | Path discovered at query time, depth unbounded | Graph earns its cost |
| Reachability / pathfinding | "How is A connected to D", shortest path, cycles | Graph, strongly |

Require *actual queries*, not query categories. "We'll want to explore relationships" is not evidence. If the collected queries are all depth 0–2 with known shapes, the recommendation is relational and the graph discussion ends here. This outcome is common and is not a compromise — it buys transactions, mature tooling, a hiring pool, and operational familiarity.

Two secondary signals push toward graph even at moderate depth:

- **Attributed relations** — connections carrying their own data, flagged during entity modeling
- **Heterogeneous relation types between the same endpoints** — many distinct verbs connecting the same two entity types, where the relation type is itself a query filter

## Step 2 — Representation Class

Evaluate against the pruned model:

**Relational** — Default. Strong when entity types are stable, attributes are largely uniform, cardinalities are known, and traversal is shallow. Handles attributed relations through join tables at readability cost. Weak where the schema must absorb genuinely unanticipated relation types.

**Document** — Strong when the aggregate boundary matches the read pattern exactly and the whole aggregate is read together. Weak the moment two access patterns want different boundaries, or the same sub-entity is referenced from multiple aggregates — that is duplication and drift.

**Graph** — Strong for variable-depth traversal, attributed relations, heterogeneous relation types, and schemas that grow new relation types without migration. Costs are real: smaller hiring pool, less mature operational tooling, weaker transactional guarantees in some engines, and query languages the team likely does not know.

**Hybrid** — Frequently correct and under-proposed. Decompose the domain: put the traversal-heavy subgraph in a graph store, the high-volume uniform records in relational, the read-together aggregates in documents. The cost is a consistency boundary between them. Name that boundary explicitly, state which side is authoritative, and state the acceptable staleness. A hybrid without a named consistency boundary is not a design, it is two systems that will disagree.

## Step 3 — LPG Versus RDF

Only if a graph survived Step 1.

**Labeled property graph.** Nodes and edges both carry arbitrary key-value properties. Natural fit when relations carry rich attributes, when the schema is yours alone, and when the team wants an imperative-feeling traversal language. Chosen for engineering ergonomics.

**RDF / triple store.** Everything is a subject-predicate-object triple, with global identifiers and formal semantics. Earns its cost under specific conditions:

- The model must interoperate with external vocabularies or published ontologies
- Formal inference over the model is genuinely required, not merely appealing
- Global identifier stability across organizational boundaries matters
- A standards or regulatory requirement names it

If none of these hold, RDF's overhead — reification for attributed relations, verbose query syntax, a much smaller talent pool — is paid for nothing. Choose LPG.

**The reification tell.** If the model has many attributed relations and RDF is being proposed anyway, note that each becomes a reified statement or an n-ary relation node. If that pattern appears more than a handful of times, LPG is the honest answer.

## Step 4 — Schema Evolution And Versioning

Non-optional. Design this in the same pass, not later.

**Additive by default.** New entity types, relation types, and optional attributes must be addable without touching existing data or breaking existing readers. Verify this against the chosen representation — it is nearly free in graph and document stores, and requires discipline in relational.

**Deprecation, not deletion.** Mark elements deprecated with a date and a replacement pointer. Remove only after consumers have migrated. Record how you will know when they have.

**Taxonomy versioning.** Taxonomies drift fastest. Decide whether category assignments are versioned with the taxonomy or re-derived on change, and what happens to historical records classified under a retired term.

**Identity stability across change.** Entity identifiers must survive schema evolution. If identifiers encode structure — type prefixes, hierarchy paths — they will break when the structure changes. Prefer opaque stable identifiers with structure held as queryable attributes.

**Name the migration-forcing classes.** Be explicit about what still requires a coordinated migration:

- Changing cardinality on an existing relation
- Splitting one entity type into two
- Changing identity resolution strategy retroactively
- Making an optional attribute required

A design that claims no migration is ever needed is not describing reality.

## Step 5 — Boundary Handoff

State precisely what you are and are not deciding:

- **Yours** — the logical model, the representation class, LPG versus RDF, schema evolution strategy, identity stability requirements
- **To retrieval** — what a unit of knowledge is, which attributes are semantically meaningful, which relations should be traversable at query time
- **To persistence** — concrete engine, indexing, sharding, durability, backup, operational profile, with your constraints attached: expected volumes, read/write ratio, traversal depth, consistency requirements

Where no persistence seat is on the call, carry the engine choice and say plainly that you are doing so, so the lead records who owned it.

## Output

1. **Traversal evidence** — the actual queries, classified by depth, with the verdict they produce
2. **Representation class** — chosen, with the two strongest arguments against it and why they lose
3. **Graph flavor** — LPG or RDF with the deciding condition, where applicable
4. **Hybrid decomposition** — which subdomain to which representation, with the named consistency boundary and acceptable staleness
5. **Evolution strategy** — additive rules, deprecation process, taxonomy versioning, identity stability
6. **Migration-forcing changes** — the explicit list
7. **Boundary handoff** — to retrieval, to persistence, and what you are carrying yourself
