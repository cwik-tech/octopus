---
name: research-question-architect
description: Synthesize upstream pipeline outputs into a risk-ordered research agenda with testable hypotheses, kill criteria, method selection, and decision gates. Use as the terminal Stage 5 of the R&D research pipeline, when a shaped problem still lacks a research plan, or when a research effort feels unfocused and fatal assumptions need front-loading.
---

# Research Question Architect

A systematic protocol for synthesizing upstream pipeline outputs into a structured, risk-ordered research agenda. This skill converts the problem map, domain landscape, and strategic hypotheses into a decision-ready research plan with testable hypotheses, kill criteria, method selection, and decision gates.

## When to Use

- **Stage 5 of 5 (terminal agent).** After Problem Decomposition, Domain Research, Scenario Planning, and Strategic Reframing have completed. The Research Question Architect receives all upstream outputs and produces the research plan that feeds into decision-making.
- When the board has a shaped problem but doesn't yet know what questions to research, in what order, using which methods, or when they can stop researching.
- When you need to distinguish between "interesting questions" and "questions that would change a decision."
- When a research effort feels unfocused or is consuming too much time — this protocol front-loads fatal assumptions and kills research that won't move the needle.

## Core Protocol: Six Steps

### Step 1 — Information Gap Analysis

Map the current state of knowledge using three columns: What We Know, What We Don't Know, and What We Need to Know.

**Analysis rules:**

1. **What We Know:** Explicitly list outputs from all upstream agents (Problem Decomposition findings, Domain Research insights, Scenario Planning outputs, Strategic Reframing positioning).
2. **What We Don't Know:** Enumerate all unknowns related to the problem, applications, and strategic position. Be exhaustive. Include technical unknowns, market unknowns, competitive unknowns, adoption unknowns, regulatory unknowns.
3. **What We Need to Know:** Filter column 2 ruthlessly. Include ONLY unknowns that would change a decision, unlock a path forward, or eliminate a fatal risk. Explicitly deprioritize interesting-but-non-critical unknowns — they go to the Parking Lot.

**Output:** A three-column table showing the knowledge landscape. Include rationale for each "Need to Know" entry: "This would change X decision" or "This would eliminate Y risk."

### Step 2 — Critical Assumption Identification

Extract all assumptions embedded in the problem analysis, proposed solutions, and strategic direction. For each assumption, assess risk and certainty.

**Identification rules:**

1. List all assumptions per application, including technical assumptions, market assumptions, economic assumptions, competitive assumptions, adoption assumptions, and regulatory assumptions.
2. For each assumption, rate on two dimensions:
   - **Risk if wrong:** Fatal (kills the entire direction), Damaging (requires major pivot), Adjustable (requires course correction)
   - **Certainty:** High (validated through market test or precedent), Medium (plausible but untested), Low (speculative or contradicted by early signals)
3. Explicitly call out unstated assumptions — the ones nobody is saying out loud but everybody believes.

**Output:** A table with columns: Assumption, Application, Risk if Wrong, Certainty, Priority (derived from risk × certainty). Sort by priority descending.

### Step 3 — Hypothesis Formulation

Convert each critical assumption into a testable hypothesis with decision locks and kill criteria.

**Formulation template:**

```
We believe [proposition] because [reasoning from upstream analysis] and can test by [specific method] within [realistic timeframe] at [cost estimate]. 
If confirmed: [which decision is unlocked / which risk is eliminated]. 
If refuted: [kill criterion — the specific outcome that ends this direction].
```

**Formulation rules:**

1. Every hypothesis must be testable within the timeframe and budget available.
2. Kill criteria must be specific (not "we're not confident"). They must be observable (not subjective). They must be early-testable (not "we'll know after launch").
3. If an assumption has no testable hypothesis, flag it as non-researchable — it will require a judgment call or a bet.
4. Chain hypotheses when later hypotheses depend on earlier ones confirming. This reveals decision gates.

**Output:** A hypothesis table with columns: Hypothesis, Reasoning, Test Method, Timeframe, Cost, Decision Unlocked, Kill Criterion.

### Step 4 — Question Taxonomy & Method Matching

Classify each research need by question type, then match to the method best suited to answer it. Include method benchmarks.

**Question types:**

- **Descriptive:** What is the current state? (e.g., "How large is the market?")
- **Relational:** What patterns correlate? (e.g., "Which customer segments churn fastest?")
- **Causal:** Why does something happen? (e.g., "Does price sensitivity drive churn?")
- **Evaluative:** How well does something work? (e.g., "Does this feature improve retention?")

**Method matching:**

- **Desk Research:** Documented answers (market size, regulatory rules, historical trends). Best for: Descriptive, relational. Timeline: 1–2 weeks. Cost: Low. Confidence: Medium–High.
- **Expert Interviews:** Tacit knowledge, mental models, undocumented patterns. Best for: Causal, relational (mechanisms). Timeline: 2–4 weeks. Cost: Low–Medium. Confidence: Medium.
- **Market Surveys:** Statistical validation of patterns, segment analysis, behavioral intent. Best for: Relational, evaluative. Timeline: 4–8 weeks. Cost: Medium. Confidence: Medium–High.
- **Prototyping:** Technical feasibility, feature viability, interaction dynamics. Best for: Causal (mechanism), evaluative. Timeline: 2–6 weeks. Cost: Medium–High. Confidence: High (for technical questions).
- **Field Observation:** Actual behavior in context, adoption barriers, usage patterns. Best for: Causal, evaluative. Timeline: 4–12 weeks. Cost: Medium. Confidence: High.

**Matching rules:**

1. Every question gets exactly one primary method and 0–2 secondary methods for triangulation.
2. If a question has no good match, it may be non-researchable — it may require prototyping, piloting, or a judgment call.
3. Method combinations (triangulation) are strongest: desk research + expert interviews + field observation converging on the same answer is more credible than any single method.

**Output:** A table with columns: Question, Type, Primary Method, Secondary Methods, Timeline, Cost, Confidence Level.

### Step 5 — Risk-First Sequencing

Order research so fatal assumptions are tested first. Structure into decision gates that binary outcomes (go/no-go/pivot).

**Sequencing rules:**

1. **Fatal first:** Research questions that would kill the entire direction must be answered first. No point researching market validation before confirming technical feasibility if technical infeasibility kills the project.
2. **Gate structure:** Organize into 2–3 decision gates, each with a 2–3 week window and a binary (or ternary) outcome.
3. **Standard three-gate structure:**
   - **Gate 1 — Technical Feasibility:** Can we build this? (prototyping, expert interviews, architecture review)
   - **Gate 2 — Market Validation:** Will customers buy this? (surveys, field observation, expert interviews)
   - **Gate 3 — Competitive Positioning:** Can we compete on these terms? (market intelligence, scenario planning, strategic reframing)
4. **Gate design:** Each gate must have explicit go/no-go/pivot conditions. "Go" means the direction survives to the next gate. "No-go" means kill this branch. "Pivot" means shift scope or positioning.

**Output:** A sequence table with columns: Week, Gate / Research Block, Key Questions, Kill Criteria, Expected Outcome, Next Gate.

### Step 6 — Toolkit Routing

Map each research question to the Problem & Thinking agent best suited to execute it.

**Routing options:**

- **Domain Research:** Deep domain expertise, market structure, regulatory rules, historical patterns.
- **Problem Decomposition:** Breaking down complex questions, identifying sub-dependencies, constraint analysis.
- **Scenario Planning:** Market evolution, competitive positioning, adoption curves, contingency planning.
- **Strategic Reframing:** Positioning strategy, competitive differentiation, customer value proposition testing.
- **Prioritization:** Resource allocation, trade-off analysis, sequencing of concurrent research efforts.

**Routing rules:**

1. Every question must route to exactly one agent (primary executor).
2. Some questions may require hand-offs (e.g., Domain Research for market context, then Strategic Reframing for positioning implications).
3. Flag dependencies: if Question A must complete before Question B, note it explicitly.

**Output:** A routing table with columns: Question, Primary Agent, Secondary Agents, Dependencies.

## Output Format

After running the protocol, deliver the research plan using the `research-plan.md` template. The template includes:

- Plan metadata (applications covered, total questions, estimated effort, estimated cost)
- Executive summary
- Information landscape (three-column analysis)
- Critical assumptions table (risk-ordered)
- Per-application research questions with full specification (hypothesis, type, method, protocol, timeline, cost, decision unlocked, kill criterion, routing)
- Kill criteria summary
- Decision gates (go/no-go/pivot conditions)
- Research sequence (Gantt-style)
- Toolkit routing map
- Backflow triggers (when to halt, pivot, or iterate)
- Parking lot questions (interesting but non-critical)

## Key Principles

1. **Every question must be testable.** If you can't design a test or observation that would give you a clear yes/no/maybe answer within the timeframe, it's not a research question — it's a philosophical question. Move it to the Parking Lot.

2. **Risk-first ordering is non-negotiable.** A beautiful research plan that answers interesting questions in the wrong order wastes time and money. Fatal assumptions must be tested first.

3. **Kill criteria are mandatory.** Research without kill criteria is exploration, not decision support. Kill criteria must be specific (not "we're uncertain"), observable (not subjective), decisive (not "interesting"), and early-testable (not "we'll know after launch").

4. **Don't research interesting-but-non-critical unknowns.** The most common failure mode is a research effort that consumes months and money validating questions that wouldn't change a decision. This is what the Parking Lot is for.

5. **Method triangulation is stronger than single methods.** One survey is suggestive. One survey + field observation + expert interviews converging on the same answer is credible. Choose combinations that triangulate.

6. **Routing to the right executor matters.** Some questions need deep domain expertise (Domain Research). Others need problem decomposition (breaking down complexity). Others need scenario thinking or strategic reframing. Misrouting leads to incomplete answers and rework.

7. **Backflow triggers are decision architecture.** Know in advance what finding would trigger iteration back to earlier agents (Problem Decomposition, if market assumptions break). Know what would trigger pivoting the entire research agenda. Build that structure into the plan.
