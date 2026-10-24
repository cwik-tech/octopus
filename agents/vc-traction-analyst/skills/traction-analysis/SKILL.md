---
name: traction-analysis
description: >
  Examines actual startup performance data to validate or challenge the investment thesis.
  Focuses on retention curves, cohort analysis, revenue quality, customer concentration,
  and engagement depth. Used primarily by the Customer & Traction Analyst agent.
---

# Traction Analysis Skill

The Market Analyst evaluates the market. The Traction Analyst evaluates whether real customers are actually buying, using, and staying. This is the evidence layer — data over narrative.

## When to Use

On every deal with 3+ months of traction data. The more data available, the more valuable this analysis. At Pre-seed with no data, skip.

---

## Traction Analysis Protocol

### Step 1 — Retention Analysis (The Most Important Chart)

**Why retention matters most:** Growth without retention is a leaky bucket. Retention curves reveal product-market fit more reliably than any other metric.

**Cohort retention analysis:**
- Plot retention by monthly cohort (Month 0, Month 1, Month 3, Month 6, Month 12)
- Each cohort should be separate — blended retention hides deteriorating trends
- Healthy retention curves flatten (asymptote). Unhealthy curves decline continuously.

**Benchmarks by type:**

| Product Type | Good D30/M1 Retention | Strong D30/M1 Retention |
|---|---|---|
| B2B SaaS | >85% | >90% |
| SMB SaaS | >70% | >80% |
| Consumer subscription | >45% | >55% |
| Consumer app | >25% | >35% |
| Marketplace (buyer) | >30% | >45% |

**What to look for:**
- Are later cohorts retaining better than earlier cohorts? (Product is improving — bullish)
- Are later cohorts retaining worse? (Product is stagnating or early adopters were artificially sticky — bearish)
- Is there a steep drop at a specific point? (Indicates a value threshold the product fails to deliver past)

### Step 2 — Revenue Quality Assessment

Not all revenue is equal. Decompose:

| Revenue Type | Quality | Why |
|---|---|---|
| Recurring subscription (annual) | Highest | Predictable, committed, high retention |
| Recurring subscription (monthly) | High | Predictable, but easier to churn |
| Usage-based / consumption | High-Medium | Grows with customer success, but volatile |
| Transactional / one-time | Medium | No inherent stickiness |
| Services / professional | Low | Doesn't scale, margin-dilutive |
| Pilot / POC (Proof of Concept) revenue | Lowest | Not evidence of willingness to pay at full price |

**Revenue concentration check:** What % of revenue comes from the top 1, 3, and 10 customers?

| Top Customer % of Revenue | Assessment |
|---|---|
| Top 1 < 10% | Healthy diversification |
| Top 1: 10-25% | Moderate concentration — acceptable at early stage |
| Top 1: 25-50% | High concentration — significant risk |
| Top 1: >50% | Extreme concentration — this is a consulting engagement, not a SaaS company |

### Step 3 — Growth Quality Assessment

Decompose growth into components:

- **Organic growth:** Customers finding the product without paid acquisition. Strongest signal.
- **Paid growth:** Customers acquired through advertising. Only valuable if unit economics work (LTV >> CAC).
- **Viral growth:** Existing customers bringing new customers. Measured by viral coefficient (K-factor). K > 0.5 is good; K > 1.0 is rare and exceptional.
- **Expansion growth:** Existing customers spending more over time. Measured by NRR.

**Growth quality hierarchy:** Viral > Organic > Expansion > Paid > Partnerships > PR/Events

**Channel dependency risk:** If >70% of growth comes from a single channel, flag it. Channels change (algorithm updates, cost increases, policy changes).

### Step 4 — Engagement Depth

Revenue and retention tell you customers *stay*. Engagement tells you customers *use*.

| Metric | What It Reveals |
|---|---|
| DAU/MAU ratio | Frequency of use. >50% = daily habit. <20% = occasional tool. |
| Session frequency | How often users return per week/month |
| Feature adoption | What % of features do users actually use? Breadth of value. |
| Time to value | How quickly do new users reach the "aha moment"? |
| Power user ratio | What % of users are heavy users? Is value concentrated or distributed? |

### Step 5 — Cohort Economics

The most honest view of unit economics: analyze by cohort, not blended.

- **Cohort revenue:** Does each cohort grow or shrink over time?
- **Cohort margin:** Do margins improve as the cohort matures (less support needed)?
- **Cohort LTV curve:** At what month does cumulative revenue exceed acquisition cost?
- **Cohort payback:** When does CAC pay back? Is it shortening with newer cohorts (improving) or lengthening (deteriorating)?

### Step 6 — Data Verification

**Question:** How confident are we that these numbers are real?

| Verification Level | Evidence |
|---|---|
| Verified | Audited financials, bank statements, third-party analytics (Stripe dashboard, Mixpanel, Amplitude) |
| Self-reported but credible | Founder-provided with internal consistency, passes sanity checks |
| Self-reported, unverified | Take with significant discount. Request verification before investment. |
| Pitch deck only | Not evidence. Treat as hypothesis to be tested. |

---

## References & Templates

| File | Content |
|---|---|
| `references/cohort-analysis-guide.md` | Detailed cohort analysis methodology with worked examples |
| `references/engagement-benchmarks.md` | Engagement benchmarks by product type and stage |
| `templates/traction-assessment.md` | Traction analysis output template |
