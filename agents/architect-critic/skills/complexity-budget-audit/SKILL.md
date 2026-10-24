---
name: complexity-budget-audit
description: Audit an architecture proposal for machinery the problem has not earned — count moving parts against actual problem size, detect premature abstraction, and identify what could be cut without loss.
---

# Complexity Budget Audit

## Purpose

Every architecture spends a budget: parts to build, parts to operate, parts to reason about during an incident, parts to onboard a new engineer into. This skill makes that spend explicit and holds it against the size of the problem being solved, so that over-engineering becomes a countable claim rather than a matter of taste.

Run this as the first pass on any proposal. It is cheap, it is domain-independent, and most objections either surface here or do not exist.

## When to use

- On every architecture proposal, before any other analysis.
- When a design introduces a new service, layer, boundary, queue, cache, or config surface.
- When a proposal justifies structure with future requirements rather than present ones.
- When two proposals solve the same problem and you need a basis for comparison other than aesthetics.

## Step 1 — Establish problem size

Before counting anything the proposal adds, write down what the problem actually is. Be specific and use numbers where they exist.

| Dimension | Question | Record |
|---|---|---|
| Users | How many concurrent, how many total? | |
| Data | How many records, documents, or bytes — today and in twelve months? | |
| Rate | Requests, events, or operations per second at peak? | |
| Behaviors | How many genuinely distinct things must the system do? | |
| Change rate | How often does the requirement set actually shift? | |
| Team | How many people build this, how many operate it? | |

If these are unknown, that is itself a finding: a design sized for unknown requirements is sized for imagination. Record the unknowns and note that the proposal is unfalsifiable until they are filled in.

## Step 2 — Count the moving parts

Enumerate everything the proposal introduces. Do not summarize — list.

- **Runtime parts:** processes, services, workers, daemons, background jobs, scheduled tasks.
- **Data parts:** stores, caches, indices, queues, replicas, migration paths.
- **Code parts:** layers, interfaces, plugin boundaries, strategy points, adapters, generic type parameters that exist for extensibility.
- **Operational parts:** deploy targets, config surfaces, secrets, feature flags, environment-specific branches, monitoring integrations.
- **Cognitive parts:** concepts a new engineer must learn before they can safely change anything.

Produce a total. The absolute number means little on its own; its relationship to Step 1 is the finding.

## Step 3 — The machinery ratio

Hold the parts count against the problem size.

The question is not "is this a lot of parts" but **does the parts count grow faster than the problem does**. Signals that it does:

- Parts scale with anticipated future behaviors rather than current ones.
- Parts exist to make swapping a component easy when no swap is planned.
- Parts exist because a reference architecture from a much larger system included them.
- Parts exist to preserve symmetry — "we did it that way for X, so we do it for Y" — where Y has different requirements.
- The proposal's diagram has more boxes than the system has distinct behaviors.

For each part that fails the ratio, state what you would cut and what the design concretely loses by cutting it. "Loses nothing" and "loses a hypothetical future capability" are both valid answers and both are damning.

## Step 4 — Premature abstraction tests

Apply each test to every interface, plugin point, strategy layer, factory, and generic boundary in the proposal.

### The Second Implementation Rule

An abstraction is earned by two concrete implementations that exist or are committed. One implementation plus a hypothesis is a prediction, not engineering.

For each abstraction, ask: what is the second implementation, does it exist, and has anyone committed to building it with a date? If the answer is "we might want to swap this later," the abstraction is unearned. Note that removing it is cheap now and adding it later is also cheap — the asymmetry runs against keeping it.

### The Configuration Test

Every config knob is a branch in the system's behavior space and a question a future operator must answer. For each knob the proposal adds, ask: who sets this, how do they know what to set it to, and what happens at the default? Knobs that will only ever hold their default are complexity with no corresponding flexibility.

### The Indirection Test

Trace the path from an incoming request to the code that does the actual work. Count the hops that exist purely to preserve a boundary rather than to perform a transformation. Each such hop is a place a 3am debugger loses the thread.

### The Naming Test

If a layer, service, or module cannot be given a name that describes what it does rather than where it sits — `Manager`, `Handler`, `Service`, `Coordinator`, `Provider` — it may not have a coherent responsibility. Weak naming is a symptom of a boundary drawn for structural symmetry rather than for a real seam in the problem.

## Step 5 — The subtraction pass

For the proposal as a whole, construct the simplest version that solves the stated problem. Not a rival architecture — a stripped version of the same one.

Then state precisely what breaks when you use the stripped version. Three outcomes:

1. **Nothing breaks.** The proposal is over-built. Report the delta.
2. **Something specific breaks at a specific threshold.** The machinery is earned, provided the threshold is within the planning horizon. Record the threshold; it belongs in the decision record.
3. **Something might break but you cannot say what or when.** The machinery is not yet earned. Report it as an unjustified part and let the proposer supply the mechanism.

## Output

Produce, in this order:

1. **Problem size** — the Step 1 table, with unknowns flagged.
2. **Parts ledger** — the enumerated count from Step 2.
3. **Ratio verdict** — over-built, correctly sized, or under-built, with the parts that drove the call.
4. **Unearned abstractions** — each one, with its missing second implementation.
5. **Subtraction result** — the stripped version and precisely what breaks.
6. **What is right** — parts that are clearly earned. Name them so they survive review untouched.

## Failure modes of this skill

- **Counting as criticism.** A high parts count on a genuinely large problem is fine. The ratio is the finding, never the raw number.
- **Unfamiliarity read as complexity.** A pattern you have not used before is not automatically unearned. Apply the tests, not your instincts.
- **Cutting load-bearing structure.** Some abstractions look unearned because their second implementation is a compliance requirement, a platform constraint, or a migration already underway. Ask before cutting.
- **Auditing into paralysis.** If every part passes the tests, say so and move on. A clean audit is a real result.
