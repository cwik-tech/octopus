# Business Fallacies — Reference

Logical fallacies common in business consulting documents, with detection heuristics and fixes. Use during Layer 2 (Structural Logic) review.

---

## Fallacy 1 — Correlation-Causation Confusion

**Definition:** Claiming that because two things happened together (or in sequence), one caused the other.

**Detection pattern:** "We did X, then Y happened, therefore X caused Y."

**Business examples:**
- "We redesigned the onboarding flow in March and churn dropped in April — the redesign worked."
  (What else happened in March? Did a competitor fail? Did a seasonal pattern shift?)
- "Companies with higher employee satisfaction have higher revenue. Therefore, improving satisfaction will increase revenue."
  (Could it be that profitable companies can afford to invest in employee experience?)

**How to flag:**
> "This claim establishes correlation but not causation. What is the proposed mechanism? Were other variables controlled for? Is there a before/after comparison with a control group?"

**Severity:** BLOCKING if the claim supports a primary recommendation. WARNING if it's a secondary supporting point.

---

## Fallacy 2 — Survivorship Bias

**Definition:** Drawing conclusions from successful cases while ignoring failures.

**Detection pattern:** "The successful examples all did X, so we should do X."

**Business examples:**
- "The three market leaders all expanded internationally in year 3. We should do the same."
  (How many companies expanded internationally in year 3 and failed?)
- "The most successful product launches in this space were supported by heavy PR campaigns."
  (The failed launches also had PR campaigns — they just didn't become case studies.)

**How to flag:**
> "This analysis draws from successful examples only. What happened to companies/products/initiatives that tried the same approach and failed? Including failure cases would either strengthen or challenge this conclusion."

**Severity:** WARNING. Rarely BLOCKING unless it's the sole evidence for a recommendation.

---

## Fallacy 3 — False Dichotomy

**Definition:** Presenting a binary choice when more options exist.

**Detection pattern:** "We must either do X or accept Y (bad outcome)."

**Business examples:**
- "We can either invest heavily in the new product line or accept that we'll lose market share."
  (What about incremental investment? Partnerships? Licensing? Exiting the segment strategically?)
- "Either we hire 20 engineers this quarter or the project fails."
  (What about contractors? Scope reduction? Phased delivery?)

**How to flag:**
> "This frames the decision as binary. What other options exist? Is the binary framing genuinely accurate, or does it create a false sense of urgency around the preferred option?"

**Severity:** BLOCKING if it eliminates options the reader should consider. WARNING if it oversimplifies without breaking the argument.

---

## Fallacy 4 — Appeal to Authority

**Definition:** Using an authority's opinion as a substitute for evidence in a specific context.

**Detection pattern:** "According to [prestigious source], X is true/recommended."

**Business examples:**
- "Gartner reports that AI adoption will transform the industry — we must therefore invest in AI."
  (Gartner's general market prediction does not tell you whether your specific company should make a specific investment.)
- "McKinsey's research shows that diverse teams outperform. Therefore, our diversity initiative will improve performance."
  (McKinsey's aggregate research may not apply to your company, sector, or the specific form of diversity in question.)

**How to flag:**
> "The authority cited may be relevant context, but the conclusion requires evidence specific to this company/situation. How does the authority's finding apply here specifically?"

**Severity:** SUGGESTION in most cases. WARNING if the authority is the primary evidence for a recommendation.

---

## Fallacy 5 — Hasty Generalisation

**Definition:** Drawing a broad conclusion from an insufficient or unrepresentative sample.

**Detection pattern:** Small sample → universal claim.

**Business examples:**
- "We interviewed six customers and all said the product is easy to use, confirming our usability is strong."
  (Six self-selected interviews from a base of 5,000 customers is not confirmation.)
- "Three enterprise deals closed in Q4, proving our enterprise motion is working."
  (Three data points are an anecdote, not a validated pattern.)

**How to flag:**
> "The sample size ([n]) is insufficient to support a general claim about [population]. What sample size would be needed to validate this? Can this be described as 'early signals' rather than 'confirmed findings'?"

**Severity:** BLOCKING if a recommendation rests on the generalisation. WARNING if it's supporting evidence.

---

## Fallacy 6 — Sunk Cost Reasoning

**Definition:** Justifying continued investment based on prior spend rather than forward-looking expected value.

**Detection pattern:** "We've already invested X, so we should continue."

**Business examples:**
- "We've spent £2M on this platform over three years. Switching now would waste that investment."
  (The £2M is gone regardless. The question is whether continued investment in this platform is the best use of future resources.)
- "We've been building this market presence for five years. We can't walk away now."
  (Prior effort is not a reason to continue — expected future return is.)

**How to flag:**
> "This reasoning references prior investment to justify continued commitment. Sunk costs are irrelevant to forward-looking decisions. Would this investment be recommended if we were starting from zero today?"

**Severity:** BLOCKING if the recommendation depends on sunk cost logic. WARNING if it's one of several factors.

---

## Fallacy 7 — Moving the Goalposts

**Definition:** Retroactively changing success criteria when original criteria aren't met.

**Detection pattern:** Failure on Metric A is reframed as success on Metric B.

**Business examples:**
- Original target: 500 new users. Actual: 180 new users. Document states: "While acquisition was below target, engagement metrics exceeded expectations, indicating product-market fit."
  (Was engagement ever a stated success criterion? This may be rationalisation.)
- "Revenue growth missed forecast, but we built significant brand awareness."
  (Was brand awareness the goal? Was it measured?)

**How to flag:**
> "What were the original success criteria for this initiative? Are those the metrics being used to evaluate it here? If different metrics are now being used, what is the rationale for the change?"

**Severity:** WARNING. Rarely BLOCKING unless the entire recommendation depends on the reframed success story.

---

## Fallacy 8 — Straw Man

**Definition:** Misrepresenting the opposing case to make the preferred option look better.

**Detection pattern:** Alternative options are characterised in their weakest form.

**Business examples:**
- "The alternative to our proposal is to do nothing and watch competitors take market share."
  (The alternative might be a more modest investment, a partnership, or a different approach entirely.)
- "Those who question this investment want us to stay stuck in the past."
  (Reasonable concerns about timing, cost, or approach are not the same as opposing all change.)

**How to flag:**
> "The alternatives are characterised in their weakest form. What would a fair representation of the strongest case against the recommendation look like? Does the document address that case?"

**Severity:** BLOCKING if a viable alternative is misrepresented. WARNING if it's a rhetorical flourish rather than a structural argument.

---

## Fallacy 9 — Anchoring

**Definition:** Over-relying on the first number or framing introduced, without sufficient critical evaluation.

**Detection pattern:** A prior estimate or external figure is used as a baseline without justification.

**Business examples:**
- "The previous consultant valued the acquisition at £50M. We believe a range of £45-55M is appropriate."
  (Is the prior valuation reliable? What methodology was used? Why is it the right anchor?)
- "Industry benchmark is 3x revenue. We're trading at 2.8x, so we're undervalued."
  (Is the industry benchmark the right comparison? Does it account for differences in growth rate, margin, or risk profile?)

**How to flag:**
> "This analysis uses [anchor] as a reference point. Is this anchor justified? What is the basis for the prior figure? Have alternative benchmarks or valuation approaches been considered?"

**Severity:** WARNING in most cases.

---

## Fallacy 10 — Composition/Division Fallacy

**Definition:** Assuming properties of parts transfer to the whole (composition), or vice versa (division).

**Detection pattern:** "Each X has property Y, therefore the whole has property Y." Or: "The whole has property Y, therefore each X has property Y."

**Business examples:**
- "Each team member is a high performer. Therefore, this team will deliver high performance."
  (Teams have emergent properties — coordination, communication, conflict — not present in individuals.)
- "The market is growing at 20%. Our revenue should therefore grow at 20%."
  (Market growth rate does not determine individual company growth rate.)

**How to flag:**
> "This argument assumes properties of [individual parts] transfer directly to [the whole system]. What emergent factors — coordination, competition, structure — could cause the whole to behave differently from its parts?"

**Severity:** WARNING. Become BLOCKING if the flawed aggregation drives a quantitative forecast used in the recommendation.
