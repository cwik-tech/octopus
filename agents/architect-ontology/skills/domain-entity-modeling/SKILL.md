---
name: domain-entity-modeling
description: Decompose a domain into entities, relations, attributes, and taxonomy, then prune the result against named downstream consumers and settle identity resolution before any representation is chosen.
---

# Domain Entity Modeling

## Purpose

Turn an informally described domain into a logical model that is small enough to build, precise enough to query, and honest about what it refuses to represent. This runs *before* representation choice. Choosing a store before knowing the model's shape produces graph databases holding normalized tables and document stores holding shredded joins.

## When To Use

At the start of any session where the domain has not been decomposed, or where an existing model is under review because it has grown unwieldy, drifted from use, or failed to answer questions it was supposed to answer.

## The Tagging Floor

Run this before anything else. It is the cheapest possible answer and it is frequently correct.

State what a flat tag vocabulary plus full-text search would deliver for this system. Then name, specifically, what it would fail to deliver:

- A query that requires knowing the *type* of a relationship, not just co-occurrence
- A constraint that must be enforced rather than merely conventional
- An aggregate that requires traversing relations rather than filtering attributes
- A disambiguation that requires stable identity, not string matching

If none of these apply with a concrete example attached, the recommendation is tags plus search. Stop here and say so. Formal modeling must beat this floor on a named capability, not on elegance.

## Step 1 — Entity Extraction

List candidate entity types from the domain description, source data, and the questions the system must answer. For each candidate, record:

| Field | What it captures |
|---|---|
| Name | Singular, domain-native term — not a technical abstraction |
| Definition | One sentence: what counts as one of these, what does not |
| Instance volume | Order of magnitude — tens, thousands, millions |
| Lifecycle | Created how, changed how often, deleted or archived |
| Source of truth | Which system or process authoritatively defines it |

Apply the **boundary test** to each: given two things that a domain expert would argue about, does this definition resolve the argument? If not, the entity type is under-defined and will produce inconsistent data.

Watch for the two common failure modes:

- **Over-splitting** — separate entity types that share every attribute and differ only by a value. These are one entity type with a discriminating attribute.
- **Under-splitting** — one entity type where half the instances have a disjoint attribute set from the other half. These are two entity types, or one plus a variant structure.

## Step 2 — Relation Typing

For each pair of entity types that connect, define the relation explicitly:

- **Name** — a verb phrase readable in one direction (`authored`, `supersedes`, `belongs_to`)
- **Cardinality** — one-to-one, one-to-many, many-to-many, with the real observed distribution not the theoretical maximum
- **Directionality** — is the inverse meaningful and does anything query it
- **Attributes on the relation** — does the connection itself carry data (timestamp, confidence, role)
- **Temporality** — is this relation permanent, or true only within a time window

Relations that carry attributes or temporality are the strongest signal that a graph representation may be warranted — they are awkward in a relational join table and lossy in a document embed. Record which relations these are; the representation-selection skill consumes this directly.

## Step 3 — Attribute Placement

For each attribute, decide where it lives and record why:

- **On the entity** — intrinsic, single-valued, queried by filter
- **On the relation** — describes the connection, not either endpoint
- **As a related entity** — has its own identity, lifecycle, or is referenced by multiple things
- **Nowhere** — no consumer reads it (see Step 5)

The common error is promoting an attribute to an entity because it *feels* important. Promote only when it has independent identity, an independent lifecycle, or multiple referrers.

## Step 4 — Taxonomy Design

Where entity types have subtypes or categories, design the hierarchy — but bound it hard.

- **Depth limit: two levels** unless a third level has a named consumer that queries at that level. Deep hierarchies are almost never traversed at the depth they are modeled.
- **Mutual exclusivity** — decide explicitly whether an instance can hold multiple categories. If yes, this is faceted tagging, not a hierarchy. Model it as such.
- **Open versus closed** — can new categories appear at runtime? A closed vocabulary can be an enum with constraints. An open one needs its own entity type and a governance answer for who adds terms.
- **Stability** — how often does this taxonomy change? A volatile taxonomy embedded in a schema becomes a migration treadmill; make it data, not structure.

## Step 5 — Consumption Pruning

The highest-value step. Walk every entity type, relation type, attribute, and taxonomy level produced above and record:

| Element | Downstream consumer | Query or use it serves |
|---|---|---|

A consumer must be a named system, interface, query, or report in the *current* design. "Future analytics" is not a consumer. "The LLM might use it" is not a consumer unless there is a retrieval path that surfaces it.

Everything without a named consumer moves to a deferred list, each with a **revival trigger** — the specific observable condition that would justify adding it later. Deferring with a trigger is a design decision. Deferring without one is just forgetting.

Expect this step to remove 30–60 percent of the model. If it removes nothing, the pruning was not honest.

## Step 6 — Identity Resolution

For each entity type, decide what makes two records the same thing. Pick one and state the consequence:

- **Natural key** — a domain-provided stable identifier exists. Cheapest and most robust. Verify it is actually stable and actually unique before relying on it.
- **Deterministic match** — an exact rule over normalized attributes. State the normalization and what collides under it.
- **Probabilistic match** — a similarity score with a threshold. State the threshold, the expected false-merge and false-split rates, and which error is more costly here.
- **Human adjudication** — a queue with a reviewer. State who staffs it and what the throughput needs to be.

Then answer the correction question: when a merge is wrong, what unmerges it, and what happens to the relations that were consolidated during the merge? A model without an unmerge path accumulates irreversible corruption.

Identity failures compound at every hop. An unresolved identity strategy invalidates the rest of the model regardless of how well the relations are typed.

## Output

1. **Tagging floor verdict** — what tags plus search would fail to do, or a recommendation to stop here
2. **Entity table** — name, definition, volume, lifecycle, source of truth
3. **Relation table** — name, cardinality, directionality, attributes, temporality; relations carrying attributes or temporality flagged
4. **Taxonomy** — hierarchies with depth justification, or faceted tags where exclusivity fails
5. **Deferred list** — pruned elements with revival triggers
6. **Identity strategy** — per entity type, with the correction path
7. **Open questions** — what could not be settled without domain expert input or sample data

Hand this to `graph-representation-selection`. Do not choose a store from this skill.
