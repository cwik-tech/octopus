# Valuation Methods (Detailed)

## Revenue Multiple Comparables

### Process

1. **Define peer group.** Select 5-10 companies with similar: stage, sector, growth rate (±20%), business model, and geographic focus. Use PitchBook, Crunchbase, or public filings.

2. **Extract multiples.** For each peer, calculate EV/Revenue (Enterprise Value / Annual Revenue) at their most recent round or current public valuation.

3. **Adjust for quality.** Companies with higher growth, better retention, and stronger margins deserve premium multiples. Apply adjustments:

| Factor | Premium/Discount |
|---|---|
| Growth rate >50% above median | +20-40% premium |
| Growth rate >50% below median | -20-40% discount |
| NRR >130% | +10-20% premium |
| Gross margin >75% | +10-15% premium |
| Gross margin <60% | -15-25% discount |
| Capital efficiency (burn multiple <1.5x) | +10-20% premium |

4. **Apply range.** Use the adjusted peer median as center, with 25th and 75th percentile as bounds. The target company's valuation should fall within this range unless specific factors justify deviation.

### Typical Revenue Multiples by Stage (Normal Markets)

| Stage | Median EV/Revenue | Range |
|---|---|---|
| Seed | 20-50x (often implicit from valuation cap) | Wide — market sentiment driven |
| Series A | 15-30x | Depends heavily on growth rate |
| Series B | 10-20x | Growth + margin quality matters |
| Growth | 8-15x | Converging toward public market multiples |
| Public SaaS | 5-12x | Highly correlated to Rule of 40 score |

**Warning:** These multiples fluctuate significantly with market cycles. In frothy markets (2021), add 50-100%. In downturns (2023), subtract 30-50%.

## Discounted Cash Flow (DCF)

### When to Use in VC

DCF is supplementary for venture-stage companies because:
- Cash flow projections beyond 2 years are highly speculative
- The discount rate is debatable (30-50% for early stage is common but imprecise)
- Terminal value typically accounts for 80%+ of the calculated value, making it the most important and least knowable input

**Use DCF for:** Sanity-checking whether the implied exit valuation is achievable. Testing whether the business model produces cash flow at scale.

### Process

1. **Project revenue for 5-7 years.** Use the company's projections as a starting point but apply your own growth rate assumptions based on stage benchmarks and market reality.

2. **Project costs.** COGS scaling with revenue (use gross margin assumption). Operating expenses growing with headcount and infrastructure needs.

3. **Calculate Free Cash Flow (FCF).** Revenue - COGS - Operating Expenses - CapEx - Changes in Working Capital.

4. **Terminal value.** Use exit multiple method: Terminal year revenue × Terminal multiple. Terminal multiple should be based on mature companies in the sector (typically 5-10x revenue for SaaS).

5. **Discount rate.** Apply stage-appropriate discount rates:

| Stage | Discount Rate |
|---|---|
| Pre-seed | 50-70% |
| Seed | 40-60% |
| Series A | 30-50% |
| Series B | 25-40% |
| Growth | 20-30% |

6. **Calculate present value.** Sum of discounted cash flows + discounted terminal value.

### Sensitivity Analysis

Always run DCF with at least 3 scenarios:

| Variable | Bear | Base | Bull |
|---|---|---|---|
| Revenue growth | -50% from projection | As projected | +50% from projection |
| Gross margin | -10pp from target | Target | +5pp from target |
| Terminal multiple | 5x | 8x | 12x |

The range between bear and bull gives the uncertainty band. If the founder's valuation falls within the base-bull range, it's reasonably priced. If it requires the bull case, it's aggressive.

## Venture Capital Method (Detailed)

### Process

1. **Estimate exit value.** Based on: comparable exits in the sector × the company's projected metrics at exit.

   Example: Comparable SaaS companies in this sector exit at 8-12x revenue. If the company reaches $100M ARR at exit, exit value = $800M-$1.2B.

2. **Determine target return.** Based on fund economics:
   - Early-stage fund (Seed/A): needs 10-30x on winners to return the fund (because most investments fail)
   - Growth fund (B+): needs 3-5x on winners

3. **Calculate maximum entry valuation.**

   Post-money valuation = Exit value / Target return / (1 + cumulative dilution)

   Example: $1B exit / 20x target / (1 + 0.5 dilution) = $33M post-money maximum

4. **Compare to asking price.** If the founder asks for $40M post-money and your math says $33M maximum, either negotiate or pass.

### Dilution Assumptions

| Future Rounds | Cumulative Dilution (Typical) |
|---|---|
| Seed → Exit | 50-65% |
| Series A → Exit | 40-55% |
| Series B → Exit | 25-40% |
| Growth → Exit | 10-25% |

### Fund Return Math

**The power law reality:** In a typical early-stage fund, 1-2 investments return the entire fund. The rest break even or go to zero.

For a $100M fund aiming to return 3x ($300M):
- Must generate $300M in proceeds
- If investing $5M per deal across 20 deals
- Need ~2-3 investments returning 20x+ each
- For a $5M investment to return $100M: need $100M in proceeds at exit, requiring a large outcome

**Key question for every deal:** "Is this capable of being one of the 2-3 fund-returning investments?" If not, it may not be worth the portfolio slot regardless of the expected return.
