---
name: unit-economics-and-pricing
description: Build bottom-up manufacturing cost models for modular interior walls, set pricing tiers by customer segment and installation complexity, and validate unit economics (LTV, CAC, payback period) at realistic scale. Use when validating that the business works financially before committing capital to production tooling or sales infrastructure.
---

# Unit Economics & Pricing Strategy

## Purpose

Prove the business is viable at realistic scale: manufacturing cost + installation labor + customer acquisition cost must yield positive unit economics with defensible margins. Build the model from cost-up, stress-test under competitive pressure, and tie pricing to customer willingness-to-pay (from TAM analysis).

## When to Use

Use this skill:
- After TAM and competitive positioning are validated
- Before committing to manufacturing capacity or sales infrastructure
- When pricing strategy must account for customer segment differences
- When you need to model breakeven and payback timelines

## Workflow

### Step 1: Build Bottom-Up Manufacturing Cost Model

**Bill of Materials (BOM) Example: Modular Interior Wall Panel (4ft × 8ft × 2in)**

| Component | Unit Cost | Qty | Total |
|-----------|-----------|-----|-------|
| Aluminum extrusion (frame) | $3/lb | 12 lbs | $36 |
| Acoustic/finish panels (18 sq ft) | $8/sq ft | 1 | $144 |
| Connectors/hardware (proprietary) | $15 | 4 | $60 |
| Casters/wheels | $8 | 4 | $32 |
| Fabric wrap/finishing | $5/sq ft | 18 sq ft | $90 |
| Packaging/protection | $12 | 1 | $12 |
| **Total BOM** | | | **$374** |

**Manufacturing Cost (per panel, 1000 units/year run):**

| Cost Category | Cost/Panel | Notes |
|---------------|-----------|-------|
| BOM | $374 | Direct materials (see above) |
| Direct labor | $45 | 0.5 hours × $90/hr (assembly) |
| Overhead (facility, equipment) | $40 | Amortized across 1000 units/year |
| Quality assurance / testing | $15 | Defect screening, durability testing |
| **Manufacturing Cost** | **$474** | |

**Price per panel: $374 BOM / 1000 = $374, plus $100 overhead/labor = $474 total cost/panel**

**Note**: BOM is 79% of manufacturing cost. Economies of scale improve at 5000+ units/year (overhead amortizes; supplier discounts on materials).

### Step 2: Model Installation Labor & Logistics

**Installation Model: Corporate 400 sq ft office reconfiguration (30 panels)**

| Cost Component | Qty | Unit Cost | Total |
|----------------|-----|-----------|-------|
| Materials (panels + connectors) | 30 | $474 | $14,220 |
| Transportation/logistics | 1 | $400 | $400 |
| Installation labor | 16 hours | $60/hr | $960 |
| Site coordination (PM labor) | 2 hours | $90/hr | $180 |
| **Total Project Cost** | | | **$15,760** |
| **Cost per sq ft** | 400 sq ft | | **$39.40/sq ft** |

**Pricing for Corporate Office:**
- Willingness-to-pay: $75,000 (from TAM analysis customer interviews)
- Competitive reference: Demountable walls at $80–120/sq ft; temporary fabric at $30–50/sq ft
- **Positioning: $50–60/sq ft** (premium to fabric, discount to demountable)
- **Revenue on 400 sq ft project: $20,000–24,000**
- **Gross Margin: ($20,000 − $15,760) / $20,000 = 21%** (low; improve with volume or faster install)

**Stress Test: What if installation takes 25% longer?**
- Labor cost increases to $1,200 (+$240)
- Project cost = $16,000
- Margin on $20,000 revenue = 20% (barely viable)
- **Action**: Requires process improvement or higher price to maintain 30%+ margin target

### Step 3: Set Pricing Tiers by Segment

**Museum Installations (typically larger, more complex)**

- Average project: 600 sq ft (45 panels)
- Complexity: Custom finishes, conservation requirements, tight install windows
- Willingness-to-pay: $100,000+ (from customer interviews)
- **Pricing: $60–80/sq ft**
- **Revenue: $36,000–48,000**
- **Cost: $22,410 materials + $600 logistics + $1,440 labor = $24,450**
- **Gross margin: (40,000 − 24,450) / 40,000 = 39%** ✓ (viable)

**Corporate Office (small-medium)**

- Average project: 400 sq ft (30 panels)
- Complexity: Standard acoustic, quick install
- Willingness-to-pay: $75,000 (from customer interviews)
- **Pricing: $50–60/sq ft**
- **Revenue: $20,000–24,000**
- **Cost: $14,220 materials + $400 logistics + $960 labor = $15,580**
- **Gross margin: (22,000 − 15,580) / 22,000 = 29%** ✓ (acceptable if volume scales)

**Hospitality (rapid reconfiguration)**

- Average project: 300 sq ft (22 panels), high frequency
- Complexity: Fast install, standard finishes, repeat customer
- Willingness-to-pay: $60,000 (from customer interviews)
- **Pricing: $50–55/sq ft**
- **Revenue: $15,000–16,500**
- **Cost: $10,428 materials + $300 logistics + $720 labor = $11,448**
- **Gross margin: (15,750 − 11,448) / 15,750 = 27%** ✓ (acceptable; improves with repeat)

**Pricing Strategy Summary:**

| Segment | Price/sq ft | Gross Margin | Notes |
|---------|------------|--------------|-------|
| Museum | $60–80 | 35–45% | Highest complexity, custom finishes |
| Corporate | $50–60 | 25–35% | High volume, standard install |
| Hospitality | $50–55 | 25–30% | Repeat customer, fast install |

### Step 4: Model Unit Economics (LTV / CAC)

**Customer Lifetime Value (LTV) — Corporate Segment**

Assuming a typical corporate customer reconfigures 1.5 times per year at $22,000 avg revenue:

- Annual revenue per customer: $22,000 × 1.5 = $33,000
- Customer lifespan (retention): 3 years (based on facility lease cycles)
- **LTV = $33,000 × 3 = $99,000**
- Less gross cost (at 30% margin): LTV − (LTV × 0.30) = LTV contribution margin = **$69,300**

**Customer Acquisition Cost (CAC) — Corporate Segment**

Assume sales/marketing spend to acquire one corporate customer:

| Cost Component | Cost |
|---|---|
| Sales rep salary (loaded) | $140k/year; assume 2 closures/month = 24/year | ~$5,800/closure |
| Marketing (digital, events, demo materials) | $50k/year for 24 closures | ~$2,100/closure |
| Demo unit/showroom cost (amortized) | $20k/year for 24 closures | ~$833/closure |
| **CAC** | | **~$8,700** |

**LTV/CAC Ratio:**
- LTV contribution margin: $69,300
- CAC: $8,700
- **LTV/CAC = 7.96x** ✓ (target is >3x; this is strong)
- **Payback period: CAC / (monthly margin) = $8,700 / ($69,300/36 months) = 4.5 months**

**Sensitivity Analysis: What if CAC is 30% higher (e.g., sales ramp cost)?**
- CAC rises to $11,300
- LTV/CAC = 6.13x (still >3x, but tighter)
- Payback extends to 5.9 months
- **Action**: Requires margin improvement (higher price or lower cost) or higher LTV (customer retention >3 years)

**Museum Segment (lower volume, higher project value):**

- Annual revenue per customer: $40,000 (fewer reconfigures, but larger projects)
- Customer lifespan: 4 years (longer facility plans)
- **LTV = $40,000 × 4 = $160,000**
- At 40% gross margin: **LTV contribution = $96,000**
- CAC (direct outreach to curators/facilities): ~$12,000 (higher touch sales)
- **LTV/CAC = 8x** ✓ (very strong)
- **Payback period: ~3.6 months**

### Step 5: Model Breakeven & Scale

**Breakeven Analysis: When does the business achieve positive cumulative cash flow?**

**Assumptions:**
- Year 1: Ramp to 50 corporate customers + 15 museum customers
- Year 1 Revenue: (50 × $33k) + (15 × $40k) = $2.25 million
- Year 1 Gross profit (30% avg margin): $675k
- Year 1 Operating costs (sales, marketing, overhead): $800k
- **Year 1 Net: −$125k** (expected loss in ramp)

- Year 2: Ramp to 120 corporate + 30 museum customers
- Year 2 Revenue: (120 × $33k) + (30 × $40k) = $5.16 million
- Year 2 Gross profit: $1.548M
- Year 2 Operating costs: $900k (leverage on sales team)
- **Year 2 Net: +$648k** ✓ (breakeven in Q3)

- Year 3: 200 corporate + 50 museum customers
- Year 3 Revenue: $8.6M
- **Year 3 Net: $1.8M+** (scale)

**Key Drivers:**
- Gross margin must stay ≥30% (sensitive to manufacturing cost, installation labor)
- CAC must be recovered within 6 months (else cash flow dries up)
- Retention must stay >70% year-over-year (churn kills LTV)

### Step 6: Stress-Test Unit Economics

**Scenario 1: Manufacturing cost increases 15% (supplier inflation or yield loss)**
- BOM + labor + overhead: $474 → $545/panel
- Project cost (30 panels, 400 sq ft): $16,350 → $17,700
- Pricing unchanged at $50/sq ft = $20,000 revenue
- Gross margin: (20,000 − 17,700) / 20,000 = 11.5% ✗ (unsustainable)
- **Action**: Must either reduce manufacturing cost 10% or increase price 5–7%

**Scenario 2: Installation takes 50% longer than planned**
- Labor cost: $960 → $1,440
- Project cost: $15,760 → $16,300
- Margin: (20,000 − 16,300) / 20,000 = 18.5% ✗ (below target)
- **Action**: Requires process efficiency improvement or customer acceptance of longer install window (unlikely)

**Scenario 3: Competitive pressure forces 10% price reduction**
- Price: $50/sq ft → $45/sq ft
- Revenue on 400 sq ft: $20,000 → $18,000
- Margin: (18,000 − 15,760) / 18,000 = 12.4% ✗ (unsustainable)
- **Action**: Cannot compete on price alone; must differentiate (faster install, better aesthetics, durability)

**Stress-Test Conclusion**: Unit economics are viable IF:
- Manufacturing cost stays below $500/panel (±10% tolerance)
- Installation labor stays within budget (requires process discipline or customer training)
- Pricing stays above competitive floor (can't compete on price alone)
- Retention stays >70% (churn destroys LTV)

## Output

**Deliverable: Unit Economics Summary**

```
Unit Economics: Modular Interior Walls

Pricing by Segment:
- Museum: $60–80/sq ft (35–45% gross margin)
- Corporate: $50–60/sq ft (25–35% gross margin)
- Hospitality: $50–55/sq ft (25–30% gross margin)

Unit Economics (Corporate, 3-year model):
- LTV: $99,000
- CAC: $8,700
- LTV/CAC: 7.96x ✓
- Payback: 4.5 months

Unit Economics (Museum, 4-year model):
- LTV: $160,000
- CAC: $12,000
- LTV/CAC: 8x ✓
- Payback: 3.6 months

Breakeven Timeline:
- Year 1: −$125k (ramp)
- Year 2: +$648k (scale)
- Year 3+: $1.8M+ (mature)

Stress Tests (Failure Modes):
1. Manufacturing cost +15% → margin collapses to 11.5% ✗
   Action: Reduce cost or increase price 5–7%
2. Installation labor +50% → margin falls to 18.5% ✗
   Action: Process efficiency or customer acceptance required
3. Price competition −10% → margin falls to 12.4% ✗
   Action: Differentiate on value, not price

Viability Assessment: ✓ VIABLE
- Pricing is defensible relative to competitive alternatives
- Unit economics are robust (7–8x LTV/CAC)
- Breakeven achievable in Year 2 at modest ramp (150 customers)
- Primary risk: Manufacturing cost control and customer retention
```

## Red Lines

- Never model gross margins below 25%. Below that, overhead and CAC recovery become structurally fragile.
- Never accept LTV/CAC below 3x. Below that, customer acquisition consumes all profit.
- Never assume manufacturing costs will drop faster than your competitors'. Model cost reduction conservatively.
- Never project payback longer than 12 months. CAC takes too long to recover; cash flow stalls.
- Never ignore installation labor as a cost driver. It's your largest operational variable; treat it as fixed in pricing models until proven otherwise.
