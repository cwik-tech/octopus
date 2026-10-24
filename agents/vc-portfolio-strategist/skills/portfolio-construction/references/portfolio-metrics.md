# Portfolio Metrics

## Purpose

Concentration metrics, correlation analysis methods, and reserve planning frameworks for evaluating how a new deal affects the fund portfolio.

---

## Concentration Metrics

### Sector Concentration

**Measurement:** Capital deployed per sector as a percentage of total fund size.

| Concentration Level | % in Single Sector | Assessment |
|---|---|---|
| Diversified | <20% | Healthy — risk spread across sectors |
| Moderate concentration | 20-30% | Acceptable if the fund thesis supports it |
| High concentration | 30-50% | Requires justification — sector-specific fund or high-conviction thesis |
| Extreme concentration | >50% | Fund is effectively a single-sector bet |

**Action trigger:** Adding a deal that pushes any sector above 30% requires explicit justification.

### Stage Concentration

| Stage Mix | Risk Profile | LP Expectation |
|---|---|---|
| >70% Pre-seed/Seed | Very high risk, high potential return, long time to liquidity | Expect 3-5 fund returners from 20-30 deals |
| Balanced (40% Seed, 40% A, 20% B) | Moderate risk, moderate return, mixed liquidity | Traditional early-stage fund profile |
| >70% Series A/B | Lower risk, moderate return, shorter time to liquidity | Expect 2-3 strong performers |

### Vintage Concentration

**Measurement:** Number of investments made per year as a percentage of total portfolio.

**Risk:** A portfolio concentrated in one vintage is correlated to that year's market conditions. If 2024 was a frothy year and 70% of the portfolio was deployed in 2024, the portfolio is overexposed to 2024 valuations.

**Target:** Spread deployments across the fund's investment period (typically 3-4 years) with no more than 40% in any single year.

### Geographic Concentration

**Measurement:** Capital deployed by geography.

| Concern | Trigger |
|---|---|
| Regulatory risk correlation | >60% in a single regulatory jurisdiction |
| Economic risk correlation | >50% dependent on a single economy |
| Currency risk | >30% generating revenue in a single non-base currency |

---

## Correlation Analysis

### Correlation Drivers

Two portfolio companies are "correlated" if the same external event is likely to affect them both in the same direction (both up or both down).

| Correlation Driver | How to Detect | Severity |
|---|---|---|
| **Same customer base** | Both sell to the same buyer persona or budget line | High — if that buyer cuts budget, both suffer |
| **Same technology platform** | Both depend on the same underlying technology (e.g., OpenAI API, AWS) | High — platform changes affect both |
| **Same regulatory environment** | Both affected by the same regulations | Medium — regulatory change timeline is usually slow |
| **Same funding cycle** | Both will need to raise at similar times in similar market conditions | Medium — affects follow-on but not operations |
| **Same macro trend** | Both benefit from the same secular trend (e.g., remote work, AI adoption) | Medium — if the trend reverses, both are affected |
| **Same competitive dynamic** | Both face the same competitor or compete with each other | High — competitive outcome affects both |

### Correlation Matrix

For each pair of portfolio companies, assess correlation:

| | Co. A | Co. B | Co. C | Co. D |
|---|---|---|---|---|
| **Co. A** | — | [H/M/L] | [H/M/L] | [H/M/L] |
| **Co. B** | | — | [H/M/L] | [H/M/L] |
| **Co. C** | | | — | [H/M/L] |
| **Co. D** | | | | — |

**Target:** No more than 3 portfolio companies with "High" correlation to any single factor.

---

## Reserve Planning

### Reserve Ratio Guidelines

| Fund Strategy | Initial Check | Reserve Ratio | Total per Company |
|---|---|---|---|
| Seed-focused | $500K-$2M | 1:1 to 2:1 | $1M-$6M |
| Series A-focused | $3M-$10M | 0.5:1 to 1:1 | $4.5M-$20M |
| Multi-stage | Variable | 0.75:1 average | Variable |

### Reserve Allocation Framework

**Step 1:** Total fund size: $[X]M

**Step 2:** Management fees and expenses (typically 2% annually × 10 years = 20%): $[X]M

**Step 3:** Investable capital: $[X]M

**Step 4:** Allocation:
- New investments: typically 60-70% of investable capital
- Reserves for follow-on: typically 30-40% of investable capital

**Step 5:** Per-deal calculation:
- Target portfolio size: [X] companies
- Average initial check: $[X]M
- Average reserve per company: $[X]M
- Remaining capacity for new deals after this investment: [X] companies

### Reserve Deployment Triggers

| Trigger | Reserve Action | Rationale |
|---|---|---|
| Company is a top-quartile performer | Deploy full reserve pro-rata | Double down on winners (power law) |
| Company is performing adequately | Deploy partial reserve | Maintain ownership, don't over-invest |
| Company is underperforming but viable | Evaluate bridge participation | Only if clear path to recovery |
| Company is failing | Do not deploy reserves | Preserve capital for winners |

### Reserve Adequacy Check

Before every new investment, answer:
1. How much total capital remains undeployed?
2. How much is already committed as reserves for existing portfolio?
3. After this investment (initial + reserve), how much remains for future new deals?
4. Can the fund reach its target portfolio size with remaining capital?
