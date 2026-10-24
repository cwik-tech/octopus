---
name: agent-harness-design
description: Determine whether a problem warrants an agent or a deterministic pipeline, then design the harness — the autonomy boundary, tool surface, permission model, and failure and retry semantics that wrap the model loop.
---

# Agent Harness Design

## Purpose

The harness is everything around the model call: what the loop is allowed to decide, what tools it can reach, what permissions each tool carries, and what happens when a step fails. Most agent failures are harness failures, not model failures. This skill runs the agent-versus-pipeline gate first, then designs the harness only if the gate returns "agent."

## When to use

- A new agent system is being proposed and no one has yet asked whether it should be an agent.
- The tool surface is growing and reasoning quality is degrading.
- The system behaves unpredictably when a tool call fails partway through a sequence.
- Permissions are being granted without a defined rollback path.

## Step 1 — The Enumeration Test

Before designing anything, attempt to write the control flow as an enumerable branch set.

Ask:

1. What are the possible next actions at each step?
2. Does the choice of next action depend on tool output in a way you cannot predict in advance?
3. If you drew this as a flowchart, would it terminate with a bounded number of branches?

**Verdict rules:**

| Observation | Verdict |
|---|---|
| Branches are enumerable and bounded | Pipeline with model calls inside it |
| Branch set is open; next action depends on unpredictable tool output | Agent |
| Mostly enumerable with one genuinely open sub-step | Pipeline with a scoped agent for that sub-step |
| Unclear because the problem is under-specified | Not ready to design — return the ambiguity |

State the verdict explicitly in the output. If the verdict is "pipeline," describe the pipeline and stop. Do not continue to harness design out of momentum or because the room wants an agent.

## Step 2 — Autonomy boundary

Define precisely where the agent decides and where the system decides.

For each decision point, classify it:

- **Agent-decided** — the model selects the action from the tool surface.
- **System-decided** — deterministic code routes, with no model involvement.
- **Human-gated** — the agent proposes, a human confirms before execution.

A harness with no system-decided or human-gated points is usually under-designed. Look specifically for: irreversible writes, external side effects, spend, and anything a user would want to review.

## Step 3 — Tool surface

Design the tool list as a budget, not a catalogue.

For each tool record:

| Field | What to capture |
|---|---|
| Name | Verb-first, unambiguous |
| Token cost | Definition + schema tokens in the system context |
| Permission class | read / write / irreversible / spend |
| Failure modes | What can go wrong, and whether it is retryable |
| Overlap | Which other tools could be confused with this one |

Apply the **Tool Surface Ceiling**: if the list is long enough that a reader would skim, the model is skimming too. Remedies, in order of preference:

1. Merge overlapping tools into one with a mode parameter.
2. Progressive disclosure — expose a subset per phase.
3. Tool search — the agent queries for the tool it needs.
4. Only then: a subagent with its own surface (and apply the coordination cost bar).

Sum the total token cost of the tool surface and carry it into the context budget.

## Step 4 — Permission model

Map permission classes to controls:

- **read** — generally free; watch only for data-sensitivity boundaries.
- **write, reversible** — allow, with a defined undo path.
- **write, irreversible** — require human gate or a compensating action. An agent holding irreversible writes with no rollback is a design defect.
- **spend** — hard caps enforced in the harness, not in the prompt. Prompt-level limits are not limits.

Never encode a permission boundary only in the system prompt. Prompt instructions are guidance; the harness is the control.

## Step 5 — Failure and retry semantics

For each tool class, specify:

- **Retry policy** — how many attempts, what backoff, and which error classes are retryable at all. Retrying a validation error is a loop; retrying a timeout is correct.
- **Partial-sequence state** — when call three of five fails, what state exists? Is it consistent? Can it be observed by the model?
- **Rollback** — what compensating action reverses a completed step, if any.
- **Escalation** — the condition under which the agent stops and asks a human. "Never" is a valid answer only for fully reversible read-only systems.

A retry policy that compounds side effects is worse than no retry policy. Check specifically whether the tool is idempotent before permitting automatic retry.

## Output

Produce:

1. **Gate verdict** — agent or pipeline, with the enumeration reasoning.
2. **Autonomy boundary table** — decision points classified agent / system / human-gated.
3. **Tool surface table** — name, token cost, permission class, failure modes, overlap. With a total token figure.
4. **Permission controls** — how each class is enforced in the harness.
5. **Failure semantics** — retry, partial-state, rollback, and escalation per tool class.
6. **Open risks** — what you could not resolve and what evidence would resolve it.

## Red lines

- Never skip the Enumeration Test because the agent framing was already assumed.
- Never enforce a permission boundary in the prompt alone.
- Never permit automatic retry on a non-idempotent tool without a compensating action.
- Never present a framework choice as the harness design.
