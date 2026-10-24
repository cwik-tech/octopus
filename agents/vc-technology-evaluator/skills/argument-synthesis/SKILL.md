---
name: argument-synthesis
description: >
  Protocols for constructing, challenging, and reconciling investment positions in committee
  deliberations. Adapted for venture capital evaluation. Core skill for all VC board agents.
---

# Argument Synthesis

## Argument Construction Protocol

Build an investment position in this sequence:

1. **Claim**: State your position in one declarative sentence. "This deal is / is not worth pursuing because [X]." Avoid hedging.
2. **Evidence**: List 2–4 concrete, verifiable data points that support the claim. Traction data, financial metrics, market evidence, founder track record, competitive positioning — not pitch deck assertions.
3. **Reasoning**: Explain *how* the evidence supports the claim. Name the causal mechanism or logical bridge. "Retention at 85% after 12 months suggests strong product-market fit because customers who survive the first year in this category rarely churn."
4. **Implications**: What follows if this claim is true? What does it mean for the investment decision, the return profile, or the risk register?

Example: "We should invest at this valuation because the unit economics support a $500M+ outcome within our fund timeline. Month-6 cohort retention is 82%, LTV/CAC is 4.2x, and net revenue retention is 135% [evidence]. These metrics exceed Series A benchmarks by 2x, suggesting the product has crossed the product-market fit threshold and is entering scalable growth [reasoning]. If these trends hold through 3x revenue growth, the company reaches Series B metrics within 14 months, creating a clear path to markup [implications]."

See `templates/position-statement.md` for structured output format.

## Challenge Protocol

Before attacking a position, identify its actual strengths and weaknesses:

1. **Steel-man first**: Restate the opposing argument in its strongest, most charitable form. Add premises they didn't mention but clearly rely on. If the Founder Assessor says the team is strong, acknowledge specifically what makes them strong before challenging.
2. **Locate the weak points**: Does the argument have logical gaps, unsupported leaps, missing evidence, or selection bias? Name them specifically. "The revenue growth is impressive, but it's driven by 3 enterprise contracts — that's customer concentration, not scalable growth."
3. **Test assumptions**: What must be true for this argument to hold? Are those assumptions stated and reasonable? "This valuation assumes 3x revenue growth next year — what evidence supports that specific growth rate?"
4. **Check for bias**: See `references/cognitive-biases.md` for 12 common VC-specific patterns. Is this argument showing FOMO (Fear of Missing Out), social proof bias, or narrative fallacy?
5. **Propose the rebuttal**: Challenge the evidence, the causal reasoning, or the underlying assumption — not the agent.

## Reconciliation Protocol

When two positions conflict on an investment decision, don't compromise — synthesize:

1. **Name the tension**: "The tension is between strong founder signals (Founder Assessor) and weak unit economics (Financial Modeler)."
2. **Identify what each side sees clearly**: The Founder Assessor sees a team that's navigated a hard pivot successfully. The Financial Modeler sees a burn rate that reaches zero runway in 8 months at current trajectory. Both observations are real.
3. **Find the hidden third option**: Can you reframe so both signals inform the decision? "What if we invest but structure the terms with milestone-based tranching tied to unit economics improvements?"
4. **Test the synthesis**: Does it resolve both concerns or just defer the choice? A true synthesis strengthens the investment thesis by incorporating both risk and opportunity.

## Evidence Standards

**Strong evidence in VC:**

- Quantitative traction data with 6+ months of history (retention curves, cohort analysis, revenue growth)
- Audited or verified financials (not founder projections)
- Customer interviews or NPS data from independent sources
- Comparable transaction data from verified databases (PitchBook, Crunchbase, CB Insights)
- Domain-specific metrics that match or exceed stage benchmarks
- Backchannel references from people who've worked with the founders

**Weak evidence in VC:**

- Pitch deck projections without supporting data ("we'll be at $10M ARR in 18 months")
- TAM figures from consulting reports without bottom-up validation
- Single customer testimonials presented as market validation
- "The market is huge" without specific sizing
- Founder self-reported metrics without third-party verification
- Analogies to successful companies ("we're the Uber of X")
- Investor social proof ("Sequoia is looking at this") without independent analysis

## Tension Identification

Name productive disagreements this way: "The tension between [position A] and [position B] is whether [the underlying investment question]."

Examples:

- "The tension is whether the founder's domain expertise compensates for the lack of proven unit economics."
- "The tension is whether the technology moat is deep enough to survive a well-funded competitor entering in 12 months."
- "The tension is whether the current 40% month-over-month growth is sustainable or a consequence of a one-time market event."

## Concession Signals

Update your position when:

- New traction data contradicts a key assumption in your thesis
- A counter-argument exposes a logical gap you can't close with available evidence
- The opposing agent's analysis reveals data you didn't have access to
- Your position depends on an assumption another agent has disproven

Hold firm when:

- The counter-argument relies on pitch deck claims rather than verified data
- New information is anecdotal rather than systematic
- Conceding would require ignoring quantitative evidence in favor of narrative

Signal updates clearly: "The traction data shifts my concern about market timing. I'm now conditionally bullish, contingent on the next quarter confirming the retention trend."

## Red Team Protocol

When a deal needs adversarial stress-testing beyond the Challenge Protocol:

1. **Assign the adversary role.** Shift from balanced analysis to active attack. Your job: find the path to zero.
2. **Attack from six angles:** Market risk, execution risk, financial risk, timing risk, competitive risk, and black swan risk. See `references/red-teaming.md` for the full attack framework.
3. **Document vulnerabilities** with attack vector, severity (fund-threatening / deal-threatening / manageable), probability, and mitigation.
4. **Rank by severity x probability.** Present the top 3 critical findings.
5. **Frame constructively:** "This investment succeeds if [assumption]. Here's how to protect against [assumption] failing — and here's what we lose if it does."

## Pre-Mortem Protocol

After developing a positive investment thesis, run a pre-mortem:

1. **Set the frame:** "It's 5 years from now. We wrote this investment down to zero. What happened?"
2. **Generate failure narratives** independently — each agent writes their own failure story.
3. **Categorize by type:** Market collapse, execution failure, competitive displacement, regulatory change, team implosion, capital starvation, technology obsolescence.
4. **Find convergence:** Multiple agents predicting the same failure mode = high-confidence risk.
5. **Convert to deal terms:** Can we structure protections? Milestone tranches? Board provisions? Information rights that give us early warning?

See `references/red-teaming.md` for the full protocol.

## References & Templates

- `references/argumentation-frameworks.md` — Toulmin model, dialectical reasoning, Pyramid Principle for investment arguments
- `references/cognitive-biases.md` — 12 VC-specific biases with detection and counters
- `references/red-teaming.md` — Red team attack framework and pre-mortem protocol for deals
- `templates/position-statement.md` — Structured format for investment position statements
