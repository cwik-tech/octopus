---
name: replacement-cost-stress-test
description: >
  Apply the Buffett discipline of pricing every real estate asset against the cost to rebuild it
  from scratch. The ratio of purchase price to replacement cost sets a ceiling on long-run
  downside: below replacement cost, new supply cannot profitably undercut you; at or above it, you
  are buying a liability disguised as an asset. Use when setting a purchase price, judging
  downside protection, or testing how exposed an asset is to newly built competing supply.
---

# Replacement Cost Stress Test

## Purpose

Every real estate deal has a hidden anchor: the cost to rebuild it from scratch today. Buyers routinely ignore this anchor because brokers do not quote it. This skill forces it to the front of the analysis and uses it as the primary discipline for pricing.

## Protocol

### Step 1: Compute Purchase Price Per Square Foot

Divide the all-in acquisition cost (purchase price, closing costs, required day-one capex, acquisition fees) by the leasable square footage. Call this `P`.

### Step 2: Compute Current Replacement Cost Per Square Foot

Add:

- **Hard costs** (construction, per current local bids — not two-year-old estimates)
- **Soft costs** (design, permits, legal, financing costs during construction)
- **Land cost** (current market value of comparable fully-entitled parcels in this submarket)
- **Developer overhead and profit** (normally 10–20% of hard costs)
- **Time value** (the carry cost of the project over the realistic delivery timeline)

Call this total `R`.

Use local construction data — do not use national averages. If a general contractor cannot give you a confident number for new construction of this asset class in this submarket today, you are not ready to evaluate this deal.

### Step 3: Compute the Ratio

`ratio = P / R`

### Step 4: Interpret the Ratio

| Ratio | Meaning | Buffett's typical response |
|-------|---------|----------------------------|
| < 0.60 | Deep discount to replacement | Aggressive interest — assuming tenant and location hold up |
| 0.60–0.80 | Comfortable discount | Proceed with normal diligence |
| 0.80–0.85 | Marginal | Proceed only if the location moat is exceptional |
| 0.85–1.00 | At or near replacement | Walk unless there is an irrefutable reason to stay |
| > 1.00 | Above replacement | Walk — you are paying someone else to build competing supply |

### Step 5: Adjust for Land Scarcity and Obsolescence

The raw ratio is not the full picture. Adjust:

- **Land scarcity up:** If the site is genuinely irreplaceable (downtown waterfront, zoning-constrained trophy parcel), the ratio can run higher than the table suggests. You are paying a premium for an option nobody else can ever exercise.
- **Functional obsolescence down:** If the existing building has a plan, ceiling height, or mechanical layout that would not be built today, discount its replacement value. You are buying a structure that is partly already a teardown.
- **Environmental or entitlement friction:** If rebuilding today would be legally or practically difficult (historic district, coastal regulations, permitting gauntlet), the replacement cost is effectively higher than the raw number, and your ratio should be adjusted accordingly.

### Step 6: State the One-Sentence Verdict

Write one sentence stating the ratio, the adjustment, and whether the position clears the threshold:

> "At $[P]/sf versus $[R]/sf replacement cost, this asset trades at [ratio], adjusted to [adjusted ratio] for [factor]. [Buy / proceed / walk]."

## When to Apply

Apply to every real estate deal the crew evaluates, without exception. Stabilized, value-add, development-to-hold, portfolio acquisitions, recapitalizations — all of them.

## When Not to Apply

This skill addresses the price anchor and downside floor. It does not speak to cash flow, tenant credit, or macro regime. Combine with the crew's other tools — do not use in isolation.

## Output Format

A single paragraph stating `P`, `R`, raw ratio, adjustment, and verdict. If `ratio > 0.85`, explicit justification is required for why the deal should proceed.
