---
name: crypto-position-sizing
description: >
  Calculate conditional crypto position sizes from an explicitly approved loss
  budget, conservative executable-loss scenarios, current portfolio exposure,
  liquidity, and completed diligence and risk reviews. Use when asked how much
  to buy, whether a cleared asset fits the portfolio, how to rebalance, or how
  staged entry and invalidation choices change the amount at risk.
---

# Crypto Position Sizing

## Purpose

Size from loss capacity rather than upside. A numeric recommendation is allowed only after the user has affirmed the relevant loss budget and the required board reviews are complete. Otherwise return labelled scenarios that expose the missing decision without selecting one.

## Preconditions

All must be present before a recommendation:

1. **User-approved constraints:** Crypto-book size, position loss budget, liquidity needs, time horizon, and any relevant tax, custody, or leverage constraints.
2. **Diligence:** Asset and protocol findings, including unknowns and severity, not merely a score.
3. **Risk clearance:** Custody, counterparty, regulatory or tax uncertainty, scam, and wallet-security blockers.
4. **Contrarian review and dated facts:** Material objections recorded and current inputs sourced.
5. **Portfolio policy:** Remaining bucket and shared-factor capacity.
6. **Market assessment:** Conditional regime evidence and what would change it; no automatic multiplier.
7. **Invalidation and exit mechanics:** A thesis condition plus a realistic estimate of loss if exit occurs late or cannot execute.

If any item is missing, return **PENDING** with scenarios only.

## Method

### 1. Choose a conservative loss fraction

For each plausible exit path, estimate the fraction of the position that could be lost after slippage, gaps, fees, taxes, lockups, depegs, contract failure, or total loss. Use 100% for any path where capital can become unrecoverable. Do not treat a stop price as executable when liquidity cannot support the proposed size.

### 2. Calculate the loss-budget ceiling

```text
loss-budget ceiling = user-approved position loss budget / conservative loss fraction
```

Example: if the user has affirmed a 0.5% book-level loss budget and the conservative executable-loss fraction is 50%, the loss-budget ceiling is 1% of the book. This is arithmetic, not a recommendation.

### 3. Apply independent ceilings

The candidate size cannot exceed the smallest of:

- loss-budget ceiling;
- remaining bucket capacity;
- ticker concentration limit;
- shared-factor concentration limit;
- liquidity and slippage capacity;
- custody, venue, jurisdiction, or tax constraint;
- any user-approved regime rule.

Show every ceiling, its source, and which one binds. A diligence score may affect the scenario assumptions or block eligibility, but it does not map mechanically to a percentage.

### 4. Model dependence and correlation

Use dated measurements over more than one relevant window where available. Correlation and beta are estimates that can change sharply during stress. Also map shared bridges, oracles, exchanges, stablecoins, ecosystems, and counterparties that return data misses. If measurements are unavailable, do not substitute a category label as fact; present a conservative shared-factor scenario.

### 5. Compare execution choices

For a single entry and any staged alternative, show:

- entry condition and amount;
- expected fees, slippage, tax or reporting implications, and operational complexity;
- what new evidence a later tranche waits for;
- maximum loss if the adverse event occurs before all tranches or between them.

Staging is not automatically safer. It may reduce timing concentration while increasing costs or leaving the user exposed during later entries.

### 6. Separate thesis invalidation from order mechanics

An invalidation trigger states why the thesis is wrong. An executable exit plan states how the position can be reduced under actual liquidity and custody constraints. Record both. For illiquid, locked, bridged, or contract-dependent assets, include a scenario where exit is unavailable.

### 7. Return recommendation or scenarios

- **Recommendation:** Only when all preconditions are met. State size as a maximum under the named assumptions, not a promise of suitability or return.
- **Scenarios:** When a material input is missing, show at least three neutral labels such as lower-loss, middle-loss, and higher-loss. For each, state the assumed loss budget and resulting ceiling. Do not select one for the user.

## Output

- **Gate status:** CLEARED or PENDING, with missing items.
- **User-approved loss budget:** Percent of book and dollars when supplied.
- **Loss scenarios:** Trigger, conservative loss fraction, liquidity assumptions, and evidence status.
- **Ceiling table:** Each independent cap, source, and binding constraint.
- **Maximum conditional size:** Or neutral scenario range if constraints are incomplete.
- **Execution comparison:** Single entry and staged alternatives with conditions and costs.
- **Invalidation and exit:** Thesis trigger, executable plan, and no-exit scenario.
- **Residual risks:** What remains even if every condition is followed.
- **Professional-review questions:** Financial or tax choices requiring a qualified adviser.

## Red Lines

- Do not choose the user's acceptable loss, allocation profile, reserve floor, take-profit ladder, or minimum meaningful position.
- Do not use a diligence score, market label, or arbitrary beta threshold as a direct sizing table.
- Do not imply a stop order caps loss where gaps, liquidity, custody, or contract failure can prevent execution.
- Do not recommend action before all required reviews and material user constraints are present.
- Do not present the calculation as personalized professional financial or tax advice.
