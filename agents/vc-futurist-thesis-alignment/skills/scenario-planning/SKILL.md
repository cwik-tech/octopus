---
name: scenario-planning
description: >
  Tests whether startup investment theses survive multiple plausible futures. Constructs 2x2
  scenario matrices from critical uncertainties, stress-tests deal robustness, identifies early
  warning signals. Used primarily by the Futurist / Thesis Alignment agent.
---

# Scenario Planning Skill

Identical in protocol structure to the consulting scenario-planning skill, adapted for venture capital. The focal question is always: "Does this investment thesis hold across multiple plausible futures?"

## When to Use

- Any deal with a 5+ year investment horizon (which is most VC deals)
- Deals in sectors sensitive to macro forces (regulation, technology shifts, capital markets)
- When the investment thesis depends on a specific market evolution ("AI adoption will accelerate," "regulation will tighten")
- When the committee is implicitly assuming a single future

---

## Scenario Planning Protocol

### Step 1 — Surface the Implicit Forecasts

Every investment thesis contains hidden assumptions about the future. Name them:

- **Market assumption:** "This market will grow at 25% CAGR for the next 5 years"
- **Technology assumption:** "AI capabilities will continue improving at current rates"
- **Regulatory assumption:** "Regulation will remain light-touch in this sector"
- **Competition assumption:** "No large incumbent will enter this space"
- **Capital markets assumption:** "Follow-on funding will be available at reasonable terms"
- **Customer behavior assumption:** "Enterprise buyers will adopt this category"

### Step 2 — Identify Driving Forces

Scan PESTEL forces relevant to the investment:

- **Political:** Administration changes, trade policy, geopolitical tensions
- **Economic:** Interest rates, capital availability, recession risk, currency fluctuations
- **Social:** Workforce expectations, consumer behavior, demographic shifts
- **Technological:** Emerging tech, platform shifts, cost curve trajectories
- **Environmental:** Climate regulation, sustainability mandates, resource constraints
- **Legal:** Pending legislation, regulatory enforcement, IP law changes

### Step 3 — Select Two Critical Uncertainties

Pick the two forces that are most impactful AND most uncertain. Plot on a 2x2 matrix to produce four scenarios.

**Common VC-relevant uncertainty pairs:**
- Technology adoption speed × Regulatory stringency
- Market growth rate × Competitive intensity
- Capital market environment × Customer spending willingness
- AI capability trajectory × Incumbent response speed

### Step 4 — Construct Scenarios and Test the Thesis

For each of the four scenarios, ask: "What happens to our investment in this world?"

Score each: Thrives / Survives / Struggles / Fails

**A robust investment thesis works across 3+ scenarios.** A fragile thesis only works in one. An anti-fragile thesis actually benefits from volatility.

### Step 5 — Early Warning Signals

For each scenario, define 2-3 observable signals that would indicate the world is moving toward that scenario. Convert scenarios into a monitoring system.

### Step 6 — Hedging and Contingency

For scenarios where the investment fails or struggles: Can we structure the deal terms to protect against this future? Board provisions, information rights, milestone tranches, or protective provisions?

---

## Integration with Fund Thesis

Beyond individual deal evaluation, test whether the fund's overall thesis is robust:
- Is our portfolio concentrated in one scenario's success?
- Do we have investments that hedge across scenarios?
- Are our highest-conviction bets in sectors that are robust or fragile?

---

## References & Templates

| File | Content |
|---|---|
| `references/futures-frameworks.md` | PESTEL scanning, Three Horizons, weak signal detection |
| `references/scenario-construction.md` | 2x2 matrix method, narrative writing, worked examples |
| `templates/scenario-set.md` | Scenario planning output template |
