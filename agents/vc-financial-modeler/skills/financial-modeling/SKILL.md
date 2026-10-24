---
name: financial-modeling
description: >
  Evaluates startup financials for venture investment. Covers unit economics decomposition,
  valuation analysis (DCF, comparables, venture method), burn rate assessment, return math,
  and dilution modeling. Used primarily by the Financial Modeler agent.
---

# Financial Modeling Skill

## When to Use

On every deal with revenue or financial projections. Mandatory from Series A onward. At Seed, focus on unit economics and burn rate. At Pre-seed, focus on capital efficiency assumptions.

---

## Financial Evaluation Protocol

### Step 1 — Unit Economics Decomposition

The foundation of every financial assessment. If unit economics don't work, nothing else matters.

**SaaS unit economics:**

| Metric | Formula | Healthy Benchmark |
|---|---|---|
| CAC (Customer Acquisition Cost) | Total sales & marketing spend / New customers acquired | Varies by segment (SMB: $500-$5K, Mid-market: $5K-$50K, Enterprise: $50K-$500K) |
| LTV (Lifetime Value) | ARPU (Average Revenue Per User) × Gross margin × (1 / Churn rate) | LTV/CAC > 3x (good), > 5x (strong) |
| CAC Payback Period | CAC / (ARPU × Gross margin) | <18 months (good), <12 months (strong) |
| Gross Margin | (Revenue - COGS (Cost of Goods Sold)) / Revenue | >70% (SaaS target), >60% (acceptable) |
| Net Revenue Retention | (Starting MRR + Expansion - Contraction - Churn) / Starting MRR | >110% (good), >130% (exceptional) |
| Burn Multiple | Net burn / Net new ARR | <2x (efficient), <1.5x (capital-efficient) |

**Marketplace unit economics:**

| Metric | Formula | Healthy Benchmark |
|---|---|---|
| Take Rate | Net revenue / GMV | 10-30% depending on category |
| Contribution margin per transaction | Revenue per transaction - variable costs | Positive and improving |
| Supply acquisition cost | Cost to onboard one supply-side participant | Must payback within first few transactions |
| Demand acquisition cost | Cost to acquire one buying customer | LTV/CAC > 3x on demand side |
| Repeat rate | % of customers who transact again within 90 days | >30% (good), >50% (strong) |

**Key check:** Are unit economics *real* or *subsidized*? Discounted pricing, excessive customer success costs, or below-market employee compensation can make unit economics look better than they are.

### Step 2 — Valuation Analysis

Run at least two independent valuation methods and triangulate:

**Method 1 — Revenue Multiple Comparables:**
1. Identify 5-10 comparable companies (similar stage, sector, growth rate)
2. Source their valuation multiples (EV/Revenue) from recent rounds or public comps
3. Apply the appropriate multiple to the startup's current or projected revenue
4. Adjust for: growth rate premium/discount, margin premium/discount, market size premium

**Method 2 — Discounted Cash Flow (DCF):**
1. Project cash flows for 5-7 years based on growth assumptions
2. Apply a terminal value (typically exit multiple method)
3. Discount back at a rate reflecting venture risk (30-50% for early stage, 20-30% for growth)
4. **Warning:** DCF is highly sensitive to assumptions for startups. It's useful as a sanity check but not as a primary valuation method for pre-profit companies.

**Method 3 — Venture Capital Method:**
1. Estimate the exit value at target exit date (5-7 years)
2. Determine required return multiple for the fund (typically 10-30x for early stage, 3-5x for growth)
3. Calculate the required current valuation: Exit value / Required multiple / (1 + dilution from future rounds)
4. Compare to the founder's asking price

**Method 4 — Comparable Transaction Analysis:**
1. Identify recent funding rounds for companies at the same stage/sector/metrics
2. Map their valuation to their metrics (revenue multiple, ARR multiple, GMV multiple)
3. Apply to the target company
4. Adjust for metric quality (growth rate, retention, capital efficiency)

### Step 3 — Burn Rate and Runway Assessment

**Current state:**
- Monthly burn rate (cash out - cash in)
- Months of runway remaining
- Cash on hand before this round

**Post-investment state:**
- New monthly burn rate (will they hire? How fast?)
- Months of runway this round provides
- When will they need to raise again?

**Key questions:**
- Will they reach the milestones needed for the next raise before running out of money?
- What happens if growth is 50% slower than projected — do they still have enough runway?
- What's the minimum viable burn rate if they need to extend runway?

### Step 4 — Return Math

The most important calculation: does this deal return the fund?

**Fund return analysis:**
1. Our check size: $[X]
2. Ownership at entry: [X]%
3. Expected dilution through future rounds: [X]% (typically 40-60% cumulative through exit)
4. Ownership at exit: [X]%
5. Required exit valuation for target return: Check size × Target multiple / Ownership at exit
6. Is that exit valuation realistic given the market, comparables, and growth trajectory?

**Sensitivity analysis:** Model three scenarios:
- **Base case:** Growth continues at current rates
- **Bear case:** Growth slows 50%
- **Bull case:** Growth accelerates 50%

For each, calculate: exit valuation, our proceeds, return multiple. If the bear case doesn't return at least 1x, the risk/reward may not work.

### Step 5 — Dilution Waterfall Modeling

Model the cap table through future funding rounds:

1. Current cap table (founders, angels, seed investors, option pool)
2. This round (new investor ownership, option pool refresh)
3. Projected future rounds (Series B, C, etc.) with assumed dilution
4. Exit ownership for each stakeholder class

**Check for:** Founder dilution below motivation threshold (founders below 10% combined can lose motivation). Option pool adequacy for hiring plan. Liquidation preference stack that could eat into common shareholder returns.

---

## Financial Red Flags

- Revenue growing but cash burn growing faster (negative operating leverage)
- "Adjusted" metrics that exclude real costs (stock-based compensation, one-time costs that recur)
- Customer concentration: top 3 customers > 30% of revenue
- Accounts receivable growing faster than revenue (collecting revenue on paper, not in cash)
- Deferred revenue declining (forward pipeline shrinking)
- Gross margin deteriorating (costs growing faster than revenue)
- Burn multiple >3x (spending $3 to create $1 of new ARR)

---

## References & Templates

| File | Content |
|---|---|
| `references/valuation-methods.md` | Detailed DCF, comparables, venture method with worked examples |
| `references/unit-economics-benchmarks.md` | Stage and sector-specific benchmarks for all key metrics |
| `templates/financial-assessment.md` | Financial evaluation output template |
