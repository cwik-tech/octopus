---
name: exit-analysis
description: >
  Works backward from the exit to evaluate investment viability. Maps potential acquirers, analyzes
  comparable exits, assesses IPO readiness, and models exit scenarios. Used primarily by the
  Exit Strategist agent.
---

# Exit Analysis Skill

If you can't see the exit, you can't underwrite the investment. This skill works backward from plausible exit outcomes to evaluate whether the return math works.

## When to Use

On every deal from Series A onward. At Seed, lighter-touch assessment of exit path plausibility. At Pre-seed, skip unless the exit path is core to the thesis.

---

## Exit Analysis Protocol

### Step 1 — Exit Path Classification

| Exit Type | When Likely | Typical Multiple | Timeline |
|---|---|---|---|
| **Strategic acquisition** | Company has technology, team, or market position a larger company wants | 3-10x revenue (varies widely by buyer motivation) | 3-7 years |
| **IPO** | $100M+ revenue, strong growth, public market appetite for the sector | 8-20x revenue (at time of IPO) | 5-10 years |
| **PE (Private Equity) buyout** | Profitable or near-profitable, stable growth, can support leverage | 3-8x EBITDA (Earnings Before Interest, Taxes, Depreciation, Amortization) | 4-8 years |
| **Secondary sale** | Investor liquidity without company event | At recent round valuation (±20%) | Variable |
| **Acqui-hire** | Company failed but team is valuable | $1-5M per engineer (minimal return) | 2-4 years |

**Most likely exit:** For most VC-backed companies, the most likely positive exit is strategic acquisition, not IPO. Only ~1% of VC-backed companies go public.

### Step 2 — Acquirer Mapping

For strategic acquisition path:

1. **Identify 5-10 potential acquirers** based on: strategic fit, acquisition history, balance sheet capacity, and stated growth strategy.
2. **For each acquirer, assess:**
   - Would this startup's technology/team/customers be valuable to them?
   - Have they acquired similar companies before? At what multiples?
   - Do they have the budget? (Cash on hand, market cap, M&A history)
   - What's their typical acquisition profile? (Stage, size, technology vs. market share vs. talent)
3. **Buyer motivation taxonomy:**
   - **Technology acquisition:** Buying the technology to integrate into their product. Highest multiples.
   - **Market/customer acquisition:** Buying the customer base. Moderate multiples.
   - **Talent acquisition:** Buying the team. Lowest multiples (often breakeven for investors).
   - **Competitive elimination:** Buying to remove a competitor. Variable multiples.

### Step 3 — Comparable Exit Analysis

Find 5-10 comparable exits (similar sector, stage, metrics) from the last 3-5 years:

| Data Point | Source |
|---|---|
| Exit valuation | PitchBook, Crunchbase, press releases |
| Revenue at exit | Public filings, press, or estimated from fundraising data |
| Exit multiple (EV/Revenue) | Calculated from above |
| Time from Series A to exit | PitchBook |
| Acquirer and motivation | Press coverage, strategic analysis |

**Median comparable exit multiple** becomes the baseline for modeling the current deal's exit.

### Step 4 — IPO Readiness Assessment

If IPO is the expected path, evaluate readiness:

| Criterion | Threshold | Company Status |
|---|---|---|
| Revenue | >$100M ARR | [Assess] |
| Growth rate | >30% YoY | [Assess] |
| Gross margin | >65% | [Assess] |
| Path to profitability | Visible within 2 years | [Assess] |
| Governance | Independent board, audited financials, CFO in place | [Assess] |
| Market position | #1 or #2 in defined category | [Assess] |
| Public market appetite | Comparable public companies exist, sector is not out of favor | [Assess] |

### Step 5 — Exit Scenario Modeling

Model three exit scenarios:

| Scenario | Exit Type | Timeline | Exit Valuation | Our Proceeds | Return Multiple |
|---|---|---|---|---|---|
| Bear | Acqui-hire or fire sale | 3-4 years | $[X]M | $[X]M | [X]x |
| Base | Strategic acquisition | 5-6 years | $[X]M | $[X]M | [X]x |
| Bull | IPO or premium acquisition | 6-8 years | $[X]M | $[X]M | [X]x |

**Key check:** Does the base case (not the bull case) produce an acceptable return? If you need the bull case to justify the investment, the risk/reward is unfavorable.

---

## References & Templates

| File | Content |
|---|---|
| `references/exit-multiples.md` | Historical exit multiples by sector and acquirer type |
| `references/ipo-readiness.md` | Detailed IPO readiness criteria and process |
| `templates/exit-assessment.md` | Exit analysis output template |
