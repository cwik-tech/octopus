---
name: trust-boundary-modeling
description: Identify and classify architecture-level trust boundaries, determine what data crosses each one and who enforces it, and produce a ranked threat table proportional to a named adversary — used before proposing any specific security control.
---

# Trust Boundary Modeling

## Purpose

Produce an architecture-level map of trust boundaries so that security discussion attaches to structure rather than to control shopping. This skill runs before any control is proposed. Its output is a boundary table, an egress ledger, and a ranked threat list scoped to a named adversary.

This is not a full STRIDE exercise or a compliance assessment. It is the minimum modeling needed to decide an architecture question correctly, at a level of detail an ADR can carry.

## When to use

Use on every architecture question that involves more than one process, more than one machine, more than one tenant, or any third-party service. In practice this is nearly every convening. Run it first, before applying any domain-specific security skill.

## Definitions

A **trust boundary** is any point where data or control passes between two zones with different trust assumptions. The common ones:

- Process boundaries (main process ↔ renderer, host ↔ sandboxed child)
- Machine boundaries (client ↔ server, device ↔ cloud)
- Organizational boundaries (our infra ↔ third-party provider)
- Tenancy boundaries (tenant A ↔ tenant B in shared storage or shared index)
- Privilege boundaries (unprivileged UI ↔ privileged capability, model output ↔ tool execution)
- Persistence boundaries (ephemeral memory ↔ durable storage that outlives the session)

An **egress event** is any point where data leaves the control domain the user believes it occupies. Embedding generation, third-party inference, telemetry, crash reporting, and auto-update check-ins are all egress events even when the team does not think of them that way.

## Procedure

### Step 1 — Enumerate boundaries

Walk the proposed architecture and list every boundary from the categories above. For each, record:

| Field | Meaning |
|---|---|
| Boundary | The two zones it separates |
| Crosses | What data or control actually passes |
| Direction | Inbound, outbound, or bidirectional |
| Enforced by | Runtime, OS, provider, or our own code |

The **Enforced by** column carries most of the value. A boundary enforced only by our own code being correct is a boundary that will eventually fail; mark it explicitly so the board can decide whether that is acceptable.

### Step 2 — Classify what crosses

For each boundary, classify crossing data:

- **User content** — what the user authored or supplied
- **Derived content** — embeddings, summaries, indexes, caches derived from user content (treat as user content for residency purposes; derivation is not anonymization)
- **Credentials** — tokens, keys, session material
- **Control** — commands, tool invocations, anything that causes an action

Control crossing a boundary is more dangerous than content crossing it. Flag any boundary where model output becomes control.

### Step 3 — Build the egress ledger

Extract every outbound crossing that leaves the user's or organization's control domain. For each, record the destination, whether retention is documented or assumed, and whether deletion on request is actually possible. Mark assumed items as unverified rather than treating them as facts.

### Step 4 — Name the adversary

For each boundary of concern, state the concrete adversary and the concrete asset. Acceptable adversaries include: a network attacker, a malicious or compromised third-party dependency, another tenant, a prompt-injecting document in the corpus, a local process on a shared machine, or a subpoena. If the honest answer is "a bug" or "the user themselves," record it as a robustness concern and downgrade it out of the threat list.

### Step 5 — Rank by reachable damage

Order findings by what a compromise reaches, not by how likely it is. Within equal reach, rank irreversible consequences above reversible ones. Probability is unknowable at design time; reachability is a decidable property of the architecture.

### Step 6 — Split now vs later

Separate findings into those that the current architecture decision determines — and therefore must be settled in the decision record — and those that are implementation details. Being explicit about the second category is what keeps this skill from becoming scope creep.

## Output format

```markdown
### Trust boundaries

| Boundary | Crosses | Direction | Enforced by |
|---|---|---|---|

### Egress ledger

| Data | Destination | Retention | Deletable | Verified? |
|---|---|---|---|---|

### Threats, ranked by reachable damage

1. [Adversary] reaching [asset] via [boundary] — [reversible / irreversible]

### Must be settled in this decision

- ...

### Can be deferred to implementation

- ...
```

## Failure modes to avoid

- Producing controls before boundaries. If the output names a control without a boundary, the modeling was skipped.
- Treating derived data as non-sensitive. Embeddings of a private corpus are the private corpus for residency purposes.
- Uniform severity across a single-user local tool and a multi-tenant service. Proportionality is part of the analysis, not a softening applied afterward.
- Accepting provider claims as verified facts. Mark unverified and state what would verify it.
- Expanding into a full compliance review. Scope to what this architecture decision determines.
