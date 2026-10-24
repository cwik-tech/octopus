---
name: market-sizing
description: >
  Validates and independently sizes startup market opportunities. Combines top-down, bottom-up,
  and value-theory approaches. Exposes inflated TAM claims and identifies the real addressable
  market. Used primarily by the Market Analyst agent.
---

# Market Sizing Skill

Every pitch deck claims a large TAM. This skill provides the protocol to independently validate market size claims, build ground-up sizing models, and distinguish real addressable markets from wishful thinking.

## When to Use

On every deal — market size validation is never optional.

---

## Market Sizing Protocol

### Step 1 — Deconstruct the Founder's TAM Claim

Before building your own model, parse what the founder is claiming:

- **Source:** Where did the number come from? Analyst report? Government data? The founder's own calculation? "Google it" numbers?
- **Method:** Is it top-down (industry size divided down) or bottom-up (customers × price × frequency)?
- **Definition:** Is the TAM total industry revenue, software spend, or the value of the problem being solved? These are radically different numbers.
- **Vintage:** How old is the data? Markets change. A 2021 TAM estimate for AI infrastructure is irrelevant in 2026.
- **Assumption audit:** What's assumed about adoption rate, pricing, geography, and customer willingness to pay?

**Common founder TAM inflation techniques:**
- Using the total industry size when only a small segment is addressable
- Conflating "people who have the problem" with "people who will pay for a solution"
- Using global TAM for a product that works in one language or geography
- Citing the TAM for a broader category than the product actually addresses

### Step 2 — Top-Down Sizing

Start from the largest defensible number and narrow:

1. **Total industry revenue** (from analyst reports, government data, trade associations)
2. **Relevant segment** (which part of the industry does this product serve?)
3. **Software/solution share** (what percentage of industry spend goes to the type of solution this startup offers?)
4. **Addressable geography** (where can this product actually be sold?)
5. **Realistic penetration** (what market share is achievable in 5-7 years given competitive dynamics?)

**Result:** Top-down estimate with sources and assumptions cited.

### Step 3 — Bottom-Up Sizing

Build from unit economics:

1. **Count the buyers.** How many organizations or individuals could be customers? Use specific databases: Census data, industry registries, LinkedIn company counts, government filings.
2. **Estimate willingness to pay.** Not "the product costs $X" but "what do similar buyers pay for similar solutions?" Use competitive pricing as evidence.
3. **Estimate purchase frequency.** One-time? Annual subscription? Usage-based? Monthly?
4. **Calculate:** Buyers × Price × Frequency = Bottom-up market size.

**Adjust for:**
- Adoption barriers (switching costs, integration effort, regulatory approval)
- Market readiness (is this a known category or does the company need to educate buyers?)
- Competitive intensity (what percentage of buyers will choose this startup vs. alternatives?)

### Step 4 — Triangulation

Compare top-down and bottom-up estimates:

| Ratio (Top-Down : Bottom-Up) | Interpretation |
|---|---|
| Within 2x | Estimates align — reasonable confidence |
| 2-5x gap | Investigate — an assumption is wrong somewhere |
| >5x gap | Red flag — one estimate is fundamentally flawed. Do not proceed without resolving |

The gap usually reveals one of: inflated top-down category, over-counted buyers, mispriced willingness-to-pay, or geography mismatch.

### Step 5 — SAM and SOM Reality Check

**SAM (Serviceable Addressable Market):** The portion of TAM the startup can actually serve given: current product capabilities, go-to-market reach, pricing model, and regulatory constraints. SAM is typically 10-30% of TAM.

**SOM (Serviceable Obtainable Market):** The realistic market share within SAM over the fund's investment horizon (5-7 years). For most startups, capturing 5-15% of SAM within the fund lifecycle is a reasonable expectation; above 20% requires winner-take-all dynamics.

**Key check:** Does the SOM support the required exit valuation? If the SOM is $200M and the startup needs a $2B exit to return the fund, the math doesn't work unless expansion is credible.

### Step 6 — Market Dynamics Assessment

Static market size is insufficient. Assess dynamics:

- **Growth rate:** Is the market growing, stable, or shrinking? Use 5-year CAGR (Compound Annual Growth Rate). Growing >15% annually = tailwind. Flat or shrinking = headwind (the startup must take share, not ride growth).
- **Growth drivers:** What's causing growth? Technology shift, regulatory change, demographic trend, behavior change? Is the driver structural (persists) or cyclical (reverses)?
- **Market structure:** Fragmented (many small players, consolidation opportunity) vs. concentrated (few large players, disruption play). Winner-take-all vs. multi-player equilibrium.
- **Value migration:** Is value moving within the industry? From services to software? From on-premise to cloud? From incumbents to startups?

### Step 7 — Adjacent Market Expansion

If the core market is small, can the startup credibly expand?

- **Adjacent markets:** What related markets could the startup enter with natural product extension?
- **Platform potential:** Does the core product create a platform for additional products/services?
- **Expansion evidence:** Has the startup already shown signs of expansion (customers asking for adjacent features, organic cross-sell)?
- **Expansion credibility:** Rate 1-5 how credible the expansion is based on current capabilities.

---

## Common Market Sizing Traps

1. **Revenue vs. value confusion:** A $50B healthcare industry doesn't mean $50B in software spend. The addressable software market may be 2-5% of the total industry.
2. **Global TAM, local product:** Using worldwide numbers for a product that requires local regulatory approval, language support, or physical presence.
3. **100% adoption assumption:** Assuming every potential customer adopts. Even in mature categories, adoption rarely exceeds 60-70%.
4. **Category creation confusion:** If the startup is creating a new category, there is no existing TAM to measure. Use analogous categories and bottom-up sizing instead.
5. **Circular reasoning:** "The market is $10B because if 10,000 companies each paid $1M..." — but the $1M price isn't validated.

---

## References & Templates

| File | Content | When to read |
|---|---|---|
| `references/sizing-methodologies.md` | Detailed methods with worked examples | During Steps 2-4 |
| `references/market-dynamics.md` | Market structure analysis and growth drivers | During Step 6 |
| `templates/market-assessment.md` | Market sizing output template | Final output |
