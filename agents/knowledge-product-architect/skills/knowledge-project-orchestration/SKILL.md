---
name: knowledge-project-orchestration
description: Plan and orchestrate WP1–5 (Requirements, Parsing, Retrieval, Architecture, Pilot) sequencing, define gate criteria, manage dependencies, and ensure decision ownership
---

# Knowledge Workpackage Orchestration

## Purpose

Orchestrate a knowledge systems project through five phases (WP1–5) from scope through pilot validation. Define the sequencing, gate criteria, and decision points. Ensure each phase produces the outputs required by the next phase and that no phase ships without evidence the gate criteria were met.

## When to Use This Skill

- **WP1 Planning:** At project start, define the five-phase roadmap, gate criteria for each phase, acceptance thresholds, and ownership.
- **Phase Completion:** Before moving to the next phase, verify gate criteria were met; flag any blockers or evidence gaps.
- **Risk Management:** Identify phase dependencies and critical path; escalate risks that could delay the overall roadmap.

## Core Heuristics

**The Gate Criterion:** Every phase must have a specific, measurable gate criterion before the next phase starts. "Phase 2 is done" is not a gate; "Parsing fidelity on the test set is ≥90%" is.

**The Dependency Chain:**
- WP1 output (pilot corpus, acceptance thresholds, build-vs-buy decision) gates WP2.
- WP2 output (parser selection, fidelity results) gates WP3.
- WP3 output (retrieval quality results, Recall@k ≥ threshold) gates WP4.
- WP4 output (architecture, security review, cost model) gates WP5.
- WP5 output (pilot validation, runbooks, handover readiness) unlocks scale-out.

Do not parallelize phases unless dependencies allow (e.g., security threat modeling can start during WP1).

**The Handover Criterion:** WP5 is not "the pilot is done." It's "the FST team can operate this knowledge base with documented runbooks and named ownership." If that's not true, the project isn't done.

## Workflow

1. **Define the five-phase roadmap:**
   - WP1: Scope, inventory, acceptance criteria, build-vs-buy
   - WP2: Parsing evaluation and selection
   - WP3: Retrieval design and evaluation
   - WP4: Architecture, security, cost model
   - WP5: Pilot validation, runbooks, handover
2. **Set gate criteria for each phase:**
   - WP1 gate: Build-vs-buy documented and approved; pilot corpus defined; acceptance thresholds agreed
   - WP2 gate: Parsing fidelity ≥ threshold on test set; parser selected
   - WP3 gate: Retrieval Recall@k ≥ baseline + margin; citations verified; cost per query justified
   - WP4 gate: Security review passed; architecture design approved; cost model validated; operational runbooks drafted
   - WP5 gate: Acceptance criteria met; FST team trained and ready for handover; scale-out roadmap defined
3. **Identify phase dependencies and critical path:**
   - WP2 depends on WP1 (test corpus, fidelity threshold)
   - WP3 depends on WP2 (parser output, chunking strategy)
   - WP4 can start early (security threat modeling, landing zone design) but must complete before WP5
   - WP5 depends on all prior phases
4. **Manage risk and escalate blockers:**
   - If a gate criterion cannot be met, escalate before the phase ends
   - If a phase takes longer than planned, assess impact on downstream phases
   - Keep a risk register (fidelity insufficient, access-control complexity, cost overrun, handover readiness)

## Red Lines

- Never move to the next phase without evidence the gate criteria were met
- Never use "we'll iterate in the next phase" as an excuse to skip a gate
- Never conflate "the phase is done" with "we're ready to move on"