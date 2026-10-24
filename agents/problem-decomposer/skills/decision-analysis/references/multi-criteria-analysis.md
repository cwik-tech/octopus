# Multi-Criteria Decision Analysis (MCDA) and Advanced Methods

## Analytic Hierarchy Process (AHP)

AHP (Analytic Hierarchy Process) provides a mathematically rigorous method for determining criteria weights through pairwise comparison. Use when stakeholders disagree on what matters most, or when the weight assignment feels arbitrary.

### AHP Process

1. **List criteria.**
2. **Pairwise compare:** For each pair of criteria, ask: "How much more important is Criterion A than Criterion B?"
   - Use the Saaty scale: 1 (equal), 3 (moderate preference), 5 (strong preference), 7 (very strong), 9 (extreme preference).
3. **Build the comparison matrix.** If A vs. B = 5, then B vs. A = 1/5.
4. **Calculate priority vector.** Normalize each column, then average each row. This gives the weight.
5. **Check consistency.** Calculate the Consistency Ratio (CR). If CR > 0.10, the judgments are inconsistent — revisit.

### Worked Example

Three criteria: Cost (C), Quality (Q), Speed (S).

| | Cost | Quality | Speed |
|---|---|---|---|
| Cost | 1 | 3 | 5 |
| Quality | 1/3 | 1 | 3 |
| Speed | 1/5 | 1/3 | 1 |

Column sums: C=1.53, Q=4.33, S=9.

Normalized and averaged: Cost=0.63, Quality=0.26, Speed=0.11.

**Interpretation:** Cost is approximately 6 times more important than Speed and approximately 2.5 times more important than Quality in this decision.

### When AHP Adds Value

- When multiple stakeholders need to agree on weights (the pairwise process surfaces disagreements)
- When criteria importance is genuinely unclear
- When the decision will be scrutinized and needs mathematical defensibility

### When AHP Is Overkill

- Fewer than 4 criteria (direct assignment is fine)
- Low-stakes or reversible decisions
- When speed matters more than precision

---

## Real Options Thinking

Traditional decision analysis picks the "best" option now. Real options thinking asks: which option preserves the most valuable future choices?

### Core Concept

An option is the right — but not the obligation — to take action in the future. Options have value because they reduce commitment under uncertainty.

### Applying Real Options to Decisions

1. **Identify embedded options** in each alternative:
   - Option to expand (can we scale this approach later?)
   - Option to abandon (can we exit cheaply if it doesn't work?)
   - Option to switch (can we change direction without starting over?)
   - Option to defer (can we wait for more information before committing?)
2. **Value flexibility.** If two options have similar expected outcomes but one preserves more options, prefer the flexible one.
3. **Recognize option-killing decisions.** Some choices eliminate future options permanently (exclusive contracts, irreversible architecture, burned bridges). Flag these.

### Decision Rule

When expected outcomes are similar:
- **Prefer the option that preserves the most future options.**
- **Defer irreversible decisions** until the last responsible moment (not the last possible moment — the last moment where delay doesn't create new costs).
- **Stage commitments.** Instead of choosing A or B, ask: "Can we run a small experiment with A while keeping B viable?"

---

## Sensitivity Analysis Methods

### One-at-a-Time (OAT)

Change one input (weight or score) at a time, hold others constant. Observe which changes flip the ranking.

**Procedure:**
1. Identify the winning option and its margin over the runner-up.
2. For each criterion weight: increase by 20%, decrease by 20%. Recalculate. Does the winner change?
3. For each score: increase/decrease by 1 point. Recalculate. Does the winner change?
4. Report which parameters are "decision-critical" (small changes flip the result).

### Threshold Analysis

Ask: "How much would [criterion weight or score] need to change before the decision flips?"

**Example:** "HubSpot leads Salesforce by 55 points. For Salesforce to win, Feature Completeness weight would need to increase from 25 to 40, all else equal. Is that plausible?"

### Scenario-Based Sensitivity

Define 2-3 scenarios that represent different futures or stakeholder perspectives:

- **Optimistic scenario:** Best-case assumptions for the recommended option.
- **Pessimistic scenario:** Worst-case assumptions.
- **Alternative priorities:** Weight criteria as a different stakeholder would.

If the recommendation holds across all scenarios, confidence is high. If it flips, the decision depends on beliefs about the future — surface this explicitly.

---

## For AI Agents

- **Default to weighted scoring** for most decisions. It's transparent, auditable, and sufficient for 80% of cases.
- **Escalate to AHP** when stakeholders disagree on weights or when the decision will be scrutinized.
- **Apply real options thinking** whenever the decision involves uncertainty about the future. Ask: "Which option preserves the most flexibility?"
- **Always run sensitivity analysis** on close decisions (margin < 15%). Report which assumptions are decision-critical.
- **Present the matrix, not just the conclusion.** The value of structured decision analysis is transparency. Show the work.
