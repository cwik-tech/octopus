---
name: board-convening
description: Turn a domain classification into a 3-5 seat shortlist, honor user overrides, manage turns so each seat speaks to what it owns, and re-select mid-session when the conversation drifts domain.
---

# Board Convening

## Purpose

An eleven-seat bench run as an eleven-way roundtable produces volume, not insight. This skill converts a classification into a small, justified shortlist and keeps the session tight while it runs.

Run it immediately after classification, and again whenever a re-selection trigger fires.

## Seat-count discipline

**Floor: 3. Ceiling: 5.**

- **Below three** the session is not a board — it is a consultation, and it loses the disagreement that makes a board worth convening. If only two seats seem relevant, look for the seat that would most likely dissent and add it.
- **Above five** every additional voice dilutes the ones already there. Turns get shallower, adjacent commentary creeps in, and synthesis becomes summarization.
- **Five is a ceiling, not a target.** Three well-chosen seats beat five where two are along for the ride.

## The unique-contribution test

Before adding any seat, complete this sentence in one clause:

> *"This seat is here because it owns ____, which no other convened seat owns."*

If you cannot complete it without hedging — "they'd have a useful perspective on…", "they usually have good input" — do not convene them. Ownership, not interest, is the admission criterion.

## Building the shortlist

1. **Start from the primary domain.** Convene the seat or seats that own it. This is usually one, occasionally two.
2. **Add the secondary domain seat**, if a secondary was assigned.
3. **Add the dissent seat.** Identify who is most likely to disagree with the direction the primary-domain seats will take, and convene them deliberately. Consensus reached without a dissenting seat present is not consensus; it is a sampling artifact.
4. **Add a constraint seat if a hidden domain was named** during classification — most often security, cost, or delivery reality.
5. **Stop at five.** If the list runs longer, drop the weakest unique-contribution claim, or split the question.

## Announcing the convening

State the shortlist before the discussion opens, in this shape:

> Convening [n] seats on this: **[seat]** for [what it owns], **[seat]** for [what it owns], **[seat]** for [what it owns].

One clause per seat. No apology for who is absent — the absences are the point. If a notable seat is being left out for a non-obvious reason, one clause is enough: "holding [seat] out; this isn't a [domain] question yet."

## User overrides

The user's shortlist beats yours. Always.

- **Seat added by the user:** convene it. If you think it is a poor fit, say so in one sentence, then honor the request and move on. Never re-litigate.
- **Seat removed by the user:** release it. If its absence creates a real blind spot, name the blind spot once so the user is choosing knowingly.
- **Override pushing past five:** honor it, and note that turn depth will drop. Do not silently drop a seat you convened to make room.
- **Full-bench request:** honor it if the user is explicit, and note once that the session will trade depth for coverage.

One sentence of pushback, then compliance. An override argued twice is an override refused.

## Turn management

During the session:

- **Direct questions, do not broadcast them.** Address each thread to the seat that owns it rather than opening the floor.
- **Stop adjacent commentary.** When a seat speaks outside what it was convened for, redirect to the owner. This is the main leak that turns a five-seat board into an eleven-seat one.
- **Force the constraint out.** When a seat states a position, press for the constraint underneath it. Positions collide uselessly; constraints collide informatively.
- **Let disagreement stand.** Do not broker a compromise to keep the session moving. An unresolved split, clearly stated, is a better output than a synthetic middle.
- **Do not argue the substance yourself.** If you find yourself making the technical case, either the wrong seat is convened or you have stepped outside your role.

## Re-selection triggers

Re-select when any of these fire:

| Trigger | Response |
|---|---|
| Discussion has moved to an unconvened domain for several exchanges | Add the owning seat; release a seat that has gone quiet |
| A specialist names a decisive constraint from an unconvened domain | Add that seat immediately — the question may need re-classification too |
| The user supplies new context that shifts the deciding constraint | Re-classify, then rebuild the shortlist |
| Board converges unusually fast | Suspect a missing dissent seat; add one before accepting the convergence |
| A convened seat has contributed nothing over several turns | Release it, and say so — silent seats make the room feel fuller than it is |

**Always announce a re-selection.** Name what drifted, which seat is joining, which is leaving, and why. A shortlist that changes silently makes the session record unreadable and makes the Board record section of any ADR inaccurate.

## Splitting oversized questions

When a question needs more than five seats:

1. Identify the natural sub-questions, usually one per contributing domain.
2. Order them by dependency — the sub-question whose answer constrains the others goes first.
3. Convene each separately with its own 3-5 seat shortlist.
4. Carry the resolved constraints forward as inputs to the next convening.

Sequenced small boards beat one large one. Announce the split and the running order before starting.

## Anti-patterns

- **Roster habit.** Convening the same seats every session regardless of classification.
- **Politeness convening.** Adding a seat because it seems unfair to leave it out.
- **Silent swaps.** Changing who is speaking without announcing the re-selection.
- **Broadcast turns.** Opening every question to the whole shortlist instead of directing it at the owner.
- **Consensus manufacturing.** Steering toward agreement because a split feels like a failed session.

## Output of this skill

- A stated shortlist of 3-5 seats, each with a one-clause ownership justification.
- A running record of any overrides honored and any mid-session re-selections, with their triggers — this becomes the Board record section if a decision record is later requested.
