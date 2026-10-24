---
name: web-boundary-analysis
description: Systematic method for placing application capabilities on the server/client boundary, classifying the API surface, determining auth and session architecture, and forcing the multi-tenancy decision before rendering or caching strategy is settled.
---

# Web Boundary Analysis

## Purpose

Produce a defensible map of where application logic lives, what crosses the network, how identity flows across that boundary, and what tenancy model the system is committed to. This runs before any rendering-strategy, caching, or deployment discussion, because each of those is downstream of boundary placement and constrained by it.

## When To Use

Run this on every web or cloud application architecture question, including ones framed as narrow. A question about "which rendering mode to use" is a boundary question wearing a rendering costume. A question about "how to speed up this page" is usually a placement question. Run the analysis first, then answer what was asked.

## Step 1 — Enumerate Capabilities

List every distinct capability the system must perform. A capability is a unit of work with an observable outcome, not a screen or a component. Examples: authenticate a user, list a filtered collection, mutate a record, produce an export, subscribe to a live feed, render a public marketing page.

For each capability, record:

- **Trigger** — user action, scheduled, event-driven, or navigation.
- **Data required** — what it reads to do its work.
- **Data produced** — what it writes or returns.
- **Freshness requirement** — must be current, tolerates staleness of N, or fully static.
- **Identity requirement** — anonymous, authenticated, or authorized against a specific resource.

## Step 2 — Force the Placement

For each capability, assign one placement and record the forcing reason:

| Placement | Assign when |
|---|---|
| Server-only | Touches secrets, enforces authorization, or reads data the client must never see |
| Server-rendered, client-hydrated | Needs SEO or first-paint speed but has post-load interactivity |
| Client-only | Purely presentational, or depends on device-local state (viewport, input focus, local storage) |
| Split | Genuinely needs both sides — record exactly what each side owns |

The forcing reason matters more than the placement. "Server because it holds a secret" is a forcing reason. "Server because that's the framework default" is not — re-derive it or mark the placement as unjustified.

Flag every capability where the forcing reason is absent or is developer convenience. These are the negotiable placements, and they are where the board should spend its attention.

## Step 3 — Classify the API Surface

For everything that crosses the boundary, classify the mechanism:

- **Colocated server function** — invoked directly from the component tree, no public contract, no external consumer.
- **Route handler / HTTP endpoint** — has a public contract, may serve external consumers, versionable.
- **Streaming or subscription channel** — long-lived, push-oriented.
- **Static asset or prerendered payload** — no runtime boundary crossing at request time.

Apply this test: **does anything other than this application's own UI need to call it?** If yes, it needs a real endpoint with a contract and a version story. If no, a colocated server function is sufficient and an endpoint is premature surface area.

Record any capability where the answer is "not yet, but probably" — these are the ones that will be retrofitted, and the retrofit cost should be stated.

## Step 4 — Determine Auth and Session Architecture

Settle these four before moving on:

1. **Where the session lives** — httpOnly cookie, bearer token in client memory, or stateful server session.
2. **How it is verified** — signature verification at the edge, lookup against a session store, or delegated to an identity provider.
3. **Where authorization decisions are made** — a single choke point, or distributed across capabilities.
4. **What this forecloses** — enumerate explicitly.

The foreclosure list is the most valuable output of this step. Common entries:

- Bearer-in-memory tokens make server-side rendering of authenticated content impossible without a separate mechanism.
- Stateful server sessions require a shared session store before any horizontal scaling or multi-region deployment.
- Edge-verifiable signed tokens enable edge auth checks but make immediate revocation hard.
- Any per-user rendering forecloses shared response caching for those routes.

If the session model has not been chosen, say so and mark every downstream rendering and caching recommendation as provisional.

## Step 5 — Force the Tenancy Decision

Classify the system as one of:

- **Single-tenant** — one customer per deployment, no tenant concept in the application.
- **Pooled multi-tenant** — shared infrastructure, tenant scoping enforced in application logic or query filters.
- **Isolated multi-tenant** — separate resources per tenant, isolation enforced at the infrastructure boundary.

Then record two things: the current requirement, and the migration cost to the adjacent model.

Do not accept "single-tenant for now" without recording the migration cost. Retrofitting tenant scoping onto a system that assumed single-tenant is one of the most expensive reversals in web architecture, and the board must see that number before deferring it.

Where pooled multi-tenancy is chosen, name the enforcement point. "Every query filters by tenant ID" is a discipline, not an architecture. Ask what structurally prevents a query from omitting the filter.

## Step 6 — Test for Compensating Mechanisms

Review the placement map for any of these:

- Caching proposed to make a slow boundary crossing tolerable.
- Request coalescing or batching to reduce round trips.
- Client-side state duplication of server-owned data.
- Prefetching to hide a latency the placement created.

For each, ask what the alternative placement looks like and whether the mechanism disappears. If it disappears, the mechanism was compensating for a placement error, and the placement should be revisited before the mechanism is endorsed.

Some compensating mechanisms are legitimate — a cache in front of genuinely expensive computation is not a placement error. The test distinguishes the two: expensive computation stays expensive under any placement; a round-trip penalty does not.

## Step 7 — Produce the Boundary Map

Output a compact table:

| Capability | Placement | Forcing reason | Crossing mechanism | Identity requirement | Negotiable? |
|---|---|---|---|---|---|

Followed by:

- **Session model** and its foreclosure list.
- **Tenancy model** and the migration cost to the adjacent model.
- **Unjustified placements** — the ones with no forcing reason.
- **Compensating mechanisms** flagged in Step 6.

## Anti-Patterns To Name

- **Rendering-first reasoning.** Choosing SSR/SSG/CSR before the session model is settled. The session model constrains which are even available.
- **Endpoint proliferation.** Creating public HTTP contracts for capabilities only the application's own UI calls.
- **Deferred tenancy.** Accepting "we'll add tenants later" without a stated migration cost.
- **Authorization as middleware only.** Treating a route guard as sufficient when capabilities can be invoked through multiple paths.
- **Cache-as-architecture.** Introducing a caching tier as a structural element rather than as an optimization over correct placement.

## Handoff Boundary

This analysis stops at the data contract. Record what each capability needs to read and write, in what shape, with what freshness. Do not recommend schema, indexing, partitioning, or storage engine — hand the contract to the persistence seat and let it choose.
