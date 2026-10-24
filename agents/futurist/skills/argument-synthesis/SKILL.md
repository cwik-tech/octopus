---
name: argument-synthesis
description: Protocols for constructing, challenging, and reconciling positions in strategic deliberations. Core skill for all consulting agents. Use when combining competing viewpoints into a supported conclusion.
---

# Argument Synthesis

## Argument Construction Protocol

Build a position in this sequence:

1. **Claim**: State your position in one declarative sentence. Avoid hedging.
2. **Evidence**: List 2–4 concrete, verifiable facts or data points that support the claim.
3. **Reasoning**: Explain *how* the evidence supports the claim. Name the causal mechanism or logical bridge.
4. **Implications**: What follows if this claim is true? What changes? (Surfaces stakes and decisions downstream.)

Example: "We should divest from this market because [claim]. The sales decline is 12% YoY, churn accelerated to 18%, and unit economics have turned negative [evidence]. This pattern signals structural misalignment between product and customer needs—not cyclical demand [reasoning]. If we don't exit, we'll spend 2 years and $5M trying to fix something fundamentally broken [implications]."

See `templates/position-statement.md` for structured output format.

## Challenge Protocol

Before attacking a position, identify its actual strengths and weaknesses:

1. **Steel-man first**: Restate the opposing argument in its strongest, most charitable form. Add premises they didn't mention but clearly rely on.
2. **Locate the weak points**: Does the argument have logical gaps, unsupported leaps, missing evidence, or selection bias? Name them specifically.
3. **Test assumptions**: What must be true for this argument to hold? Are those assumptions clearly stated and reasonable?
4. **Check for bias**: See `references/cognitive-biases.md` for 10 common patterns. Does this argument show signs of anchoring, confirmation bias, or availability heuristic?
5. **Propose the rebuttal**: If you disagree, either challenge the evidence, the causal reasoning, or the underlying assumption—not the person.

## Reconciliation Protocol

When two positions conflict, don't compromise (split the difference). Synthesize:

1. **Name the tension**: "The tension is between X (fast scaling captures market share) and Y (slow scaling preserves unit economics)."
2. **Identify what each side sees clearly**: Side A sees risk of competitor capture. Side B sees risk of cash depletion. Both are real.
3. **Find the hidden third option**: Can you reframe the problem so both goals align? (E.g., "What if we scale fast in high-margin segments while building profitability in core?")
4. **Test the synthesis**: Does it resolve both concerns or just defer the choice? A true synthesis strengthens both positions.

## Evidence Standards

**Strong evidence** in consulting:
- Recent quantitative data (within 6 months unless trend is multi-year)
- Direct observation or primary source, not secondhand interpretation
- Explicitly bounded (e.g., "in this segment" not "always")
- Tested against reasonable alternative explanations

**Weak evidence**:
- Anecdotes, single examples, or outlier cases presented as patterns
- Data older than 12 months without trend context
- Absence of evidence ("We haven't seen X") misrepresented as evidence of absence
- Expert opinion without reasoning—replace with first principles

## Tension Identification

Name productive disagreements this way: "The tension between [position A] and [position B] is whether [the underlying question]."

Examples:
- "The tension is whether speed of market entry outweighs risk of unrefined product."
- "The tension is whether past success in similar pivots means this pivot will succeed, or whether each market is unique."

This framing prevents it becoming personal and keeps focus on the trade-off.

## Concession Signals

Update your position when:
- New evidence contradicts a key assumption you didn't know was testable
- A counter-argument exposes a logical gap you can't close
- The opposing side steelman'd your position and it still holds, but reveals nuance you'd missed

Hold firm when:
- The counter-argument relies on unsupported assumptions
- New evidence is weaker than the foundation of your position
- Conceding would require abandoning reasoning you still believe is sound

Signal updates clearly: "I didn't account for [X]. This shifts my confidence from 80% to 60% on [specific claim]."

## Red Team Protocol

When a position or plan needs stress-testing beyond the Challenge Protocol, escalate to red teaming. The Challenge Protocol tests individual arguments; red teaming tests the **overall strategy or plan** for failure modes.

1. **Assign the adversary role.** Explicitly shift from balanced analysis to active attack. Your job: make the plan fail.
2. **Attack from six angles:** Market, execution, assumptions, timing, political, and black swan. See `references/red-teaming.md` for the full attack framework.
3. **Document vulnerabilities** with attack vector, severity, probability, and mitigation.
4. **Rank by severity × probability.** Present the top 3 critical findings.
5. **Frame constructively:** "This plan succeeds if [assumption]. Here's how to protect against [assumption] failing."

Use red teaming when: evaluating a specific proposal, when the team is overconfident, or when stakeholders disagree on risks.

## Pre-Mortem Protocol

After developing a plan but before committing to execution, run a pre-mortem: assume the plan has already failed and work backward.

1. **Set the frame:** "It's 12 months from now. This plan failed. What went wrong?"
2. **Generate failure narratives** independently — don't anchor on one person's story.
3. **Categorize by type:** Strategy, execution, external, internal, assumption failures.
4. **Find convergence:** Multiple failure stories pointing to the same cause = high-confidence risk.
5. **Convert to preventive actions:** Early warning signals, probability-reducing actions, contingency plans.

See `references/red-teaming.md` for the full protocol including when to use red teaming vs. pre-mortem.

## References & Templates

- `references/argumentation-frameworks.md` — Toulmin model, dialectical reasoning, Pyramid Principle
- `references/cognitive-biases.md` — Detection and counters for 10 biases
- `references/red-teaming.md` — Red team attack framework and pre-mortem protocol
- `templates/position-statement.md` — Structured format for stating positions
