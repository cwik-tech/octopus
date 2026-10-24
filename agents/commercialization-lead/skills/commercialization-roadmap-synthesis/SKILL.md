---
name: commercialization-roadmap-synthesis
description: Synthesizes a phased commercialization roadmap from prototype to market entry with explicit gates, dependencies, and decision points. Identifies which activities can overlap, which must sequence, and what must be validated before each phase. Use after risk classification and specialist input have been gathered, when converting a risk map into a concrete timeline.
---

# Commercialization Roadmap Synthesis

## Purpose

Convert the risk landscape into a phased roadmap with explicit gates, dependencies, and decision points. Make clear which activities can run in parallel, which must sequence, and what must be true before the next phase begins.

## When to Use

Use this skill when:
- All domain specialists have input on their risks and timelines.
- The risk map has been validated and hidden dependencies surfaced.
- A phased roadmap is needed to align the team and investors.
- Timeline decisions must be made (e.g., "Do we wait for regulatory decision before manufacturing scale-up?").

## Roadmap Structure

### Phase Definitions

**Phase 0 (Pre-Development):** Prototype exists, basic feasibility proven, but significant work remains.
- Activities: Technical de-risking, preliminary regulatory research, manufacturing feasibility study, market sizing.
- Gate: Technical design path clear, regulatory pathway identified, manufacturing method chosen.

**Phase 1 (Regulatory Pathway):** Regulatory engagement and data generation begin.
- Activities: Regulatory dossier preparation, clinical trial design/initiation, manufacturing data generation, supply chain development.
- Gate: Regulatory submission filed, manufacturing pilot run successful, supply chain locked in.

**Phase 2 (Regulatory Approval & Manufacturing Scale):** Parallel execution of approval and scale-up.
- Activities: Regulatory review, clinical trial completion, manufacturing process validation, quality system buildout, commercial team assembly.
- Gate: Regulatory approval received, manufacturing validated, commercial readiness confirmed.

**Phase 3 (Market Entry & Scale):** Product launches, volume ramps, market development.
- Activities: Market distribution, customer acquisition, manufacturing scale, post-market surveillance.
- Gate: First revenue, market feedback incorporation, scale production achieved.

### Gate Definitions

Every phase ends with a decision gate. A gate is a clear, testable requirement that must be met before the next phase begins.

**Gate = (What must be true) + (Who decides) + (When does the decision happen)**

Examples:
- "Regulatory pathway classification confirmed by [regulatory lead], by [date]." (Clear and testable.)
- "Manufacturing pilot run achieves 80% yield at [volume], by [date]." (Testable, not vague.)
- "Customers commit to [N] orders in first year, by [date]." (Proves market demand.)

**Red flags:**
- "We'll be ready when we're ready." (Not a gate — too vague.)
- "Regulatory approval." (A gate, but missing the owner and date.)
- Gates that assume other gates are already met (use explicit dependencies instead).

### Activity Sequencing

**Activities that must sequence (one after the other):**
- Technical design → Manufacturing design → Process validation (cannot parallelize)
- Regulatory submission → Regulatory review → Regulatory approval (fixed order)
- Clinical trial initiation → Trial enrollment → Trial completion → Data analysis (phases have dependencies)

**Activities that can overlap (run in parallel):**
- Technical design ↔ Preliminary regulatory research (inform each other but don't block)
- Manufacturing scale-up ↔ Regulatory review (often independent streams)
- Market development ↔ Regulatory approval (can start customer conversations in parallel)
- Supply chain lock-in ↔ Manufacturing validation (can proceed in parallel)

**Key insight:** Compress the timeline by running parallel activities wherever possible, but only if the activities truly do not block each other. Regulatory pathway almost always blocks manufacturing scale decisions — do not assume they can run fully in parallel.

### Dependencies Across Domains

Make all cross-domain dependencies explicit.

**Examples:**
- Regulatory pathway depends on: Technical design locked → use this to determine when regulatory engagement can start.
- Manufacturing scale depends on: Regulatory pathway confirmed → know which manufacturing data regulatory requires before designing the process.
- Market entry depends on: Regulatory approval + Manufacturing validation + Commercial team ready → all three must be true before launch date.

## Timeline Construction

### Method

1. **List all activities** required from current state to market entry.
2. **Assign ownership** to each activity (technical lead, regulatory lead, etc.).
3. **Estimate duration** for each activity (ask the domain owner, do not guess).
4. **Identify dependencies** (what activity must finish before this one starts?).
5. **Build a Gantt chart mentally or visually:**
   - Critical path activities: tasks whose delay delays the entire timeline.
   - Non-critical activities: tasks with float (can slip a bit without impacting overall timeline).
6. **Identify the bottleneck:** The critical path activity with the longest duration or highest risk.

### Realistic Estimation

**Common mistakes:**
- Assuming activities start the moment they theoretically can (not accounting for resource availability or decision lag).
- Underestimating regulatory and manufacturing timelines (almost always happens).
- Assuming parallel activities share no resources (they do; resource contention adds delays).
- Forgetting buffer time (add 20–30% buffer for delays, approvals, rework).

**Recommendations:**
- Ask domain experts for estimates, not guesses.
- Add precedent-based estimates ("How long did regulatory take for Product X?")
- Identify high-risk activities and add extra buffer (regulatory decisions, clinical trials, supply chain).
- Use a pessimistic estimate for the critical path; use a realistic estimate for non-critical work.

## Phased Roadmap Output

Delivery a roadmap with these components:

### Phase [N] Timeline
- **Duration:** [Start date] to [End date] ([X months])
- **Gate:** [Clear, testable requirement that must be met to proceed]
- **Activities:**
  - [Activity name] (Owner: [name], Duration: [X weeks/months])
  - [Dependency information if relevant]
- **Critical Assumptions:** [Key assumptions that, if wrong, derail this phase]
- **Risk Highlights:** [Highest-risk activities in this phase]

### Phase Summary Table

| Phase | Duration | Owner | Gate | Risk |
|-------|----------|-------|------|------|
| ... | ... | ... | ... | ... |

### Critical Path

Identify the sequence of activities that determines the overall timeline. Any delay in a critical-path activity delays the launch date.

**Format:**
- Activity A (X months) → Activity B (Y months) → Activity C (Z months) = Total of (X+Y+Z) months
- Non-critical activity D (can slip X weeks without impacting launch)

### Decision Gates and Owners

Every gate must have a named owner and a decision date. No orphaned gates.

**Format:**
- Gate: [What must be true]
- Owner: [Name/role]
- Decision date: [Date]
- If gate is not met by decision date: [What happens? Do we pivot, delay, or accept risk?]

### Hidden Risks and Assumptions

List assumptions that, if wrong, would force a timeline re-plan:
- Assumption: "Regulatory pathway is Class II."
  - If wrong: Reclassified as Class III → add 12–18 months for clinical data.
- Assumption: "Manufacturing scale will be ready by Q3."
  - If wrong: Supplier delays → delay Phase 2 by 6 months.

## Next Action

Once the roadmap is synthesized:

1. **Socialize with specialists:** Walk each domain lead through the roadmap. Validate dependencies and timelines.
2. **Identify owners:** Every gate and critical activity must have a named owner.
3. **Add contingency plans:** For each high-risk activity, define Plan B if it slips or fails.
4. **Lock funding:** Ensure capital is available at each funding gate.
5. **Set decision dates:** Calendar all gates and decisions. Do not allow them to drift.
