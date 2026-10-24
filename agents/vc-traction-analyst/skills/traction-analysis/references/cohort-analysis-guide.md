# Cohort Analysis Guide

## Purpose

Detailed methodology for conducting cohort analysis on startup traction data. Cohort analysis reveals patterns that blended metrics hide — it's the most honest way to evaluate product-market fit.

---

## What Is Cohort Analysis?

A cohort is a group of customers who share a common characteristic — typically the time period in which they started using the product. By tracking each cohort separately, you can see whether the product is improving (newer cohorts behave better) or deteriorating (newer cohorts behave worse).

**Why blended metrics lie:** Blended metrics (e.g., "our overall retention is 80%") mix early adopters (who are typically the most enthusiastic) with newer customers (who may be less engaged). This can mask deteriorating trends.

---

## Retention Cohort Analysis

### Building a Retention Cohort Table

| | Month 0 | Month 1 | Month 2 | Month 3 | Month 6 | Month 12 |
|---|---|---|---|---|---|---|
| Jan cohort (100 users) | 100% | 72% | 58% | 50% | 40% | 32% |
| Feb cohort (120 users) | 100% | 75% | 62% | 55% | 43% | — |
| Mar cohort (150 users) | 100% | 78% | 65% | 58% | — | — |
| Apr cohort (180 users) | 100% | 80% | 68% | — | — | — |

### Reading the Table

**Horizontal reading (row):** How a single cohort decays over time. Healthy curves flatten (form an asymptote). Unhealthy curves decline continuously.

**Vertical reading (column):** How the same metric improves or deteriorates across cohorts. If Month 1 retention improves from 72% → 75% → 78% → 80%, the product is improving.

**Diagonal reading:** Compares how different cohorts perform at the same real-world time. Useful for detecting environmental effects (market changes, competitive pressure).

### What Good Looks Like

**The "smile curve":** Initial drop, then flattening, then (ideally) slight uptick as retained users become power users. This is the signature of product-market fit.

**Improving cohorts:** Each successive cohort retains better than the last. This means the product is improving, onboarding is getting better, or the company is attracting better-fit customers.

### What Bad Looks Like

**Continuous decline:** No flattening — every month loses more users. The product doesn't create enough value to form a habit.

**Deteriorating cohorts:** Newer cohorts retain worse than older cohorts. This often means early adopters were uniquely enthusiastic and the product doesn't generalize.

**Cliffs:** A sharp drop at a specific point (e.g., Day 7 or Day 30) suggests a free trial expiration, a value threshold the product fails to deliver past, or an onboarding failure.

---

## Revenue Cohort Analysis

### Building a Revenue Cohort Table

Track cumulative revenue per cohort over time:

| | Month 1 | Month 3 | Month 6 | Month 12 |
|---|---|---|---|---|
| Q1 cohort (20 customers, $50K initial MRR) | $50K | $55K | $65K | $80K |
| Q2 cohort (30 customers, $80K initial MRR) | $80K | $90K | $105K | — |
| Q3 cohort (40 customers, $120K initial MRR) | $120K | $130K | — | — |

### Net Revenue Retention by Cohort

| Cohort | Starting MRR | Expansion | Contraction | Churn | Ending MRR | NRR |
|---|---|---|---|---|---|---|
| Q1 | $50K | +$20K | -$5K | -$8K | $57K | 114% |
| Q2 | $80K | +$25K | -$8K | -$10K | $87K | 109% |

**Cohort NRR is more honest than blended NRR.** If cohort NRR is declining, the product's expansion ability is deteriorating even if blended NRR looks stable (because older, better cohorts prop up the average).

---

## Engagement Cohort Analysis

### Activity-Based Cohorts

Track engagement intensity (not just retention) by cohort:

| | Week 1 (sessions) | Week 4 | Week 12 | Week 24 |
|---|---|---|---|---|
| Jan cohort | 5.2 avg | 3.1 avg | 2.4 avg | 2.1 avg |
| Feb cohort | 5.5 avg | 3.5 avg | 2.8 avg | — |
| Mar cohort | 5.8 avg | 3.8 avg | — | — |

**Engagement depth matters more than breadth.** A smaller number of highly engaged users is often a stronger signal than a large number of lightly engaged users.

---

## CAC Payback Cohort Analysis

Track how quickly each cohort pays back its acquisition cost:

| Cohort | Avg CAC | Month 1 Revenue | Cumulative Month 6 | Cumulative Month 12 | Payback Month |
|---|---|---|---|---|---|
| Q1 | $5,000 | $500 | $3,500 | $8,000 | Month 10 |
| Q2 | $6,500 | $600 | $4,000 | — | Projected Month 11 |
| Q3 | $8,000 | $650 | — | — | Projected Month 13 |

**If CAC payback is lengthening across cohorts, the business is becoming less efficient even if it's growing.** This is one of the most important signals for the Financial Modeler.

---

## Data Quality Assessment

### Verification Hierarchy

| Source | Confidence Level | Action |
|---|---|---|
| Third-party analytics (Stripe, Mixpanel, Amplitude) with investor access | Very High | Trust with spot-checks |
| Screenshots of analytics dashboards | High | Verify a few data points for consistency |
| Founder-prepared cohort analysis | Medium | Cross-check against financial data |
| Pitch deck charts without underlying data | Low | Request underlying data |
| Verbal claims without data | Very Low | Treat as hypothesis, not evidence |

### Sanity Checks

- Does revenue cohort data reconcile with bank statements?
- Do user counts reconcile with payment processor records?
- Are cohort sizes consistent with marketing spend (does the CAC math work)?
- Is the time period consistent (monthly vs. weekly vs. daily cohorts)?
- Are churned users truly gone, or are they counted as "paused" or "inactive"?
