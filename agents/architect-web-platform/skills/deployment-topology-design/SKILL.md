---
name: deployment-topology-design
description: Method for deciding compute placement across edge, regional, and origin tiers, sizing caching layers against real staleness tolerance, and stating the latency or regulatory constraint that justifies each distribution decision.
---

# Deployment Topology Design

## Purpose

Decide where compute runs geographically, which tier serves each class of request, and how caching layers are placed — with every distribution decision traced to a named latency budget, geographic constraint, or regulatory requirement. Prevent distributed topology from being adopted as a default posture.

## When To Use

Run this only when a distribution decision is genuinely live: there is a stated latency requirement, a geographic user distribution that spans regions, a data-residency constraint, or an existing topology under review. If none of these apply, the correct output is "topology is not yet a decision" — say that and stop.

Do not run this to justify a topology someone has already chosen. If the topology is pre-decided, the useful contribution is to name the constraint it assumes and test whether that constraint is real.

## Step 1 — Establish the Latency Budget

No topology decision is possible without a budget. Get these numbers or record their absence:

- **Target time-to-first-byte** for the most latency-sensitive route.
- **Target end-to-end interaction latency** for the most common mutation.
- **Tolerable p99** relative to p50 — how much tail is acceptable.

If no budget exists, state that explicitly and treat every subsequent recommendation as provisional. A topology chosen without a budget is a topology chosen by preference.

Decompose the budget into its unavoidable components: network round trip to the nearest point of presence, compute time, data access time, and any downstream call. Distribution only helps the first component. If compute or data access dominates the budget, distribution is the wrong lever and should be named as such.

## Step 2 — Map User Geography Against Data Geography

Record:

- Where users actually are, by proportion, not by aspiration.
- Where the authoritative data lives.
- Whether data has residency constraints that pin it to a jurisdiction.

The critical case is **users far from data**. Edge compute placed near users but reading from a distant origin adds a hop rather than removing one. Name this explicitly whenever it appears — it is the most common failure in edge adoption.

Edge compute is justified when the work at the edge does not need authoritative data: signature verification, redirects, header manipulation, geo-routing, static personalization, bot filtering, A/B assignment. It is not justified when the work needs a read from origin, because the round trip reappears.

## Step 3 — Assign Each Request Class to a Tier

Classify every request class:

| Tier | Serves | Requires |
|---|---|---|
| CDN / static | Prerendered or asset responses | No per-request identity or freshness |
| Edge compute | Token verification, routing, header logic, geo decisions | No authoritative data read |
| Regional compute | Everything reading or writing authoritative data | Colocated with or near the data |
| Origin | Long-running, stateful, or resource-heavy work | Nothing latency-sensitive depends on it synchronously |

For each assignment, record the forcing constraint. An assignment with no constraint behind it is a preference and should be simplified toward the fewest tiers that satisfy the budget.

**Default posture: fewest tiers that meet the budget.** Every additional tier adds a deployment target, an observability surface, a failure mode, and a place where configuration can drift. The board's complexity budget applies here directly.

## Step 4 — Size the Caching Layers

For each cacheable response class, record:

- **Staleness tolerance** in real time units, sourced from a requirement rather than assumed.
- **Cache key** — including every dimension that varies the response. Identity, tenant, locale, and feature-flag state are the ones most often omitted.
- **Invalidation trigger** — what event makes this entry wrong, and how the cache learns about it.
- **Behavior on invalidation failure** — how long stale data is served if invalidation is missed.

Apply the test: **if the cache were removed, what breaks?** If the answer is "nothing, it just gets slower," the cache is an optimization and can be deferred. If the answer is "the system exceeds its latency budget" or "origin capacity is exceeded," the cache is structural and belongs in the topology.

Any per-user or per-tenant response is not shared-cacheable. Confirm the session model from the boundary analysis before proposing shared caching on any authenticated route.

## Step 5 — Enumerate Failure Modes

For each tier in the proposed topology, state:

- What the system does when that tier is unavailable.
- Whether the failure is fail-open or fail-closed, and whether that is correct for the request class.
- Whether any tier is a hard dependency for a request class that could otherwise degrade gracefully.

Edge auth verification deserves specific attention: if the edge tier fails open, unauthenticated requests reach regional compute; if it fails closed, an edge outage is a total outage. Both are defensible; neither should be accidental.

## Step 6 — Produce the Topology Statement

Output:

- **Latency budget** and its decomposition, or an explicit note that no budget exists.
- **Tier assignment table** with the forcing constraint per row.
- **Caching layers** with staleness tolerance, key dimensions, and invalidation trigger.
- **Failure behavior** per tier.
- **Simplification candidate** — the one tier that could be removed with the smallest budget impact, and what that impact would be.

The simplification candidate is mandatory. It gives the board and the critic a concrete lever for reducing complexity, and it forces the topology to justify its own last tier.

## Anti-Patterns To Name

- **Edge without a budget.** Distributed compute adopted because it is available rather than because a latency requirement demands it.
- **Edge in front of distant origin.** Compute placed near users that must read from far-away authoritative data — adds a hop, removes none.
- **Cache keys missing a varying dimension.** Especially tenant, identity, and locale. This is a correctness bug, not a performance issue.
- **Invalidation without a failure story.** No stated behavior when an invalidation event is missed.
- **Multi-region as a default.** Adopted before single-region has been shown to miss the budget.
- **Accidental fail-open auth.** Edge verification whose failure behavior was never chosen.

## Handoff Boundary

This analysis places compute and caching. It does not choose replication strategy, consistency model, or storage engine geography — where the authoritative data lives is an input to this analysis, supplied by the persistence seat, not an output of it. If the topology requires data to move, state the requirement and hand it over.
