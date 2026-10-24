---
name: decision-analysis
description: >
  Structured evaluation and selection among competing options. Applies decision matrices,
  Multi-Criteria Decision Analysis (MCDA), trade-off analysis, and real options thinking
  to move from "we have options" to "here's the best path and why."
  Use when comparing options, trade-offs, and decision criteria.
---

# Decision Analysis Skill

This skill fills the gap between problem decomposition (which produces sub-problems and options) and argument synthesis (which builds the case for a position). Use it when an agent faces two or more competing options and needs a defensible, transparent selection process.

---

## When to Use This Skill

- After problem decomposition has generated multiple solution approaches
- When stakeholders disagree on which option to pursue
- When trade-offs are non-obvious and require structured comparison
- When a decision needs to be auditable and explainable to others
- When "gut feel" isn't sufficient — the stakes are too high or the options too close

---

## Decision Analysis Protocol

### Step 1: Frame the Decision

Before evaluating options, define the decision clearly:

1. **Decision statement:** "We need to choose between [Option A], [Option B], and [Option C] for [purpose]."
2. **Decision type:** Classify the decision:
   - **Reversible vs. irreversible.** Reversible decisions should be made faster with less analysis. Irreversible decisions warrant deep evaluation.
   - **One-way door vs. two-way door.** (Amazon's framing.) One-way doors = high-stakes, hard to undo. Two-way doors = try it, adjust if wrong.
   - **Time-sensitive vs. time-flexible.** Urgency changes the analysis depth. Don't spend 3 weeks analyzing a decision that needs to be made today.
3. **Decision constraints:** What's non-negotiable? (Budget ceiling, timeline, regulatory requirements, team capacity.) These are binary filters, not criteria to weigh.
4. **Decision owner:** Who makes the final call? (Not who has opinions — who decides.)

### Step 2: Define Evaluation Criteria

Identify what matters for this decision. Good criteria are:

- **Relevant:** Directly connected to the goals this decision serves.
- **Measurable:** Can be assessed (quantitatively or on a defined qualitative scale).
- **Independent:** Don't overlap significantly — avoid double-counting the same benefit.
- **Complete:** Cover all dimensions that matter. Missing a criterion is worse than having too many.

**Common criteria categories:**
- Strategic fit (alignment with goals, mission, long-term direction)
- Financial impact (cost, revenue, ROI, payback period)
- Risk (probability of failure, severity of downside, reversibility)
- Feasibility (technical complexity, team capability, timeline realism)
- Stakeholder impact (customer value, employee impact, partner effects)
- Opportunity cost (what you give up by choosing this option)

### Step 3: Weight the Criteria

Not all criteria matter equally. Assign weights using one of these methods:

**Direct assignment (simplest):**
- Distribute 100 points across all criteria. More points = more important.
- Example: Financial impact (30), Strategic fit (25), Feasibility (20), Risk (15), Stakeholder impact (10).

**Pairwise comparison (more rigorous):**
- Compare each criterion against every other: "Is financial impact more important than strategic fit for this decision?"
- Count wins per criterion. Normalize to weights.
- See `references/multi-criteria-analysis.md` for the Analytic Hierarchy Process (AHP) method.

**Swing weighting (most precise):**
- For each criterion, imagine the worst realistic outcome and the best realistic outcome.
- Which criterion has the biggest "swing" from worst to best? That gets the highest weight.
- This prevents over-weighting criteria that sound important but don't actually vary much between options.

### Step 4: Score Options Against Criteria

For each option, assess performance on each criterion:

**Quantitative criteria:** Use actual numbers (cost in dollars, timeline in weeks, projected revenue).

**Qualitative criteria:** Use a consistent scale:
- 1 = Poor / significantly below acceptable
- 3 = Acceptable / meets minimum requirements
- 5 = Good / exceeds requirements
- 7 = Excellent / significantly exceeds requirements
- 9 = Outstanding / best realistic outcome

**Evidence requirement:** Every score must have a brief justification. "Strategic fit: 7 — aligns with our stated priority of expanding into enterprise, and the team has relevant experience." No unjustified scores.

### Step 5: Calculate and Analyze

**Weighted score:** For each option: Σ (criterion weight × criterion score) = total weighted score.

**Sensitivity analysis:** Test how robust the result is:
- Change the top-weighted criterion by ±20%. Does the ranking change?
- Remove the criterion where options score most differently. Does the ranking change?
- If the ranking is fragile (small changes flip the result), the decision is close and other factors (timing, reversibility, gut instinct) should influence the final call.

**Dominance check:** Does any option score equal or better on ALL criteria? If yes, it dominates — choose it regardless of weights.

See `references/decision-matrices.md` for worked examples.

### Step 6: Consider What the Matrix Doesn't Capture

Structured analysis is powerful but incomplete. Before finalizing:

- **Real options thinking:** Does one option preserve more future options than others? Flexibility has value, especially under uncertainty. See `references/multi-criteria-analysis.md`.
- **Regret minimization:** Which choice would you regret most if it fails? (Bezos's framework: "At 80, which decision would I regret not making?")
- **Second-order effects:** What does each option make easier or harder downstream? (Choosing vendor A locks you into their ecosystem; choosing vendor B preserves flexibility.)
- **Political feasibility:** The analytically "best" option may be politically impossible. Factor in stakeholder dynamics.

### Step 7: Make the Recommendation

State the recommendation clearly:

1. **Recommended option** and 1-sentence rationale.
2. **Why not the alternatives** — 1-sentence dismissal for each runner-up.
3. **Key risk** of the recommended option and the mitigation.
4. **Conditions that would change this recommendation** — what new information would flip the decision.
5. **Suggested next step** — the first concrete action.

Use the template at `templates/decision-report.md`.

---

## Decision Speed Calibration

Not every decision deserves the full protocol. Match analysis depth to decision stakes:

| Decision Type | Analysis Depth | Time Budget |
|---|---|---|
| Irreversible, high-stakes | Full protocol (Steps 1-7) | Hours to days |
| Significant but reversible | Steps 1-4 + recommendation | 30-60 minutes |
| Routine, low-stakes | Binary filter on constraints + gut check | 5-10 minutes |
| Time-critical | Constraints filter + dominant option check | Minutes |

If you catch yourself spending more time analyzing than the decision is worth, stop and decide.

---

## Anti-Patterns

- **Analysis paralysis:** Over-analyzing when the options are close. If sensitivity analysis shows no robust winner, pick the most reversible option and move.
- **Criteria gaming:** Choosing criteria to justify a pre-selected option. Set criteria BEFORE evaluating options.
- **Equal weighting fallacy:** Giving all criteria equal weight because weighting feels subjective. Unweighted analysis is also a weighting decision — it just pretends all criteria matter equally.
- **Ignoring opportunity cost:** Evaluating each option in isolation. Always ask: "What are we NOT doing by choosing this?"
- **Sunk cost anchoring:** Favoring an option because of past investment. Past costs are irrelevant to future decisions.

---

## Reference Index

| File | Content | When to read |
|---|---|---|
| `references/decision-matrices.md` | Weighted scoring matrices, Pugh matrix, worked examples | Any multi-option evaluation |
| `references/multi-criteria-analysis.md` | AHP, MCDA, real options thinking, sensitivity analysis | Complex or high-stakes decisions |
| `templates/decision-report.md` | Structured output template | Every decision analysis |
