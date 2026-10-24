---
name: feasibility-roadmap-synthesis
description: Converts cross-functional product and technical findings into phased decisions, dependency-aware priorities, and measurable validation gates. Use when choosing an MVP scope, sequencing discovery, resolving specialist tradeoffs, or creating a room-to-build roadmap.
---

# Feasibility Roadmap Synthesis

## Purpose

Turn uncertain cross-functional findings into a decision-ready plan that maximizes learning and customer value while avoiding premature commitments.

## Procedure

1. State the decision to be made and the user outcome it must enable.
2. List assumptions by category: desirability, technical feasibility, buildability, operational viability, and trust.
3. Score each assumption by impact if wrong, uncertainty, dependency centrality, and cost of validation.
4. Prioritize tests that retire high-impact, high-uncertainty assumptions before downstream investment.
5. Define phases as explicit gates, not calendar promises.
6. For each gate, name the representative test case, measurable threshold, owner, and proceed, revise, or stop decision.
7. Record deferred work and why it is premature.

## Prioritization Rules

- Validate capture accuracy and correction workflows before promising automated manufacturing outputs.
- Validate that target users value a concept-to-drawing workflow before optimizing broad furniture coverage.
- Establish a narrow, repeatable furniture category before generalizing geometry or construction rules.
- Prefer editable, reviewable intermediate artifacts over opaque end-to-end generation.
- Treat buildability review as a product requirement, not a late QA activity.

## Roadmap Format

| Phase | Goal | Evidence required | Dependencies | Exit decision |
|---|---|---|---|---|
| Discover | Confirm user problem and narrow use case | | | |
| Prove | Validate critical technical handoffs | | | |
| Pilot | Demonstrate repeatable user outcome | | | |
| Scale | Extend coverage only after reliability holds | | | |

## Output

Return a recommended sequence, validation gates, explicit assumptions, key tradeoffs, and a short list of work that should not yet be funded.
