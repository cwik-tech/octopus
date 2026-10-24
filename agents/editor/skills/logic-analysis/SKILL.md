---
name: logic-analysis
description: >
  Protocols for evaluating logical integrity in business documents. Covers fallacy detection,
  assumption surfacing, causal reasoning validation, and argument stress-testing. Core skill
  for the Editor agent.
  Use when checking a draft for unsupported claims, contradictions, or reasoning gaps.
---

# Logic Analysis Skill

## When to Use

On every document review during Layer 2 (Structural Logic). The Editor uses this skill to evaluate whether the document's arguments are logically sound — separate from whether they are well-written (Layer 3) or style-compliant (Layer 4).

---

## Logic Evaluation Protocol

### Step 1 — Argument Extraction

Before evaluating logic, extract every argument in the document:

1. Read each section
2. Identify every claim (a statement that could be true or false)
3. For each claim, identify its supporting evidence (if any)
4. For each claim, identify its reasoning bridge (how the evidence connects to the claim)
5. Map the dependency chain: which claims depend on other claims?

**Output format:**

```
CLAIM 1: [statement]
  EVIDENCE: [what supports it]
  REASONING: [why the evidence supports the claim]
  DEPENDS ON: [other claims this one requires]
  STATUS: Supported / Partially supported / Unsupported / Circular
```

### Step 2 — Fallacy Detection

Scan extracted arguments for these common fallacies in business documents:

**1. Correlation-Causation Confusion**

"We launched the campaign in March and revenue increased in April, proving the campaign worked."

**Test:** Is there a demonstrated causal mechanism? Could other factors explain the result? Was a control used?

**Flag as:** BLOCKING if it's a key argument supporting a recommendation. WARNING if it's a secondary point.

**2. Survivorship Bias**

"All three successful companies in this space used strategy X, so we should too."

**Test:** What about companies that used strategy X and failed? Are they counted? If you only look at winners, any pattern you find is meaningless.

**Flag as:** WARNING. Suggest including failure cases or caveating the analysis.

**3. False Dichotomy**

"We can either invest heavily in this initiative or accept declining market share."

**Test:** Are there really only two options? Is the document presenting a binary where a spectrum exists?

**Flag as:** WARNING if it oversimplifies but doesn't break the argument. BLOCKING if it eliminates a viable option the reader should consider.

**4. Appeal to Authority**

"McKinsey's research says X, therefore X is true for our situation."

**Test:** Does the authority's conclusion apply to this specific context? Is the authority cited for a factual claim or an opinion?

**Flag as:** SUGGESTION. Note that the authority should be supplemented with situation-specific evidence.

**5. Anchoring Bias**

"The previous consultant valued this at $50M, so our range should be $40-60M."

**Test:** Is the anchor justified? Does the document critically evaluate the anchor, or does it accept it as a starting point without question?

**Flag as:** WARNING if the anchor influences the conclusion without justification.

**6. Hasty Generalisation**

"We interviewed three customers and they all said X, confirming that our customers want X."

**Test:** Is the sample size sufficient? Is the sample representative? Three customers out of 10,000 is not a finding — it's an anecdote.

**Flag as:** BLOCKING if it's the primary evidence for a recommendation. WARNING if it supplements other evidence.

**7. Moving the Goalposts**

"We didn't hit our revenue target, but we exceeded our engagement target, so the initiative was successful."

**Test:** Were the success criteria defined before the initiative? Is the document retroactively redefining success?

**Flag as:** WARNING. Note the original success criteria and the shift.

**8. Straw Man**

"The alternative to our recommendation is to do nothing and watch the market pass us by."

**Test:** Is the alternative fairly represented? Or is a weak version of the opposing case being constructed to make the recommendation look better?

**Flag as:** BLOCKING if it misrepresents a viable alternative the reader should consider.

**9. Sunk Cost Reasoning**

"We've already invested $2M in this project, so we should continue."

**Test:** Would you make this investment today with what you know now? Prior spend is irrelevant to forward-looking decisions.

**Flag as:** WARNING. Note that prior investment should not factor into recommendations.

**10. Composition Fallacy**

"Each team member is excellent, so the team will be excellent."

**Test:** Does the document assume properties of parts transfer to the whole? Teams, markets, and systems have emergent properties that individual components don't.

**Flag as:** SUGGESTION unless it's a core argument.

---

### Step 3 — Assumption Surfacing

Every argument rests on unstated assumptions. Surface them and evaluate their safety.

**Protocol:**

1. For each major claim, ask: "What must be true for this claim to hold?"
2. List the implicit assumptions
3. Classify each assumption:

| Category | Definition | Example | Risk |
|---|---|---|---|
| **Safe** | The reader will almost certainly share this assumption | "Customers prefer lower prices, all else equal" | Low — no need to state |
| **Reasonable** | Most readers will share this, but it's worth stating | "The regulatory environment will remain stable through 2025" | Medium — state it explicitly |
| **Risky** | The reader may not share this assumption | "The team can hire 20 engineers in 6 months in this market" | High — must be argued, not assumed |
| **Hidden** | The author may not even realize they're making this assumption | "Our competitive advantage will persist even as competitors see our success" | Critical — surface and evaluate |

**For each Risky or Hidden assumption:**
- Flag as WARNING or BLOCKING depending on how much the argument depends on it
- State what happens to the recommendation if this assumption is wrong
- Suggest making the assumption explicit and either defending it or caveating the conclusion

### Step 4 — Causal Chain Validation

When a document claims X leads to Y leads to Z, validate each link:

**Protocol:**

```
CLAIM: "Investing in customer success will reduce churn, which will increase revenue"

Link 1: Investment in customer success → reduced churn
  Mechanism: [Is there a plausible mechanism?]
  Evidence: [Does the document provide evidence for this link?]
  Strength: Strong / Moderate / Weak / Missing

Link 2: Reduced churn → increased revenue
  Mechanism: [Is there a plausible mechanism?]
  Evidence: [Does the document provide evidence for this link?]
  Strength: Strong / Moderate / Weak / Missing

Overall chain strength: [Weakest link determines overall strength]
```

**Rules:**
- A chain is only as strong as its weakest link
- If any link is "Missing," the entire causal claim is unsupported → BLOCKING
- If any link is "Weak," the claim needs caveating → WARNING
- If all links are "Strong" or "Moderate," the claim holds → no flag

### Step 5 — Stress Test

For the document's primary recommendation, apply three adversarial tests:

**Test 1 — Inversion:** "What if the opposite recommendation were made? What evidence would support it?" If you can build a plausible case for the opposite, the document's argument may need strengthening.

**Test 2 — Extreme Condition:** "Under what circumstances would this recommendation fail catastrophically?" If the document doesn't acknowledge these conditions, flag as WARNING.

**Test 3 — Time Horizon:** "Is this recommendation good in 6 months? 2 years? 5 years?" If the document only considers one time horizon, flag as SUGGESTION to acknowledge the others.

---

## Issue Reporting Format

For each logic issue found:

```
ISSUE: [Short title]
TYPE: [Fallacy name / Unsupported claim / Hidden assumption / Broken causal chain]
LOCATION: [Section and paragraph]
SEVERITY: BLOCKING / WARNING / SUGGESTION
PROBLEM: [What's wrong — 1-2 sentences]
IMPACT: [Why it matters for the reader / recommendation]
FIX: [Specific suggestion for how to resolve]
```

---

## References & Templates

| File | Content |
|---|---|
| `references/business-fallacies.md` | Extended catalog of logical fallacies common in business consulting with detection heuristics |
| `references/assumption-patterns.md` | Common hidden assumptions in strategy, operations, and financial documents |
| `templates/logic-review.md` | Structured template for documenting logic analysis findings |
