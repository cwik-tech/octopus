# Market Sizing Methodologies

## Top-Down Method (Detailed)

### Process

1. Start with the broadest credible industry figure from a reputable source
2. Apply successive filters to narrow to the addressable segment
3. Each filter should be sourced or justified

### Worked Example: B2B SaaS for Restaurant Management

- **Total US restaurant industry revenue:** $1.1T (National Restaurant Association, 2024)
- **Technology spend as % of revenue:** ~3% for mid-market restaurants = $33B
- **Restaurant management software segment:** ~15% of tech spend = $5B
- **Cloud/SaaS portion:** ~40% (rest is legacy on-premise, POS hardware) = $2B
- **Mid-market restaurants (our target segment):** ~30% of cloud spend = $600M
- **Geographic focus (US only, initial):** = $600M

**Top-down TAM:** $600M (addressable cloud restaurant management software for US mid-market)

### Sourcing Rules

- Industry revenue: use government data (Census Bureau, BLS) or major analyst firms
- Segment splits: use analyst reports, trade publications, or public company revenue segmentation
- When no source exists: state the assumption explicitly and note it as "estimated, low confidence"

## Bottom-Up Method (Detailed)

### Process

1. Count potential customers using the most specific data available
2. Estimate annual contract value (ACV) using competitive pricing data
3. Multiply and adjust for adoption reality

### Worked Example: Same Restaurant Case

- **US restaurants (full-service, mid-market):** 320,000 (Census Bureau NAICS data)
- **Already using cloud management software:** ~35% = 112,000 (industry survey)
- **Remaining addressable (not yet using or using legacy):** 208,000
- **Plus replacement opportunity (switching from legacy):** 112,000 × 20% annual switch rate = 22,400/year
- **Annual Contract Value:** Competitive analysis shows $3,600-$7,200/year for comparable products. Use $5,000 midpoint.
- **Total addressable (new + replacement):** 230,400 restaurants × $5,000 = $1.15B
- **Realistic 7-year penetration at 8%:** $92M annual revenue

**Bottom-up TAM:** $1.15B (total addressable), **SOM:** ~$92M at 8% penetration

### Triangulation

Top-down: $600M. Bottom-up: $1.15B. Ratio: ~1.9x. Within acceptable range. The gap is likely explained by the bottom-up counting some restaurants that wouldn't adopt at the assumed price point. Use $600M-$1.15B range with midpoint ~$800M.

## Value-Theory Method

For novel categories where no existing market data exists:

### Process

1. Identify the problem the product solves
2. Quantify the cost of the problem (time, money, risk) to each customer
3. Estimate willingness to pay as a fraction of value delivered (typically 10-30%)
4. Multiply by customer count

### Worked Example: AI-Powered Compliance Monitoring

- **Problem:** Manual compliance review costs mid-market banks $500K/year in staff time
- **Product value:** Reduces compliance cost by 60% = $300K saved
- **Willingness to pay (20% of value):** $60K/year
- **US mid-market banks:** ~4,500 (FDIC data)
- **TAM:** 4,500 × $60K = $270M

This method is useful when the product creates a new category, but it's highly sensitive to the "willingness to pay as % of value" assumption. Always sensitivity-test this parameter.

## Fermi Estimation for Novel Markets

When data is scarce, build an estimate from first principles:

### Rules

1. Decompose the question into sub-questions you can estimate
2. For each sub-question, estimate a range (low, mid, high)
3. Multiply through, producing a range, not a point estimate
4. Check against any available anchor data

### Worked Example: Market for AI Writing Assistants for Legal Firms

- US law firms: ~450,000 (ABA data)
- Firms with 5+ attorneys (our target): ~50,000
- % that would adopt AI writing tools in next 5 years: 15-40% (low-high)
- Annual price point: $5,000-$15,000 per firm (competitive range)
- **Low estimate:** 50,000 × 15% × $5,000 = $37.5M
- **High estimate:** 50,000 × 40% × $15,000 = $300M
- **Midpoint:** ~$170M

The 8x range between low and high is typical for Fermi estimates of novel markets. Present the range, not just the midpoint.

## Sensitivity Analysis

For any market sizing, test these variables:

| Variable | Test | Impact |
|---|---|---|
| Customer count | ±30% | Linear impact on TAM |
| Price point | ±50% | Linear impact on TAM |
| Adoption rate | ±50% | Linear impact on SOM |
| Geographic expansion | Add/remove regions | Step-function impact on TAM |
| Adjacent markets | Include/exclude | Can double TAM if credible |

Run a tornado chart showing which variable moves the estimate most. That variable is where diligence effort should focus.
