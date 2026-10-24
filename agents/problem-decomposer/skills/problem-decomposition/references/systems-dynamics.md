# Systems Dynamics: Detecting Feedback Effects in Decomposition

**When to use:** When decomposing social, organizational, or environmental problems where actions trigger delayed feedback loops. Use as a secondary lens to identify where decomposition ignores dynamic effects and time delays that can undermine static solutions.

**Why this works with decomposition:** Decomposition excels at breaking problems into components and causal chains. Systems dynamics reveals that **components aren't independent**—they feed back on themselves through delays, creating unintended consequences. A decomposed plan may ignore these cycles and fail.

## Core Systems Dynamics Concepts

### Stocks and Flows
**Stock:** The accumulation of something (inventory, frustration, trust, debt).
**Flow:** The rate at which stock increases or decreases.

**Apply to decomposition:**
- Identify stocks in your problem: What accumulates? (customer satisfaction, technical debt, skill gaps, resentment.)
- Map flows: How fast does this stock change? Are flows being addressed by your decomposition?
- Risk: Decompositions often ignore flows. You optimize structure but forget that stocks change over time and reach tipping points.
- Example: Problem is "reduce customer complaints." Your decomposition adds support staff. But if complaint backlog (stock) builds faster than new staff can process (flow), staff hires lag reality.

### Feedback Loops: Reinforcing and Balancing
**Reinforcing Loop (R):** Output feeds back to amplify input. Exponential growth or collapse.
- Example: More customers → More revenue → More marketing spend → Even more customers.
- Risk: Decomposition misses that success compounds; over-optimizing one component triggers explosive growth elsewhere.

**Balancing Loop (B):** Output feeds back to dampen input. Stabilizes toward a goal.
- Example: Inventory low → Order more → Inventory rises → Order less → Inventory stabilizes.
- Risk: Decomposition treats a balancing loop as a chain; you push harder, but the loop resists.

**Apply to decomposition:**
- Sketch feedback loops around your components: "Does this action trigger feedback that reinforces or undermines itself?"
- Identify mixed loops: "Our hiring plan (reinforcing) meets burnout effects (balancing). Which dominates?"

### Delays
**Concept:** Time gap between action and effect. Delays weaken feedback, causing overshoot and collapse.

**Apply to decomposition:**
- Where are delays hiding? Training effectiveness appears 6 months later. Policy changes take quarters. Customer churn from poor service surfaces after months.
- Risk: Decomposition assumes immediate cause-and-effect. "We fixed X, so problem solved." But delays mean the problem worsens before improving.
- Mitigation: Identify delays explicitly; adjust timelines and monitoring to account for lag.

### Common System Archetypes (Besieged Behaviors)

#### Fixes That Fail
**Pattern:** A quick fix solves the symptom, but the underlying cause strengthens, requiring bigger interventions.

**Decomposition risk:** You decompose the problem as symptom relief. "Fix complaints with better support." But the root cause (poor product) worsens. Eventually, no support scales fast enough.

**Mitigation:** In your decomposition, separate symptom relief from root cause; ensure both are addressed. Else the system will bite back.

#### Shifting the Burden
**Pattern:** Problem solved by moving it elsewhere, creating new dependency.

**Decomposition risk:** You solve your component by externalizing work. "Support team handles edge cases instead of engineering fixing them." This shifts burden to support (who becomes overwhelmed) or customer (who waits longer).

**Mitigation:** In decomposition, check: Is any component solving its part by burdening another? If yes, your plan is fragile.

#### Limits to Growth
**Pattern:** Growth accelerates until a resource constraint or quality decline slows it. The system hits a ceiling.

**Decomposition risk:** You decompose assuming resources (people, budget, infrastructure) scale linearly. "Hire more → Serve more." But hiring has onboarding delays; infrastructure has bottlenecks; quality degrades with speed.

**Mitigation:** Identify constraints early. Are any components hitting a limit to growth? If so, address constraints as part of decomposition, not as an afterthought.

## Implementation Flow

1. **Decompose initially.** Settle on your component structure.
2. **Identify stocks:** "What accumulates in this problem?"
3. **Map flows:** "How fast does each stock change?"
4. **Sketch loops:** "Do any components feed back into others?"
5. **Identify delays:** "Where does cause lag effect?"
6. **Recognize archetypes:** "Is this a 'fixes that fail' situation? Shifting burden? Limits to growth?"
7. **Revise decomposition:** Add components or timelines to account for dynamics you've surfaced.

## For AI Agents

When reasoning about complex problems:
- **Flag dynamic blind spots.** If decomposition breaks a problem into independent pieces, explicitly note: "This assumes no feedback loops. Risk: X might amplify/undermine Y over time."
- **Model delays.** Don't assume instant cause-and-effect. Build in observation windows: "We won't see results for 3 months; monitor for unexpected side effects in the interim."
- **Test for archetypes.** When evaluating a proposed solution, ask: "Is this a 'fix that fails'? Shifting burden? Growing into a limit?" Naming the archetype clarifies why decomposition alone may fail.
- **Propose system-level levers.** Beyond component optimization, identify high-leverage points (Meadows' concept): small changes that shift system behavior. These often lie in information flow, feedback structure, or constraint removal, not in optimizing existing pieces.

**When to invoke:** Especially for problems involving human behavior, organizational change, or resource constraints. Less critical for technical, one-time problems with no feedback loops.

**Outcome:** A revised decomposition that accounts for dynamics, delays, and system archetypes—and identifies where monitoring and adaptation are critical.
