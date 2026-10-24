---
name: deal-classification
description: >
  Classifies incoming venture capital deals by stage, sector, thesis fit, and deal type. Routes
  deals to the appropriate committee agents based on classification. Used by the Deal Evaluator
  (orchestrator) at the start of every evaluation.
---

# Deal Classification Skill

This skill is the entry point for every deal. Before any agent evaluates anything, the orchestrator classifies the deal and determines which agents participate, what evaluation emphasis applies, and whether the deal warrants full committee review.

## When to Use

At the start of every deal evaluation, before broadcasting to committee agents.

---

## Quick Screen Protocol (5 minutes)

Before full classification, run a rapid screen to determine if the deal warrants committee time.

### Kill Criteria — Pass Immediately If:

1. **Outside thesis:** Stage, sector, or geography doesn't match fund mandate.
2. **Check size mismatch:** Requested investment is below fund minimum or above fund maximum, and no co-investment structure makes it viable.
3. **Obvious valuation misalignment:** Requested valuation exceeds 3x comparable deals at the same stage/metrics without clear justification.
4. **Known red flags:** Founder has history of fraud, litigation, or regulatory sanctions. Cap table is irreparably broken. Company is in active litigation that threatens the business.
5. **No clear product:** At Series A+ and no working product or revenue.
6. **Commodity business:** No defensibility, no differentiation, competing solely on price in a crowded market.

If any kill criterion is met, document the reason and pass. Do not convene the committee.

### Proceed-to-Committee Criteria:

- Passes kill screen AND
- At least two of: strong team signal, promising traction, large market, clear differentiation, thesis alignment

See `templates/deal-screen.md` for the quick screen output format.

---

## Full Classification Protocol

### Dimension 1 — Stage Classification

| Stage | Key Signals | Typical Check Size | Evaluation Emphasis |
|---|---|---|---|
| **Pre-seed** | Idea + team, no product, possibly a prototype. Pre-revenue. | $100K–$1M | Team 70%, Market 20%, Idea 10%. Almost entirely a team bet. |
| **Seed** | MVP (Minimum Viable Product) exists, early users, some traction signals. May have early revenue. | $1M–$4M | Team 40%, Product/Traction 30%, Market 20%, Terms 10%. |
| **Series A** | Product-market fit signals, repeatable customer acquisition, revenue growing. | $5M–$20M | Traction 35%, Team 25%, Market 20%, Unit Economics 15%, Terms 5%. |
| **Series B+** | Proven unit economics, scaling organization, clear path to large outcome. | $15M–$50M+ | Unit Economics 30%, Traction 25%, Market 15%, Team 15%, Terms 10%, Exit Path 5%. |
| **Growth** | Market leader or strong #2, pre-IPO or acquisition track. | $50M+ | Financials 35%, Market Position 25%, Exit Path 20%, Terms 15%, Team 5%. |

**Classification rule:** If signals conflict across stages (e.g., revenue says Series A but team maturity says Seed), classify to the *lower* stage. Over-classifying leads to inflated expectations.

See `references/stage-benchmarks.md` for detailed metrics per stage.

### Dimension 2 — Sector Classification

| Sector | Key Domain Risks | Metrics That Matter |
|---|---|---|
| **SaaS (Software as a Service)** | Churn, customer concentration, commoditization | ARR (Annual Recurring Revenue), NRR (Net Revenue Retention), CAC (Customer Acquisition Cost) payback, logo churn, expansion revenue |
| **Marketplace / Platform** | Chicken-and-egg, liquidity, disintermediation | GMV (Gross Merchandise Value), take rate, liquidity metrics, supply/demand balance, repeat rate |
| **Deep Tech / Hard Tech** | Science risk, long timelines, capital intensity | Technical milestones, IP portfolio, team PhD/publication density, partnership signals |
| **Fintech (Financial Technology)** | Regulatory, compliance cost, trust, fraud | TPV (Total Payment Volume), default rates, regulatory approvals, unit economics net of compliance cost |
| **Healthtech** | FDA (Food and Drug Administration), HIPAA, sales cycles, clinical validation | Clinical evidence, regulatory pathway, payer willingness, pilot results |
| **Consumer** | Acquisition cost, retention, fad risk | DAU/MAU (Daily/Monthly Active Users), retention curves, organic vs. paid growth, viral coefficient |
| **Infrastructure / DevTools** | Adoption friction, open-source competition, platform risk | Developer adoption, usage metrics, expansion patterns, community health |
| **Climate / Energy** | Capital intensity, regulatory dependency, technology risk | Unit economics at scale, policy landscape, deployment pipeline, offtake agreements |

See `references/sector-profiles.md` for detailed sector profiles.

### Dimension 3 — Thesis Fit Assessment

Answer these questions:

1. **Stage fit:** Does this deal fall within our target stage range?
2. **Sector fit:** Does this deal fall within our sector focus areas?
3. **Geography fit:** Is the company in a geography we invest in?
4. **Check size fit:** Can we write an appropriately sized check?
5. **Expertise fit:** Do we have domain expertise relevant to this company?
6. **Portfolio fit:** Does this complement or conflict with existing portfolio companies?
7. **LP narrative fit:** Does this investment make sense in the context of what we told our LPs (Limited Partners) we would do?

**Scoring:** Each question is Yes/No/Partial. If 5+ are Yes, strong thesis fit. If 3-4, moderate fit — proceed but note the gaps. Below 3, likely pass unless the opportunity is exceptional.

### Dimension 4 — Deal Type Classification

| Type | Evaluation Protocol |
|---|---|
| **New investment** | Full committee evaluation. All relevant agents invoked. |
| **Follow-on** | Abbreviated evaluation. Focus on: has the thesis held? Are metrics on track? Are terms fair? Apply the clean-sheet test: would we invest from scratch at these terms? |
| **Co-investment** | Focus on: who is leading and what's their diligence quality? What's our independent assessment of the terms? Do we add value beyond capital? |
| **SPV (Special Purpose Vehicle)** | Focus on: does this opportunity warrant a special vehicle? What's the LP appetite? Is the deal economics justified for the added complexity? |

---

## Agent Routing Table

Based on classification, determine which agents participate:

| Agent | Always Invoke | Conditional Invoke |
|---|---|---|
| **Market Analyst** | All deals | — |
| **Contrarian / Red Team** | All deals | — |
| **Founder Assessor** | Pre-seed, Seed, Series A | Series B+ only if leadership change or concern |
| **Financial Modeler** | Series A and above | Seed only if revenue-generating |
| **Deal Structurer** | All deals with terms | Pre-seed only if unusual structure |
| **Technology Evaluator** | Deep Tech, Infrastructure, any IP-heavy deal | Consumer/marketplace only if tech is core differentiator |
| **Futurist** | Any deal with 5+ year thesis, macro-sensitive sectors | Skip for tactical/short-horizon deals |
| **Portfolio Strategist** | All deals | — |
| **Pattern Matcher** | All deals | — |
| **Exit Strategist** | Series A and above | Seed only if exit path is core to thesis |
| **Thesis Defounder** | All deals | — |
| **Traction Analyst** | Any deal with 3+ months of data | Pre-seed with no data: skip |
| **Legal & IP** | IP-heavy deals, healthtech, fintech, any regulatory concern | Simple SaaS with clean structure: skip |
| **Timing & Deal Dynamics** | All deals | — |
| **Value-Add Strategist** | All deals where we compete for allocation | Deals with no allocation competition: optional |
| **Wild Card** | Selectively — when thesis is crowded or committee is converging too fast | Not on straightforward pass/invest decisions |

---

## Output Format

Use `templates/classification-output.md` for the full classification. Use `templates/deal-screen.md` for the quick screen.

## Reference Index

| File | Content | When to read |
|---|---|---|
| `references/stage-benchmarks.md` | Detailed metrics and benchmarks per stage | During Stage classification |
| `references/sector-profiles.md` | Sector-specific profiles, risks, and metrics | During Sector classification |
| `templates/deal-screen.md` | Quick screen output template | During Quick Screen |
| `templates/classification-output.md` | Full classification output template | After full classification |
