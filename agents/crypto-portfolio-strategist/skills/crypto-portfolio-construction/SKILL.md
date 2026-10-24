---
name: crypto-portfolio-construction
description: >
  Build a crypto portfolio policy from user-approved loss capacity, liquidity
  needs, time horizon, concentration limits, custody constraints, rebalancing
  rules, and stress scenarios without inventing allocation defaults. Use when
  setting up or reviewing a portfolio, or when drift, concentration, liquidity,
  or drawdown may have breached its standing rules.
---

# Crypto Portfolio Construction

## Purpose

Write the standing portfolio rules in calm conditions so later decisions do not improvise risk tolerance under pressure. This skill does not infer how much loss a user can bear and does not treat stablecoins as cash. It derives a policy from explicit constraints or, when they are missing, compares labelled scenarios without choosing one.

## Required Inputs

| Input | Why it matters |
|-------|----------------|
| Capital allocated to crypto | Denominator for book-level limits |
| Relationship to the user's broader finances | Tests whether crypto loss threatens near-term obligations |
| Liquidity needs and time horizon | Prevents locking or risking money needed soon |
| Maximum crypto-book and position loss the user explicitly accepts | Anchors the stress budget |
| Existing positions, venues, wallets, and liabilities | Reveals concentration, leverage, custody, and tax constraints |
| Governing jurisdiction and account or entity type where material | Identifies legal and tax questions for the risk seat |
| Current review packet | Diligence, risk, contrarian, market, and dated-fact inputs |

Do not invent a missing value. Mark the recommendation **PENDING** and provide scenarios showing how the missing choice changes the result.

## Procedure

### 1. Establish the loss boundary

- Keep emergency funds, near-term liabilities, and money the user cannot afford to lose outside the crypto risk budget.
- Record the maximum book-level loss and position-level loss the user has explicitly affirmed.
- Separate willingness to tolerate volatility from financial capacity to absorb permanent loss.
- If these differ, the lower capacity governs the analysis.

### 2. Define functional buckets

Use buckets only when they match the user's purpose:

- **Core thesis:** Longer-horizon assets reviewed under an explicit thesis and invalidation rule.
- **Speculative sleeve:** Positions modeled under a total-loss scenario.
- **Reserve:** Optional liquidity for future decisions. A stablecoin or custodial balance still carries issuer, depeg, venue, and access risk and must pass risk review.

The labels do not supply percentages. Derive ranges from the loss boundary and stress tests.

### 3. Run stress scenarios

At minimum model:

1. Core assets suffer a severe historical or user-selected drawdown.
2. Every speculative position goes to zero together.
3. The reserve suffers a stated stablecoin, custody, or access loss.
4. Correlated positions decline together while liquidity and exit depth worsen.
5. Any leverage or borrowing reaches its liquidation or repayment condition.

For each assumption, cite the source or label it as a scenario rather than a forecast. The proposed allocation must remain within the user's affirmed book-level loss under the combined scenario they choose.

### 4. Set concentration constraints

Measure exposure by both ticker and shared failure factor:

- base-asset beta and ecosystem dependence;
- common bridge, oracle, custodian, exchange, or stablecoin;
- narrative and liquidity source;
- common governance, treasury, or counterparty.

Ask the user to approve the maximum exposure to each material factor. If no cap exists, compare at least three labelled cap scenarios and show the stress loss under each; do not name one "balanced" or "recommended."

### 5. Define rebalancing and exit rules

Record:

- target ranges and the user-approved drift that triggers review;
- review cadence and the events that require an unscheduled review;
- whether rebalancing uses new contributions, sales, or both;
- liquidity, fees, taxes, lockups, and slippage that may make a rule impractical;
- thesis invalidation, risk-clearance withdrawal, and position-cap breaches;
- any profit-taking rule the user explicitly chooses.

Do not supply a universal take-profit ladder, calendar, or drawdown response. Show how candidate rules would have behaved under multiple scenarios, including whipsaw and tax costs.

### 6. Define market-regime handling before use

A regime label may inform a pre-agreed rule but does not determine allocation by itself. If the user wants regime scaling, document the exact scale, evidence threshold, maximum change, and review trigger before applying it. Without that policy, show regime effects as scenarios only.

## Output

- **Decision status:** READY or PENDING, with missing user choices named.
- **Loss boundary:** Book-level and position-level limits explicitly affirmed by the user.
- **Buckets:** Purpose and derived allocation ranges, not generic profile defaults.
- **Stress table:** Scenario, assumption source, portfolio loss, liquidity impact, and breached constraint.
- **Concentration map:** Ticker and shared failure-factor exposures.
- **Standing rules:** Rebalancing, invalidation, review, and optional profit-taking rules with costs and exceptions.
- **Scenario comparison:** At least three labelled alternatives when a material constraint is missing; no preferred option selected.
- **Professional-review questions:** Material financial, legal, or tax decisions outside the board's competence.

## Red Lines

- Do not infer loss capacity, net worth, liquidity needs, or risk tolerance.
- Do not call a generic allocation conservative, balanced, aggressive, safe, or suitable for the user.
- Do not treat stablecoins or exchange balances as risk-free reserves.
- Do not turn a market-regime label or diligence score into an allocation percentage through a fixed multiplier.
- Do not recommend action while a material user constraint or required specialist review is missing.
