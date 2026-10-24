---
name: portfolio-construction
description: >
  Evaluates individual deals in the context of the overall fund portfolio. Assesses concentration
  risk, correlation, strategic complementarity, reserve allocation, and LP narrative coherence.
  Used primarily by the Portfolio Strategist agent.
---

# Portfolio Construction Skill

No deal exists in isolation. This skill evaluates how a new investment affects the portfolio as a system.

## When to Use

On every deal — the portfolio context always matters.

---

## Portfolio Evaluation Protocol

### Step 1 — Concentration Analysis

**Sector concentration:** What percentage of the portfolio (by capital deployed) is in this sector? If adding this deal pushes one sector above 30% of capital, flag concentration risk.

**Stage concentration:** Is the portfolio balanced across stages, or overweight in one? A portfolio that's 80% Seed has a very different risk profile than one that's balanced.

**Geographic concentration:** Is the portfolio too concentrated in one geography? This creates correlated regulatory and economic risk.

**Vintage concentration:** Are too many investments from the same year? Vintage concentration creates correlated market-cycle risk.

**Thesis concentration:** Is the portfolio too correlated to a single macro thesis (e.g., "AI will eat everything")? If that thesis is wrong, multiple investments fail simultaneously.

### Step 2 — Correlation Assessment

**Question:** If this investment fails, what other portfolio companies are also likely to fail?

**Correlation drivers:**
- Same customer base (if enterprise buyers cut budgets, which portfolio companies are affected?)
- Same technology platform (if an AI model provider changes terms, who's affected?)
- Same regulatory environment (if a regulation tightens, who's affected?)
- Same funding cycle (if VC funding dries up, which companies can't raise follow-on?)
- Same macro trend (if remote work reverses, who suffers?)

**Target:** No more than 3 portfolio companies should be highly correlated on any single risk factor.

### Step 3 — Reserve Allocation

**Key question:** Do we have enough capital reserved to support this investment through follow-on rounds?

**Reserve ratio:** Typical early-stage fund reserves 50-100% of initial check for follow-on. If initial check is $3M, reserve $1.5M-$3M for follow-on.

**Reserve adequacy check:**
- Total fund size
- Capital already deployed
- Capital reserved for existing portfolio follow-on
- Capital remaining for new investments
- Does this deal leave enough reserves for both follow-on and remaining new deals?

### Step 4 — Strategic Complementarity

**Portfolio synergy:** Can this company benefit from or benefit other portfolio companies?
- Customer introductions (Company A's customers are Company B's ideal buyers)
- Technology partnerships (Company A's infrastructure serves Company B's product)
- Talent sharing (insights on hiring, engineering practices, market knowledge)
- Distribution (Company A's platform is a channel for Company B)

**Conflict check:** Does this company compete with any existing portfolio company? Investing in direct competitors is a governance and reputational risk.

### Step 5 — Power Law Assessment

**Fund returner potential:** In venture, returns follow a power law — a few investments return the fund, most don't. For every deal, ask: "Is this capable of returning 1x the fund by itself?"

**Portfolio coverage:** How many potential fund-returners does the portfolio currently have? A healthy portfolio needs 3-5 companies with fund-returner potential. If the portfolio only has 1-2, it's fragile.

### Step 6 — LP Narrative Coherence

**Question:** Does this investment make sense in the story we tell our LPs?

If the fund thesis is "B2B SaaS in healthcare" and this deal is a consumer fintech company, it requires explanation. Not necessarily a dealbreaker — but the deviation from thesis must be justified.

---

## References & Templates

| File | Content |
|---|---|
| `references/portfolio-metrics.md` | Concentration metrics, correlation analysis, reserve planning |
| `references/power-law-dynamics.md` | Power law in venture, fund returner math, portfolio optimization |
| `templates/portfolio-impact.md` | Portfolio impact assessment template |
