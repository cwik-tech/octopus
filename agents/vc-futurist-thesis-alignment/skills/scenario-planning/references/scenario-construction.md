# Scenario Construction Method

## Purpose

Step-by-step methodology for constructing the 2x2 scenario matrix, writing scenario narratives, and stress-testing investment theses against multiple futures.

---

## The 2x2 Matrix Method

### Step 1 — Select Two Critical Uncertainties

From the PESTEL scan and driving forces analysis, select the two forces that are:
1. **Most impactful** on the investment thesis (if this changes, everything changes)
2. **Most uncertain** (we genuinely don't know which way it will go)

**Common uncertainty pairs for VC:**

| Pair | Axis 1 | Axis 2 | Best For |
|---|---|---|---|
| **Tech + Regulation** | Technology adoption speed (fast ↔ slow) | Regulatory stringency (light ↔ heavy) | Healthtech, fintech, AI companies |
| **Market + Competition** | Market growth rate (high ↔ low) | Competitive intensity (fragmented ↔ consolidated) | SaaS, marketplace companies |
| **Capital + Demand** | Capital market environment (frothy ↔ tight) | Customer spending willingness (expansive ↔ contracting) | Growth-stage companies, consumer |
| **AI + Incumbents** | AI capability trajectory (breakthrough ↔ plateau) | Incumbent response speed (fast ↔ slow) | AI-native companies |
| **Macro + Micro** | Economic environment (growth ↔ recession) | Sector-specific trend (accelerating ↔ reversing) | Cross-sector analysis |

### Step 2 — Construct Four Scenarios

Plot the two axes to create four quadrants. Each quadrant is a distinct future world.

```
                    Axis 1: High
                        |
            Scenario B  |  Scenario A
            (High/Low)  |  (High/High)
                        |
  Axis 2: Low ──────────┼────────── Axis 2: High
                        |
            Scenario D  |  Scenario C
            (Low/Low)   |  (Low/High)
                        |
                    Axis 1: Low
```

**Naming:** Give each scenario a memorable name that captures its essence.

### Step 3 — Write Scenario Narratives

For each scenario, write a 150-300 word narrative covering:

1. **The world in this scenario:** What does the competitive landscape look like? What are customers doing? What has changed from today?
2. **How we got here:** What events or trends led to this world? (Makes the scenario feel plausible.)
3. **Implications for the investment:** What happens to this specific company in this world? Does it thrive, survive, struggle, or fail?

**Critical rule:** All four scenarios must be plausible. If one scenario is "everything goes right" and another is "asteroid hits," the exercise fails. Each scenario should be a world that a reasonable person could argue is likely.

---

## Worked Example — AI SaaS Company

### Uncertainty Axes
- **Axis 1:** AI capability trajectory (breakthrough → capabilities far exceed current levels vs. plateau → current capabilities are roughly the ceiling)
- **Axis 2:** Enterprise AI adoption speed (fast → enterprises adopt AI tooling aggressively vs. slow → enterprises are cautious, regulatory concerns slow adoption)

### Four Scenarios

**Scenario A — "The AI Gold Rush" (Breakthrough + Fast Adoption)**
AI capabilities surge past expectations. GPT-6 level models are commodity. Enterprises rush to adopt AI across every function. The company thrives because demand is massive, but competition intensifies — every SaaS company adds AI features. The company's edge depends on domain-specific data and workflows, not AI capability itself. Winner-take-most dynamics in each vertical.

**Scenario B — "The Capability Ceiling" (Breakthrough + Slow Adoption)**
AI capabilities are impressive but enterprises are cautious. Regulatory concerns, data privacy fears, and organizational inertia slow adoption. The company has a great product but struggles with long sales cycles and small initial contracts. Survival depends on capital efficiency and patience. Companies with enterprise sales DNA outperform those with product-led growth approaches.

**Scenario C — "The Steady March" (Plateau + Fast Adoption)**
AI capabilities plateau at roughly current levels but enterprises adopt enthusiastically because the current level is "good enough" for most use cases. The company does well because the market is growing and there's no paradigm shift that obsoletes their approach. Competition is manageable because switching costs protect installed base. Execution and distribution matter more than technology.

**Scenario D — "The AI Winter" (Plateau + Slow Adoption)**
AI capabilities disappoint and enterprises pull back on AI budgets. The company struggles with declining demand and shrinking TAM (Total Addressable Market). Survival requires pivoting to non-AI value proposition or dramatically reducing burn. Many AI-native companies fail. Winners are those with real product value beyond the AI wrapper.

### Thesis Stress-Test

| Scenario | Company Outcome | Return Potential |
|---|---|---|
| A — AI Gold Rush | Thrives (but needs competitive moat) | High — fund returner potential |
| B — Capability Ceiling | Survives (needs patience) | Moderate — 2-3x return |
| C — Steady March | Thrives (execution matters most) | High — fund returner potential |
| D — AI Winter | Struggles (must have non-AI value) | Low — 0.5-1x return |

**Verdict:** Thesis is robust across 3 of 4 scenarios. Key risk is Scenario D — mitigate by ensuring the product has value beyond AI, and by structuring terms with milestone tranches.

---

## Early Warning Signal Design

For each scenario, define 2-3 observable signals:

| Scenario | Signal | Data Source | Check Frequency |
|---|---|---|---|
| A — Gold Rush | Enterprise AI spending grows >40% YoY | Gartner, IDC reports | Quarterly |
| A — Gold Rush | New AI model releases with step-function capability improvement | Model provider announcements | Ongoing |
| B — Ceiling | AI regulation passed in EU or US | Legislative tracking | Monthly |
| B — Ceiling | Enterprise AI pilot → production conversion rate <20% | Industry surveys | Quarterly |
| C — Steady | AI benchmark improvements plateau | ML research papers | Quarterly |
| C — Steady | Enterprise AI budgets grow steadily 15-25% | CFO surveys | Quarterly |
| D — Winter | Major AI project failures reported in press | Media monitoring | Ongoing |
| D — Winter | AI startup funding declines >30% YoY | PitchBook data | Quarterly |

---

## Integration with Investment Decision

The scenario exercise should produce three outputs:

1. **Robustness score:** How many scenarios does the thesis survive? (3-4 = robust, 2 = fragile, 1 = speculative)
2. **Hedging recommendations:** What deal terms or portfolio strategies protect against adverse scenarios?
3. **Monitoring plan:** What signals will we track to determine which scenario is unfolding?
