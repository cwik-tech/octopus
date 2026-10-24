# Red Teaming and Pre-Mortem Analysis

## Red Team Protocol

Red teaming goes beyond the Challenge Protocol. Instead of testing individual arguments, a red team actively tries to **break** a proposed solution, strategy, or plan by finding failure modes the proposers didn't consider.

### Red Team Execution Steps

1. **Assume the adversary role.** Your job is to make the proposal fail — not to be balanced, not to be fair. Find the weakness.
2. **Attack from multiple angles:**
   - **Market attack:** What competitor move would neutralize this strategy?
   - **Execution attack:** What operational failure would derail implementation?
   - **Assumption attack:** Which assumptions are load-bearing? What happens if the most confident assumption is wrong?
   - **Timing attack:** What happens if this takes 2x longer or costs 2x more?
   - **Political attack:** Which stakeholder could block this, and what would motivate them to do so?
   - **Black swan attack:** What low-probability, high-impact event would invalidate the entire approach?
3. **Document each vulnerability** with:
   - The attack vector (what goes wrong)
   - The severity (minor setback / major derailment / catastrophic failure)
   - The probability (likely / possible / unlikely but devastating)
   - The mitigation (what would reduce or eliminate this risk)
4. **Rank vulnerabilities** by severity × probability. The top 3 are your critical findings.
5. **Present findings constructively.** Red teaming isn't about destroying the proposal — it's about strengthening it. Frame findings as: "This plan succeeds if [assumption]. Here's how to protect against [assumption] failing."

### Red Team Anti-Patterns

- **Performative criticism:** Finding trivial flaws to appear rigorous while missing structural risks.
- **Scope inflation:** "What if everything goes wrong simultaneously?" is not useful. Test specific, plausible failure modes.
- **Anchoring to one attack:** Don't fixate on the first vulnerability found. Systematically cover all angles.
- **Confusing pessimism with rigor:** The goal is to find real risks, not to argue that nothing works.

---

## Pre-Mortem Protocol

A pre-mortem is a structured imagination exercise: assume the project has already failed, then work backward to identify why.

### Pre-Mortem Execution Steps

1. **Set the frame.** "It's 12 months from now. We implemented this plan. It failed. The outcome is significantly worse than expected."
2. **Generate failure stories independently.** Each participant (or reasoning thread) writes a brief narrative: What went wrong? Why? What was the first sign of trouble we ignored?
3. **Categorize failures** by type:
   - **Strategy failures:** Wrong market, wrong timing, wrong positioning
   - **Execution failures:** Team gaps, resource shortfalls, coordination breakdowns
   - **External failures:** Market shift, regulatory change, competitor move, economic downturn
   - **Internal failures:** Political resistance, loss of champion, priority shift, budget cut
   - **Assumption failures:** A key belief turned out to be wrong
4. **Identify convergence.** If multiple failure stories point to the same cause, that's a high-confidence risk.
5. **Convert to preventive actions.** For each top failure mode:
   - What early warning signal would we see?
   - What action now would reduce the probability?
   - What contingency plan handles it if it happens anyway?

### When to Use Each

| Situation | Use Red Team | Use Pre-Mortem |
|---|---|---|
| Evaluating a specific proposal or strategy | ✓ | |
| Before committing to a major decision | ✓ | ✓ |
| After initial planning, before execution | | ✓ |
| When the team is overconfident | ✓ | ✓ |
| When stakeholders disagree on risks | ✓ | |
| When the team agrees too quickly (groupthink risk) | | ✓ |

### For AI Agents

- **Red team your own recommendations.** Before presenting a final position, spend one reasoning pass actively trying to break it. If you can't break it, your confidence should increase. If you can, address the vulnerability before presenting.
- **Pre-mortem before orchestration.** Before dispatching sub-agents on a plan, run a pre-mortem on the plan itself. Identify which sub-tasks are most likely to fail and build contingencies.
- **Combine with Argument Synthesis.** After the Challenge Protocol tests individual arguments, use red teaming to test the overall strategy. After the Reconciliation Protocol produces a synthesis, use pre-mortem to stress-test it.
