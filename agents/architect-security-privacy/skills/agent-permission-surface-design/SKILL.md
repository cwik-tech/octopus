---
name: agent-permission-surface-design
description: Scope agent tool grants, size blast radius under prompt injection or model error, separate reversible from irreversible actions, and place gates outside the model's control loop — applied when model output can become system action.
---

# Agent Permission Surface Design

## Purpose

Determine what an agent can reach when it behaves incorrectly, and shape the tool surface so the answer is acceptable. Applies whenever model output becomes an action: tool calls, MCP servers, shell access, file writes, network requests, or any autonomous loop.

The governing assumption is that the model will at some point be wrong or manipulated. Design so that this is survivable rather than trying to make it impossible.

## When to use

Use when the architecture question involves agent harnesses, tool grants, MCP server surfaces, autonomous or multi-step execution, or any path where retrieved content influences subsequent actions. Run after `trust-boundary-modeling` has identified where control crosses boundaries.

## Core distinctions

### Reversible vs irreversible

Sort every available action into two columns:

- **Reversible** — reads, queries, drafts, staged writes, anything undoable from a snapshot or version history
- **Irreversible** — deletion, sending messages or email, payments, publishing, credential rotation, external API calls with side effects, any write to a system without history

Irreversible actions need a qualitatively different posture. Conflating them with reads is the most common agent architecture failure and is usually invisible in a tool list that treats all entries as equivalent.

### Content vs instruction

Anything retrieved — documents, web pages, tool results, other agents' output — is untrusted content that may attempt to act as instruction. Any architecture where retrieved content can reach a tool-invocation path must be treated as an adversarially reachable control boundary, not as a data path.

## Procedure

### Step 1 — Inventory the grant surface

List every tool, capability, and resource the agent can reach, including transitively. Transitive reach matters: a filesystem tool scoped to a directory that contains credentials grants credential access regardless of intent. A shell tool grants everything the shell user can do.

### Step 2 — Compute blast radius

For the full grant set, answer: assuming the model is fully adversarial for one turn, what is the maximum damage reachable? Express it in concrete terms — which data can be read, which systems can be written, what can be sent, what cannot be undone. Do not express it as a likelihood.

### Step 3 — Test scope reduction

For each grant, ask whether a narrower version satisfies the requirement:

- Path-scoped instead of filesystem-wide
- Read-only instead of read-write
- A specific named operation instead of a general executor
- A single allowlisted host instead of arbitrary network egress
- Time-bounded or session-bounded instead of standing

A general-purpose tool where a narrow one suffices is an unforced expansion of blast radius.

### Step 4 — Place gates outside the loop

For every irreversible action, identify what gates it. A gate that the model itself evaluates is not a gate. Valid gates:

- Human confirmation at the point of action, showing the concrete effect
- A staged output that a separate process or person promotes
- A capability the agent's runtime does not hold at all — the action is performed by a different component with its own authorization
- Hard runtime limits — rate, quota, spend cap, blast-radius cap — enforced by the harness

### Step 5 — Trace injection paths

Map every route by which untrusted retrieved content reaches a tool-invocation decision. For each, state whether it is contained (content cannot influence tool selection or arguments) or open. Open injection paths into irreversible actions are the highest-severity finding this skill produces.

### Step 6 — Check the multi-agent amplification

In multi-agent topologies, one agent's output becomes another's input. Determine whether a downstream agent inherits upstream grants or trusts upstream output as instruction. Permission surfaces compose, and the effective surface is usually the union rather than the intersection.

## Output format

```markdown
### Grant surface

| Tool / capability | Reach (incl. transitive) | Reversible? | Narrower alternative |
|---|---|---|---|

### Blast radius (one adversarial turn)

- Readable: ...
- Writable: ...
- Irreversible reachable: ...

### Gates on irreversible actions

| Action | Gate | Outside model loop? |
|---|---|---|

### Injection paths

| Untrusted source | Reaches | Contained? |
|---|---|---|

### Required containment for the decision record

- ...
```

## Failure modes to avoid

- Accepting a prompt-level instruction as a control. "The system prompt tells it not to" is not a gate.
- Listing tools without computing transitive reach. Shell and filesystem tools defeat all narrower scoping around them.
- Treating a confirmation dialog as a gate when it does not display the concrete effect being confirmed.
- Assuming multi-agent decomposition reduces surface. It usually composes surface upward unless grants are explicitly narrowed per agent.
- Blocking useful autonomy where every reachable action is reversible and cheap. Containment should be proportional to irreversibility.
