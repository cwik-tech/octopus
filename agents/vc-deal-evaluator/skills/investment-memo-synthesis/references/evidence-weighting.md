# Evidence Weighting in Venture Capital

## The Evidence Hierarchy

Not all evidence is created equal. In VC, the hierarchy from strongest to weakest:

### Tier 1: Verified Quantitative Evidence (Highest Weight)

- Audited financial statements
- Third-party verified metrics (analytics platforms, payment processor data)
- Cohort retention data with 6+ months of history
- Bank statements confirming revenue
- Tax returns showing historical performance

**Why Tier 1:** Hardest to fabricate, most objective, least subject to interpretation. When Tier 1 evidence conflicts with any other tier, Tier 1 wins.

### Tier 2: Independent Market Evidence

- Industry analyst reports from credible firms (Gartner, IDC, McKinsey)
- Government statistics and census data
- Trade association data
- Academic research with peer review
- Competitor financial disclosures (public company filings)

**Why Tier 2:** Independently produced, not motivated by the deal. Subject to methodology limitations but not to deal-specific bias.

### Tier 3: Backchannel References

- Conversations with people who worked with the founders (not founder-suggested)
- Customer references the founders didn't provide
- Former employees (especially those who left)
- Industry practitioners who know the market independently

**Why Tier 3:** Primary source information with some bias (people have their own agendas) but not curated by the founders. Backchannel > formal references because the founders didn't control the selection.

### Tier 4: Founder-Provided Metrics

- Revenue and growth data shared by the company (unaudited)
- Customer count and pipeline data
- Product usage metrics from internal dashboards
- Employee count and hiring pipeline

**Why Tier 4:** Founders have incentive to present favorable numbers. Not necessarily dishonest but subject to selection bias (sharing best months, best metrics, best customer stories). Verify against Tier 1 where possible.

### Tier 5: Structural and Pattern-Based Analysis

- Cross-domain pattern matches (Pattern Matcher)
- Scenario analysis (Futurist)
- Competitive positioning analysis
- Historical deal comparables

**Why Tier 5:** Analytically valuable but inherently uncertain. Patterns from the past may not repeat. Scenarios are plausible, not probable. Use to inform judgment, not to determine it.

### Tier 6: Estimates and Projections

- Market size estimates (TAM/SAM/SOM)
- Financial projections and models
- Growth rate extrapolations
- Exit multiple assumptions

**Why Tier 6:** Necessary for investment analysis but highly uncertain. All projections are wrong — the question is whether they're directionally useful. Wide confidence intervals apply.

### Tier 7: Narrative and Qualitative Assessment (Lowest Weight)

- Pitch deck narrative and vision
- Founder charisma and presentation quality
- "Gut feel" about the opportunity
- Buzz and media coverage
- Other investors' enthusiasm

**Why Tier 7:** Most subject to bias (narrative fallacy, social proof, halo effect). Never base a decision on Tier 7 alone. Use only to generate hypotheses that are then tested with higher-tier evidence.

---

## Bayesian Updating for Deal Evaluation

### The Process

Start with a prior belief (base rate) and update as evidence arrives:

1. **Establish the base rate.** What percentage of companies at this stage, in this sector, with these metrics, produce a successful outcome (defined as returning 3x+ for the fund)?

   Rough base rates:
   - Pre-seed: 5-8% produce meaningful returns
   - Seed: 8-12% produce meaningful returns
   - Series A: 15-25% produce meaningful returns
   - Series B: 25-35% produce meaningful returns

2. **Update with each evidence signal.** Each agent's position statement provides evidence that shifts the probability up or down. Strong evidence shifts more than weak evidence.

3. **Track the running estimate.** After each agent's input, note whether the probability of success increased, decreased, or stayed the same. The direction of cumulative updates matters more than any single update.

### Update Rules

**Large positive update (shift up 10-20%):**
- Tier 1 evidence showing exceptional performance (top decile metrics)
- Multiple Tier 3 sources independently confirming founder strength
- Tier 2 evidence showing market timing is ideal

**Moderate positive update (shift up 5-10%):**
- Tier 4 metrics that meet or exceed stage benchmarks
- Pattern Matcher identifies structural similarity to a successful trajectory
- Competitive analysis shows defensible positioning

**Small positive update (shift up 1-5%):**
- Founder narrative is coherent and compelling
- Other credible investors are involved
- Sector is experiencing tailwinds

**Negative updates follow the same tiers in reverse.** Tier 1 evidence of problems (e.g., declining revenue in audited financials) produces a large negative update. Tier 7 concerns (e.g., "I have a bad feeling") produce a small negative update.

### Conflict Resolution via Bayesian Framework

When agents disagree, the Bayesian framework resolves it by asking: "Which agent's evidence is higher-tier?"

- Financial Modeler (using Tier 1 audited data) vs. Founder Assessor (using Tier 3 references) → Financial Modeler's evidence weights more
- Traction Analyst (using Tier 4 founder-provided metrics) vs. Market Analyst (using Tier 2 industry data) → Market Analyst's evidence weights more for market claims, but Traction Analyst weights more for company-specific claims
- Pattern Matcher (using Tier 5 structural analysis) vs. Wild Card (using Tier 7 intuition) → Pattern Matcher weights more

**Exception:** Lower-tier evidence that reveals a *qualitative* insight (e.g., a backchannel reference revealing founder dishonesty) can override higher-tier quantitative evidence because it changes the reliability of all founder-provided data.

---

## Common Weighting Errors

**Metric worship.** Over-weighting quantitative metrics because they feel "objective." A company with great metrics and a dishonest founder is worse than a company with okay metrics and an exceptional founder. Quantitative evidence is higher-tier but not infinitely so.

**Narrative override.** A compelling founder story overrides weak metrics. "But the founder is so passionate!" Passion is Tier 7 evidence. It should not override Tier 1-4 evidence of poor performance.

**Recency dominance.** Weighting the last quarter's data over 18 months of history. Recent data is informative but should be contextualized against longer trends. A single strong quarter can be an outlier.

**Social proof substitution.** "Sequoia invested, so the diligence must be done." Other investors' involvement is Tier 7 evidence for your decision. They have different theses, different return targets, and different information than you.
