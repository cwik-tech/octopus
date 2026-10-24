---
name: scenario-planning
description: >
  Structured exploration of future uncertainty. Constructs plausible scenarios using the 2×2
  uncertainty matrix method, backcasting, horizon scanning, and pre-mortem analysis to stress-test
  strategies against multiple futures rather than betting on a single forecast.
  Use when exploring plausible futures, uncertainties, and consequences.
---

# Scenario Planning Skill

This skill addresses a gap in the thinking toolkit: none of the other skills reason about the **future** in a structured way. Problem Decomposition handles the problem as it exists now. Decision Analysis evaluates options against current criteria. Scenario Planning asks: "What if the world changes? Does our strategy still hold?"

Use this skill when decisions have long time horizons, when the environment is volatile, or when stakeholders are implicitly assuming a single future.

---

## When to Use This Skill

- Strategic decisions with 2+ year time horizons
- High uncertainty about market, technology, regulation, or competitive dynamics
- Stakeholders are overconfident about a single forecast
- Need to stress-test a strategy against multiple plausible futures
- "What if?" questions that require structured rather than ad hoc answers
- Before major capital commitments, market entries, or organizational transformations

## When NOT to Use This Skill

- Tactical, short-term decisions (< 6 months)
- The future is reasonably predictable (stable markets, clear trends)
- The decision is reversible and low-cost (just try it)

---

## Scenario Planning Protocol

### Step 1: Define the Focal Question (5 minutes)

Frame the strategic question the scenarios should help answer:

- **Good focal questions:** "How should we position our product for 2028?" / "What workforce strategy should we adopt for the next 5 years?" / "Should we invest $10M in this technology platform?"
- **Bad focal questions:** "What will happen?" (too vague) / "Will AI replace jobs?" (binary, not strategic) / "What should we do tomorrow?" (too tactical)

**Time horizon:** Define the scenario window. 3-5 years is typical for business strategy. 5-10 years for infrastructure or platform decisions. Shorter than 2 years is usually not worth scenario planning.

### Step 2: Identify Driving Forces (15 minutes)

List the forces that will shape the future relevant to your focal question:

**Categories to scan:**
- **Technology:** What emerging technologies could reshape the landscape? What's the adoption trajectory?
- **Market/Economic:** Growth trends, recession risks, capital availability, consumer behavior shifts.
- **Regulatory/Political:** Pending legislation, geopolitical tensions, trade policy, industry regulation.
- **Social/Demographic:** Workforce expectations, consumer values, demographic shifts, cultural trends.
- **Competitive:** New entrants, industry consolidation, business model innovation, commoditization.
- **Environmental:** Climate impacts, resource constraints, sustainability mandates.

See `references/futures-frameworks.md` for scanning frameworks (PESTEL, STEEP).

### Step 3: Select the Two Critical Uncertainties (10 minutes)

From the driving forces, identify the **two most impactful AND most uncertain** forces:

**Criteria for selection:**
- **High impact:** If this force goes one way vs. another, it fundamentally changes the strategic landscape.
- **High uncertainty:** Reasonable people disagree on which way this force will go. If experts agree on the direction, it's a trend, not an uncertainty.
- **Independent:** The two forces should be relatively independent of each other. If they're highly correlated, they'll produce only 2 interesting scenarios instead of 4.

**Common pairings:**
- Technology adoption speed × Regulatory stringency
- Market growth rate × Competitive intensity
- Customer demand shift × Supply chain resilience
- Economic cycle × Technology disruption

### Step 4: Construct the 2×2 Scenario Matrix (15 minutes)

Place the two uncertainties on orthogonal axes. Each axis has two poles (extremes). This creates four quadrants, each representing a distinct plausible future.

```
                    [Uncertainty 1: Pole A]
                           │
         Scenario 1        │        Scenario 2
         [Name]            │        [Name]
                           │
[Uncertainty 2: ──────────────────────── [Uncertainty 2:
 Pole A]                   │              Pole B]
                           │
         Scenario 3        │        Scenario 4
         [Name]            │        [Name]
                           │
                    [Uncertainty 1: Pole B]
```

**For each scenario:**
1. **Name it.** Give each scenario a memorable, evocative name (not "Scenario A"). Names help people remember and reference scenarios.
2. **Write a narrative.** A 1-2 paragraph story of what this world looks like. Make it vivid and specific. Include: what happened, who won and lost, how daily life and business changed.
3. **Identify implications.** What does this scenario mean for the focal question? What strategy would succeed here? What would fail?
4. **Assign plausibility.** Not probability — plausibility. Is this scenario logically coherent and possible? (All four should be plausible, or you've chosen poor uncertainties.)

See `references/scenario-construction.md` for detailed guidance and worked examples.

### Step 5: Test Strategies Against Scenarios (15 minutes)

Take the proposed strategy (or 2-3 candidate strategies) and evaluate against all four scenarios:

| Strategy | Scenario 1 | Scenario 2 | Scenario 3 | Scenario 4 |
|---|---|---|---|---|
| Strategy A | [Outcome] | [Outcome] | [Outcome] | [Outcome] |
| Strategy B | [Outcome] | [Outcome] | [Outcome] | [Outcome] |

**Evaluate:**
- **Robust strategies:** Perform acceptably across all scenarios. May not be optimal in any single scenario but avoid catastrophic failure.
- **Optimal strategies:** Excel in one scenario but may fail in others. High reward, high risk.
- **Fragile strategies:** Depend on a specific scenario occurring. If that scenario doesn't materialize, the strategy fails.

**Decision rule:** Prefer robust strategies unless you have strong conviction about a specific scenario AND the cost of being wrong is manageable.

### Step 6: Identify Early Warning Signals (10 minutes)

For each scenario, define 2-3 observable signals that would indicate the world is moving toward that scenario:

- **Leading indicators:** What would we see 6-12 months before this scenario fully materializes?
- **Trigger events:** What single event would significantly increase the probability of this scenario?
- **Data sources:** Where would we monitor for these signals?

This transforms scenarios from abstract stories into an actionable monitoring system.

### Step 7: Develop Contingency Plans (10 minutes)

For scenarios where the current strategy performs poorly:

1. **Hedging actions:** What can we do now (at low cost) to reduce downside in unfavorable scenarios?
2. **Option-creating actions:** What investments preserve the ability to pivot if signals indicate an unfavorable scenario?
3. **Trigger points:** At what signal strength do we activate the contingency plan?

Use the template at `templates/scenario-set.md`.

---

## Complementary Techniques

### Backcasting

Instead of forecasting forward from today, start from a desired future state and work backward:

1. **Define the desired outcome.** "In 2030, we are the market leader in [category] with $100M revenue."
2. **Work backward.** What must be true in 2029 for this to happen? In 2028? In 2027?
3. **Identify critical milestones.** What are the must-hit intermediate goals?
4. **Surface gaps.** Where does the backward path reveal capabilities, resources, or conditions we don't currently have?

Use backcasting alongside scenario planning: backcast within the most favorable scenario, then check if the backward path is viable across other scenarios.

### Horizon Scanning

Systematic monitoring of weak signals and emerging trends:

- **Horizon 1 (0-2 years):** Current trends extending. High certainty. Focus: optimization.
- **Horizon 2 (2-5 years):** Emerging trends gaining traction. Moderate certainty. Focus: strategic positioning.
- **Horizon 3 (5-10 years):** Weak signals and wild cards. Low certainty. Focus: awareness and option-creation.

See `references/futures-frameworks.md` for detailed horizon scanning methodology.

---

## Anti-Patterns

- **Probability fixation:** Assigning probabilities to scenarios defeats the purpose. Scenarios are about plausibility and preparation, not prediction.
- **Status quo scenario:** Including "nothing changes" as a scenario. The whole point is to explore change.
- **Wishful thinking:** Making the preferred outcome a scenario. Scenarios should challenge, not confirm.
- **Too many scenarios:** More than 4 scenarios dilutes focus. The 2×2 matrix forces discipline.
- **Scenario as forecast:** Treating one scenario as "most likely" and ignoring the rest. All four should inform strategy.
- **Analysis without action:** Scenarios without strategy testing, early warnings, and contingencies are intellectual exercises, not strategic tools.

---

## Integration with Other Skills

- **Domain Research** provides the driving forces and trend data that feed into scenario construction.
- **Problem Decomposition** may route "Strategic" problems here when future uncertainty is a key factor.
- **Decision Analysis** evaluates options within a scenario; Scenario Planning evaluates strategies across scenarios.
- **Stakeholder Mapping** identifies whose interests shift under different scenarios.
- **Argument Synthesis** builds the case for robust vs. optimal strategies.

---

## Reference Index

| File | Content | When to read |
|---|---|---|
| `references/scenario-construction.md` | 2×2 matrix method, narrative writing, worked examples | Step 4 |
| `references/futures-frameworks.md` | PESTEL, STEEP, Three Horizons, horizon scanning, weak signals | Steps 2 and 6 |
| `templates/scenario-set.md` | Complete scenario planning output template | Final output |
