---
name: crypto-market-regime-analysis
description: >
  Classify the current crypto market regime as risk-on, risk-off, or transitional using a scored indicator set (cycle position, liquidity, stablecoin flows, derivatives positioning, narrative rotation, on-chain versus off-chain agreement, macro correlation), attach a confidence level, and state what would change the read. Use when someone asks whether now is a good time to buy or add, about market cycles or halving dynamics, liquidity conditions, funding rates, open interest, liquidation risk, sector rotation, or why the price moved.
---

# Crypto Market Regime Analysis

Produce a regime classification that a board can act on: a label, a confidence level, the indicators that support it, and the observations that would flip it. The goal is to inform timing and sizing, not to explain the past.

This scorecard is an evidence-organizing heuristic, not a validated forecasting model. Its labels and thresholds do not carry an empirical probability of future returns and must not map directly to a trade or allocation without the portfolio and risk reviews.

## Hard constraint on data

Never state a current price, live funding rate, open interest figure, stablecoin supply number, or any dated fact from memory. List each required data point explicitly and mark it **verified** (supplied by web-researcher or the brief) or **pending**. Run the analysis on verified inputs; if key inputs are pending, lower confidence and say so.

## Step 1 — Score the indicator groups

Score each group **+1** (supports risk-on), **0** (neutral or mixed), or **−1** (supports risk-off). Note the evidence for each score.

| Group | What to look at | Risk-on reads as | Risk-off reads as |
|-------|-----------------|------------------|-------------------|
| Cycle position | Time since protocol supply events, drawdown from prior high, duration and breadth of the current trend | Broad participation and sustained spot demand | Narrow participation, disorderly reversals, or evidence of distribution; calendar analogies alone score 0 |
| Liquidity | Global liquidity direction, real yields, dollar strength, rate expectations | Expanding liquidity, falling real yields | Tightening, rising real yields, strong dollar |
| Stablecoin flows | Net supply change and the verified source, destination, and use of exchange flows | Expanding supply alongside corroborated spot demand | Contraction or redemptions alongside weakening depth; ambiguous transfers score 0 |
| Derivatives positioning | Perp funding, open interest, basis, liquidation cluster density, and spot depth | Balanced leverage with spot-led participation | One-sided or rising leverage against weak spot depth; extreme positioning in either direction is fragility, not a directional signal |
| Narrative rotation | Which sectors are absorbing verified flows and whether participation is broadening | Broadening participation supported by spot volume | Narrow or long-tail leadership without corroborating depth; do not assume a fixed sequence |
| On-chain vs off-chain | Active addresses, transfer volume, exchange balances vs derivatives activity | Both confirm the trend | Derivatives lead with on-chain silent (leverage-driven) |
| Macro correlation | Correlation to equities and risk assets, response to macro prints | Crypto rising with or decoupling positively from risk assets | Crypto selling off harder than risk assets on macro stress |

## Step 2 — Classify

Sum the scores (range −7 to +7).

- **Risk-on:** total ≥ +3 with no group at −1 from the Liquidity or Derivatives rows, as an internal summary label only.
- **Risk-off:** total ≤ −3.
- **Transitional:** anything else, or any case where the two most important groups (Liquidity, Derivatives positioning) disagree with the sum.

A transitional label is a legitimate answer. Do not force a binary call.

## Step 3 — Assign confidence

- **High:** ≥ 5 groups verified, ≥ 5 groups agreeing in direction.
- **Medium:** 3–4 groups verified or moderate disagreement.
- **Low:** fewer than 3 groups verified, or derivatives and liquidity point opposite ways.

## Step 4 — Locate the rotation sequence

Test whether current flows resemble the often-cited **BTC → ETH and majors → large alts → sector narratives → long tail** sequence. Do not assume the sequence exists or unwinds in reverse. State the observed breadth, volume, liquidity, and interval before locating the asset or sector:

- **Early:** flows have not reached this stage; majors still leading.
- **On time:** flows are arriving at this stage with rising participation.
- **Late:** this stage is leading while majors lag or roll — typical of exit-liquidity phases.

## Step 5 — Derive timing implications

Translate the regime into board-usable inputs:

- **Entry-window quality:** favorable / neutral / unfavorable for the specific question.
- **Environmental risk budget:** how much speculative-sleeve exposure the regime can carry (full / reduced / minimal) — the portfolio strategist sizes within it.
- **Positioning risk:** where forced flows sit (liquidation clusters, crowded funding) and which direction a squeeze would run.

## Step 6 — State what would change the read

Name two or three concrete, observable conditions that would flip the classification, and roughly how fast they would appear (days, weeks). Examples of the form:

- Funding turning persistently negative while verified spot demand rises may support a move from risk-off to transitional when other groups corroborate it.
- Stablecoin supply contracting alongside weakening spot depth may weaken a risk-on call; contraction alone is insufficient.
- Long-tail sectors outperforming majors without matching liquidity or breadth may flag fragile rotation rather than prove a cycle stage.

A regime call without flip conditions is incomplete.

## Explaining a price move

When the question is "why did the price move," compare positioning mechanics, spot and stablecoin flows, macro events, and narrative catalysts as competing hypotheses. State the evidence and timing needed for each, reject causal language when the data shows only coincidence, and mark every dated event as pending verification until sourced.

## Output format

```markdown
**Regime:** [Risk-on | Risk-off | Transitional] — Confidence: [High | Medium | Low]

| Group | Score | Evidence | Status |
|-------|-------|----------|--------|
| ... | +1/0/−1 | ... | verified / pending |

**Rotation location:** [Early | On time | Late] — [one line why]
**Entry-window quality:** [...]
**Environmental risk budget:** [Full | Reduced | Minimal]
**Positioning risk:** [...]
**What would change the read:** 1. ... 2. ... 3. ...
**Pending verification:** [list]
```

## Anti-patterns

- Calling a regime from price alone.
- Using a cycle analogy as if it were an indicator.
- Quoting funding or OI figures from memory.
- Giving a price target or a date.
- Omitting the flip conditions.
