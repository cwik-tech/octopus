# Stacey Matrix: Secondary Problem Classification

**When to use:** Alongside Cynefin or primary problem classification, use the Stacey Agreement-Certainty Matrix to cross-validate your understanding of problem complexity and uncertainty. Use as a supplementary tool when a problem spans multiple Cynefin domains or when you need to clarify the degree of disagreement among stakeholders.

**Why this works with decomposition:** Decomposition assumes clarity on the problem type. The Stacey Matrix offers a finer-grained view of two critical dimensions—agreement and certainty—that reveal whether decomposition is even the right approach.

## The Two Axes

### Horizontal Axis: Certainty
**Left (Low Certainty):** Cause-and-effect unclear. "We don't know if action X causes outcome Y."
- Typical: New technologies, emergent problems, novel domains, unfamiliar systems.
- Decomposition challenge: You can't reliably predict how components interact if cause-and-effect is murky.

**Right (High Certainty):** Cause-and-effect clear. "We know X causes Y."
- Typical: Routine operations, well-understood domains, stable systems.
- Decomposition advantage: Components interact predictably; you can sequence and optimize reliably.

### Vertical Axis: Agreement
**Bottom (Low Agreement):** Stakeholders disagree on goals, values, or problem definition.
- Typical: Cross-functional teams, ideological divides, competing priorities, new strategic directions.
- Decomposition risk: If stakeholders don't agree on the goal, decomposition may optimize for the wrong objective.

**Top (High Agreement):** Stakeholders align on goals and problem definition.
- Typical: Aligned teams, clear mandates, shared vision.
- Decomposition advantage: Everyone accepts the decomposed components and sequence.

## Four Zones

### Simple Zone (High Certainty, High Agreement)
**Characteristics:** Cause-effect clear. Everyone agrees. Risks and solutions are known.

**Decomposition fit:** EXCELLENT. Break the problem into well-defined steps; execute reliably.

**Example:** "Increase warehouse throughput by optimizing shelving layout."

**AI agent approach:** Standard decomposition works. Verify data, execute plan, monitor results.

---

### Complicated Zone (High Certainty, Low Agreement)
**Characteristics:** Cause-effect clear, but stakeholders disagree on which effects matter or which goals to prioritize.

**Decomposition fit:** REQUIRES STAKEHOLDER RESOLUTION FIRST. You can decompose multiple valid solutions, but without agreement, no decomposition resolves the disagreement.

**Example:** "Build a new feature or focus on technical debt?" Both paths are technically sound, but stakeholders prioritize differently.

**AI agent approach:**
- Decompose multiple competing solutions (one per stakeholder priority).
- Present tradeoffs explicitly: "Path A maximizes X but compromises Y. Path B does the opposite."
- Don't choose for stakeholders; expose the choice.

---

### Complex Zone (Low Certainty, High Agreement)
**Characteristics:** Cause-effect unclear, but stakeholders agree on the goal and are willing to experiment.

**Decomposition fit:** PARTIAL. Decompose the *exploration* rather than the solution. Break the problem into testable hypotheses.

**Example:** "Improve product adoption in a new market where we've no prior data."

**AI agent approach:**
- Decompose into parallel, small experiments: "Hypothesis 1: price sensitivity. Hypothesis 2: feature clarity. Hypothesis 3: competitor positioning."
- Each component is a mini-learning cycle, not a step toward a known solution.
- Iterate based on feedback; the decomposition adapts.

---

### Chaotic Zone (Low Certainty, Low Agreement)
**Characteristics:** Cause-effect unknown. Stakeholders disagree on problem or goal.

**Decomposition fit:** POOR. Standard decomposition will fail because the ground is shifting.

**Example:** "Respond to a market disruption where competitors' moves are unpredictable and internal teams have conflicting visions."

**AI agent approach:**
- Skip decomposition. Move to **crisis management mode:**
  - Act fast with imperfect information (make a move, learn, adapt).
  - Build consensus through shared action, not planning.
  - Focus on stabilization, not optimization.
- Once agreement or certainty improves, *then* decompose.

## How Stacey Refines Cynefin

**Cynefin** classifies by problem type (simple, complicated, complex, chaotic).

**Stacey** adds granularity: A Cynefin "complicated" problem might be high-certainty but low-agreement (Stacey complicated zone) or high-certainty and high-agreement (Stacey simple zone).

**Cross-check your decomposition:**
- Cynefin says "complex," but Stacey shows "high agreement + high certainty"? Maybe it's simpler than you thought; try stricter decomposition.
- Cynefin says "simple," but Stacey shows "low agreement"? You have a stakeholder problem, not a technical one; resolve that first.

## Implementation Flow

1. **Classify with Cynefin.** Identify the problem domain (simple/complicated/complex/chaotic).
2. **Map to Stacey Matrix.** Ask two questions:
   - **Certainty:** "Do we understand cause-and-effect? Is our theory of change sound?"
   - **Agreement:** "Do stakeholders align on goals and problem definition?"
3. **Identify your zone.** Locate yourself on the 2x2 grid.
4. **Adjust your decomposition approach:**
   - **Simple:** Decompose and execute as planned.
   - **Complicated:** Decompose multiple valid solutions; resolve stakeholder choice first.
   - **Complex:** Decompose into testable hypotheses; plan iteration.
   - **Chaotic:** Skip decomposition; stabilize first.

## For AI Agents

When reasoning about a problem:
- **Use Stacey as a gut-check.** "My decomposition assumes high certainty and high agreement. Are those assumptions valid?"
- **Identify the real bottleneck.** If decomposition won't work, ask: "Is the problem lack of certainty or lack of agreement?" They require different interventions.
  - Lack of certainty? → Run experiments; decompose into learning cycles.
  - Lack of agreement? → Facilitate dialogue; decompose competing solutions to expose tradeoffs.
- **Flag transitions.** If you're moving from chaotic to complex to complicated, your decomposition strategy should evolve too.
- **Document both dimensions.** In your reasoning output, state: "Certainty: X. Agreement: Y. Zone: Z. Decomposition approach: Q."

**Outcome:** A richer understanding of why standard decomposition works here but not there—and what adaptive strategy to deploy instead.
