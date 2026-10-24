---
name: adr-decision-record
description: Produce the board's ADR-style decision record on explicit request only, using six fixed sections, with the markdown file as the canonical source and the Word document rendered from that same content so the two cannot drift.
---

# ADR Decision Record

## Purpose

The architecture board is exploratory. Its default output is a better-understood problem, not a document. This skill defines the one artifact it produces, when that artifact is allowed to exist, and how to keep the markdown and Word versions from diverging.

## The trigger rule — on request only

**Produce a decision record only when the user explicitly asks for one.**

This is a hard gate, not a strong preference.

- Do **not** produce a record because the discussion reached a conclusion.
- Do **not** produce a record because the session ran long or felt substantial.
- Do **not** offer, hint at, or pre-draft one. "Want me to write this up?" at the end of a session is a soft violation of the same rule — it converts an exploratory board into a documentation pipeline by suggestion.
- Sessions that end in open discussion with no artifact are **successful sessions**.

What counts as an explicit request: a direct ask for an ADR, a decision record, a write-up, or a document capturing the session. Ambiguous signals — "good, that settles it", "let's go with that" — do **not** count. If a request is genuinely ambiguous, ask once, in one line.

## Canonical source rule

**Markdown is canonical. The Word document is a render of that identical markdown.**

- Write the record once, as markdown.
- Produce the Word export from that same content, unaltered.
- Never author, edit, or extend the Word document independently.
- Never let the Word version carry a section, a caveat, or a phrasing the markdown lacks.
- If the record needs a change, change the markdown and re-render. There is no path where the Word file is edited directly.

The entire point is that a reader of either file is reading the same record. Any divergence, however small, destroys that guarantee for every future session.

## The six sections

The record has exactly these sections, in this order. No additions, no omissions.

### 1. Context

What prompted the question, and what constraints were in play. Include:

- The load-bearing question, stated as the board classified it — and the question as originally asked, if the two differ.
- The constraints that shaped the discussion: scale, team, timeline, existing system, compliance, cost.
- What was already fixed and not up for debate.

Write this so a reader six months out understands why the question mattered without needing the conversation. Context is where most ADRs fail — under-specified context makes the Decision unreadable later.

### 2. Options considered

Each option genuinely on the table, with:

- What it is, in a sentence or two.
- What it optimizes for.
- What it costs.
- Which convened seat advanced or defended it.

Include the options that lost. An ADR listing one option is not a decision record; it is an announcement. If an option was raised and dismissed quickly, include it with the reason for dismissal — that reasoning is often what a future reader most needs.

### 3. Decision

What the board decided, and the constraint that decided it.

- State the decision plainly, in the first sentence.
- Then state the deciding constraint — the single thing that made this option win over the runner-up.
- If the board did **not** converge, say exactly that: *"No decision. The board split on [constraint A] vs [constraint B]."* A Decision section containing a manufactured decision is worse than one recording an honest non-decision. Non-convergence is a legitimate ADR outcome, and the weight then moves to Open questions.

### 4. Consequences

What follows from the decision, stated honestly in both directions.

- **What this makes easier or possible.**
- **What this makes harder, more expensive, or foreclosed.**
- **What becomes hard to reverse**, and at what point reversal stops being practical.
- **What must now be true** for the decision to hold — dependencies, assumptions, thresholds.

A Consequences section with only benefits means the tradeoff was not examined. Every architecture decision costs something; name it.

### 5. Open questions

What remains unresolved, in three groups:

- **Blocking:** must be answered before the decision can be acted on.
- **Deferred:** knowingly postponed, with the trigger that will bring them back.
- **Unexamined:** assumptions the board relied on but nobody verified.

When the Decision section records a non-decision, this section carries the substance: what would need to be known, measured, or true to break the split.

### 6. Board record

The procedural trace of the session:

- **Classification:** primary domain, secondary domain, load-bearing question.
- **Seats convened:** each seat and what it was convened to own.
- **Overrides:** any user addition or removal of a seat, recorded as instructed.
- **Re-selections:** each mid-session change, with the drift that triggered it.
- **Dissent:** any seat that held a minority position at the close, and what it held.

This section makes the record auditable. A future reader can see not just what was decided but who was and was not in the room — which is frequently the explanation for a decision that later looks strange.

## Format template

```markdown
# ADR: [Short decision title]

**Date:** [YYYY-MM-DD]
**Status:** Proposed | Accepted | Superseded
**Session:** [session id]

## Context

[Prompting question, load-bearing question, constraints in play, what was fixed.]

## Options considered

### Option A — [name]
- **What:** [description]
- **Optimizes for:** [constraint]
- **Costs:** [tradeoff]
- **Advanced by:** [seat]

### Option B — [name]
...

## Decision

[The decision, stated plainly.]

**Deciding constraint:** [the one thing that settled it.]

## Consequences

**Easier:** [what this enables]
**Harder:** [what this costs or forecloses]
**Hard to reverse:** [what locks in, and when]
**Must remain true:** [dependencies and assumptions]

## Open questions

**Blocking:** [must resolve before acting]
**Deferred:** [postponed, with return trigger]
**Unexamined:** [assumptions nobody verified]

## Board record

**Classification:** [primary] / [secondary] — [load-bearing question]
**Seats convened:** [seat] ([owns]); [seat] ([owns]); ...
**Overrides:** [any user changes to the shortlist, or none]
**Re-selections:** [mid-session changes with triggers, or none]
**Dissent at close:** [seat and position, or none]
```

## Quality checks before emitting

- Does Context stand alone for a reader who was not present?
- Does Options considered include at least one option that lost?
- Does Decision name a single deciding constraint — or honestly record a non-decision?
- Does Consequences name a real cost, not only benefits?
- Does Board record accurately reflect every override and re-selection from the session?
- Is the Word export byte-equivalent in content to the markdown?

## Anti-patterns

- **Volunteered records.** Writing one because the session felt conclusive.
- **Single-option ADRs.** A decision record with nothing rejected records no decision.
- **Manufactured decisions.** Filling the Decision section when the board actually split.
- **One-sided Consequences.** Benefits listed, costs omitted.
- **Independent Word edits.** Any change made to the export rather than the source.
- **Thin Board record.** Omitting overrides, re-selections, or dissent, which is exactly what makes the record auditable.
