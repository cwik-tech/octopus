---
name: investment-memo-synthesis
description: >
  Synthesizes all committee agent positions into a final Investment Memo with recommendation,
  risk register, and full audit trail. Used by the Deal Evaluator (orchestrator) after
  deliberation concludes.
---

# Investment Memo Synthesis Skill

This skill converts multi-agent deliberation into a single coherent investment document. The memo must be actionable (clear recommendation), auditable (every conclusion traced to an agent), and honest (tensions preserved, not papered over).

The final output must follow `teams/writing-team/templates/venture-investment-memo.md` and use the `teams/writing-team/profiles/strategic-consulting.yaml` register.

## When to Use

After all invoked committee agents have delivered their position statements and the Thesis Defounder has completed the foundation audit.

---

## Synthesis Protocol

### Step 1 — Collect and Categorize Positions

Gather all agent position statements. Categorize each position element into:

- **Bullish signals:** Evidence and reasoning that supports investment
- **Bearish signals:** Evidence and reasoning that argues against investment
- **Conditional signals:** "Invest if [condition]" — elements that could be bullish or bearish depending on resolution
- **Unresolved questions:** Information gaps that no agent could fill with available data

**Rule:** Every signal must be attributed to the specific agent that produced it. Anonymous signals weaken the memo.

### Step 2 — Map Consensus and Tension

**Consensus points:** Where 3+ agents independently reached the same conclusion. Consensus on bullish points strengthens the thesis. Consensus on bearish points is a warning signal.

**Productive tensions:** Where agents disagree and both sides have evidence. Name the tension: "[Agent A] sees X because [evidence]. [Agent B] sees Y because [evidence]. The underlying question is [Z]."

**Silent zones:** Dimensions where no agent had a strong view. These are often the most dangerous — they indicate blind spots or insufficient data.

### Step 3 — Weight by Stage and Sector

Not all agent positions carry equal weight for every deal. The deal classification determines emphasis:

| Stage | Highest Weight | Moderate Weight | Lower Weight |
|---|---|---|---|
| Pre-seed/Seed | Founder Assessor, Market Analyst | Contrarian, Pattern Matcher | Financial Modeler, Exit Strategist |
| Series A | Traction Analyst, Financial Modeler | Founder Assessor, Market Analyst | Exit Strategist |
| Series B+ | Financial Modeler, Traction Analyst | Exit Strategist, Deal Structurer | Founder Assessor |
| Growth | Financial Modeler, Exit Strategist | Deal Structurer, Portfolio Strategist | Wild Card |

**Exception:** If any agent raises a fund-threatening risk, it gets maximum weight regardless of stage.

### Step 4 — Resolve or Preserve Tensions

For each tension identified in Step 2, decide:

**Resolve** (one side has stronger evidence):
- State which position prevails and why
- Attribute the resolution to the evidence, not to the agent

**Preserve** (genuine uncertainty remains):
- State both positions fairly
- Identify what data would resolve the tension
- If possible, convert to a deal condition ("invest conditional on resolving [tension]")

**Never:** Paper over tension. If the Contrarian and Market Analyst disagree on market size, don't average their estimates. State both and explain the gap.

### Step 5 — Draft Recommendation

**Invest:** Bullish signals outweigh bearish, no fund-threatening risks, tensions resolvable.

**Pass:** Bearish signals dominate, or a single fund-threatening risk that can't be mitigated through deal terms.

**Conditional:** Bullish thesis contingent on resolving specific conditions. Each condition must be: specific, time-bounded, verifiable, and tied to a deal term or diligence step.

**Conviction level:**
- **High:** Strong consensus among agents, evidence-based thesis, risks are well-understood and mitigable
- **Medium:** Thesis is sound but depends on 1-2 unresolved questions or agent tensions
- **Low:** Significant disagreement among agents, data gaps, or the thesis depends on assumptions that haven't been tested

### Step 6 — Build Risk Register

Top 3-5 risks, each documented as:

| Field | Content |
|---|---|
| Risk | One-sentence description |
| Source agent | Which agent identified this |
| Severity | Fund-threatening / Deal-threatening / Manageable |
| Likelihood | High / Medium / Low |
| Mitigation | Deal term, board action, or monitoring trigger |
| Early warning | What signal would tell us this risk is materializing? |

### Step 7 — Attribution Map

For each major conclusion in the memo, cite the agent whose analysis produced it:

- "The market opportunity is validated (Market Analyst) but the timing may be early (Futurist)."
- "The team is strong on product but lacks go-to-market experience (Founder Assessor), which the Value-Add Strategist believes we can supplement through our network."

This creates accountability and allows the committee to challenge specific reasoning chains.

---

## Evidence Weighting Hierarchy

When conflicting evidence exists, weight in this order:

1. **Verified quantitative traction data** (audited financials, cohort data, third-party analytics)
2. **Independent market data** (analyst reports, government statistics, trade data)
3. **Backchannel references** (people who worked with founders, not the founder's suggested references)
4. **Founder-provided metrics** (with verification where possible)
5. **Structural analysis** (Pattern Matcher's isomorphisms, Futurist's scenarios)
6. **Market size estimates** (inherently uncertain, wide confidence intervals)
7. **Founder-provided projections** (treat as aspirational, not evidentiary)
8. **Pitch deck narrative** (lowest weight — treat as marketing, not evidence)

---

## Memo Quality Checklist

Before finalizing, verify:

- [ ] Recommendation is clear (Invest / Pass / Conditional) with conviction level
- [ ] Every major conclusion is attributed to a specific agent
- [ ] All agent tensions are either resolved with reasoning or preserved as open questions
- [ ] Risk register has 3-5 entries with severity, likelihood, and mitigation
- [ ] If conditional, each condition is specific, time-bounded, and verifiable
- [ ] The bear case is stated as strongly as the bull case (no intellectual dishonesty)
- [ ] Return math is explicit: what exit is needed to meet fund return targets?
- [ ] The memo can be read in 5 minutes and the recommendation understood in 30 seconds
- [ ] The memo fits within 5 pages; target 1,800-2,500 words
- [ ] Missing mandatory facts are shown as `Information not provided`

---

## References & Templates

| File | Content | When to read |
|---|---|---|
| `references/memo-standards.md` | What makes a great investment memo | Before drafting |
| `references/evidence-weighting.md` | Detailed evidence hierarchy and Bayesian updating | During Step 3 |
| `teams/writing-team/templates/venture-investment-memo.md` | Canonical full investment memo template | Final output |
| `templates/deal-summary.md` | One-page deal summary | Quick reference |
