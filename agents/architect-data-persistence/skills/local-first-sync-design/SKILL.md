---
name: local-first-sync-design
description: Design the synchronization and conflict-resolution model for systems with authoritative local state, expressing merge semantics as user-visible behavior before any sync machinery is chosen.
---

# Local-First Sync Design

## Purpose

Decide what happens when the same data exists in two places and both change. This skill forces conflict resolution to be settled as a product and data-modeling decision before it is delegated to a sync library, because the library cannot invent semantics the data model does not support.

## When to use

Use this when a desktop or mobile client holds authoritative local state, when the system must function offline, when the same record can be edited from more than one place, or when reviewing an existing sync design for failure modes.

## Core principle

**Sync is a data model problem, not a library problem.** Last-write-wins is not a default — it is a design decision with user-visible consequences. Choose merge semantics first, then select machinery that can express them.

## Procedure

### Step 1 — Establish the authority model

For each data domain in scope, name where truth lives:

- **Server-authoritative:** local is a cache; conflicts resolve toward the server. Simplest, but offline edits can be discarded.
- **Client-authoritative:** local is truth for this user's own data; the server aggregates. Good for personal-workspace data.
- **Co-authoritative:** both can write meaningfully and neither dominates. The hardest case, and the one that requires real merge semantics.

Different domains within one application commonly warrant different models. Do not force a single answer across all data.

### Step 2 — Enumerate concurrent-edit scenarios

List the realistic ways the same data changes in two places. For each, write the scenario in user terms, not in database terms.

| Scenario | Data touched | Realistic frequency | Desired user-visible outcome |
|---|---|---|---|
| Edits a note on laptop while phone is offline with an older copy | note body | common | Both edits survive; nothing silently lost |
| Two users reorder the same list | list ordering | occasional | Deterministic order, no duplication |
| Deletes an item locally that was edited remotely | item | rare | Prompt, or edit wins over delete |

The rightmost column is the actual requirement. Everything downstream serves it.

### Step 3 — Choose merge semantics per field, not per record

Whole-record last-write-wins loses data whenever two people edit different fields of the same record. Decompose:

- **Last-write-wins per field:** adequate for independent scalar fields where a later value genuinely supersedes an earlier one.
- **Additive/set semantics:** for collections where union is the correct answer — tags, memberships, attachments.
- **Counter semantics:** for values that accumulate, where increments from both sides must both apply.
- **Ordered-list semantics:** for sequences where naive merge duplicates or drops entries; requires stable per-item identity and an ordering scheme that tolerates concurrent insertion.
- **Text-merge semantics:** for prose fields where character-level convergence is required. This is the point where a CRDT or OT library becomes genuinely warranted — and the point at which you should confirm the requirement is real, since it dominates the complexity of the whole design.
- **Explicit user resolution:** for cases where no automatic merge is defensible. Requires designing the conflict UI, which is product work, not infrastructure work.

Model the data to support the chosen semantics. A field that needs additive merge must not be stored as a replaced blob.

### Step 4 — Define identity and ordering primitives

Sync correctness rests on two primitives:

- **Stable identity:** every syncable entity needs an identifier generated client-side that will not collide across devices, assigned before the entity ever reaches a server. Server-assigned sequential identity is incompatible with offline creation.
- **Causality tracking:** something that lets the system tell "newer" from "concurrent." Wall-clock timestamps cannot do this — clock skew across devices makes concurrent edits look ordered. Use logical clocks, version vectors, or per-entity revision chains as the design requires.

If the design cannot distinguish a concurrent edit from a sequential one, its conflict resolution is guessing.

### Step 5 — Design the failure and reconciliation behavior

Specify:

- **Divergence tolerance:** how long may a client stay offline before its state is unreconcilable? What happens at that boundary?
- **Partial sync failure:** if half the changes propagate and the connection drops, is the resulting state coherent? Is sync resumable, or does it restart?
- **Schema skew:** a client running an older schema syncs against a newer server. Is this rejected, tolerated, or migrated in flight? This is where sync design and schema evolution meet — coordinate with the evolution strategy.
- **Deletion semantics:** are deletions tombstoned, and for how long? A client offline longer than the tombstone retention will resurrect deleted data.
- **Reconciliation path:** when state has provably diverged beyond automatic repair, what is the manual recovery? Silent permanent drift is the worst outcome.

### Step 6 — Only now select machinery

With semantics fixed, evaluate sync approaches against them. Check whether each candidate can express the per-field semantics from Step 3, supports the identity and causality primitives from Step 4, and handles the failure cases from Step 5. Reject any option that requires weakening a semantic decision already made on product grounds.

## Output

Produce:

1. The authority model per data domain.
2. The concurrent-edit scenario table with desired user-visible outcomes.
3. Merge semantics per field or field group.
4. Identity and causality primitives required.
5. Failure, skew, deletion, and reconciliation behavior.
6. The sync approach that satisfies all of the above, and what it costs.

## Red lines

- Never accept "last-write-wins" without naming which writes get discarded and whether users will notice.
- Never use wall-clock timestamps as the causality mechanism across devices.
- Never rely on server-assigned sequential identity for entities that can be created offline.
- Never select the sync library before the merge semantics are decided.
- Never leave the permanent-divergence case unspecified.
