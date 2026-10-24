---
name: crypto-market-structure
description: >
  Explain how crypto markets mechanically work — exchange types, custody models, order flow and market making, derivatives venues, basis and funding mechanics, liquidation engines, and the structural drivers of volatility — and use those mechanics to account for price behavior before reaching for narrative. Use when someone asks how an exchange or custody arrangement works, what funding or open interest means, why crypto is so volatile, what a liquidation cascade is, or when a price move needs a mechanical rather than a story-based explanation.
---

# Crypto Market Structure

Provide mechanical explanations of how crypto markets function so the board can distinguish structural price behavior from fundamental or narrative change. Explain to inform decisions: every explanation should end with what it implies for timing, risk, or execution.

## Data discipline

Do not cite current prices, live funding rates, volumes, or dated events from memory. Describe the mechanism; mark any specific figure the board needs as **pending verification** by web-researcher.

## 1. Venues

| Venue type | Mechanics | Structural implications |
|------------|-----------|-------------------------|
| Centralized spot exchange | Central limit order book, exchange holds custody, fiat and stablecoin rails | Counterparty and custody risk; depth concentrated on a few venues; withdrawal halts are a systemic signal |
| Centralized derivatives | Perpetual swaps, futures, options; cross- and isolated-margin; liquidation engine | Leverage amplifies moves; funding and OI are the observable positioning data |
| Decentralized exchange (AMM) | Liquidity pools, constant-product or concentrated liquidity, no custody | Slippage scales with pool depth; thin pools make long-tail tokens easy to move; MEV and sandwiching affect execution |
| Decentralized perps | On-chain order books or vAMMs with oracle-based liquidation | Oracle lag and thin insurance funds create tail risk during cascades |
| OTC desks | Bilateral block trades, off-book | Large flows can move without visible order-book prints; explains "invisible" accumulation or distribution |

## 2. Custody

- **Exchange custody:** the venue controls the keys and the user's legal and operational rights depend on the named entity and terms. Proof-of-reserves can show selected assets but does not by itself establish liabilities, segregation, solvency, or recovery rights.
- **Regulated or qualified custodians:** the label and required safeguards depend on jurisdiction and client type. Verify segregation, insurance scope and exclusions, sub-custodians, and insolvency treatment instead of assuming protection.
- **Self-custody:** hardware or software wallets remove some venue risk but add key-loss, malware, inheritance, and signing risk. Exchange outflows alone do not prove reduced selling intent.
- **ETF and wrapper custody:** creations, redemptions, cash settlement, intermediaries, and hedging can connect traditional-market flows to spot demand differently by product; verify the mechanism before inferring a lag.

Implication: exchange balance direction is a supply-side signal; custody concentration is a systemic-risk input.

## 3. Order flow and market making

- Market makers quote both sides and hedge across venues; they widen or pull quotes in stress, which is why depth vanishes exactly when it is needed.
- Spot depth relative to derivatives open interest determines how much a forced flow moves price.
- Large-holder behavior, OTC prints, and ETF flows can dominate marginal price without appearing in visible books.

Implication: a move on thin depth is less informative than the same move on deep books.

## 4. Derivatives mechanics

- **Perpetual funding:** a contract-specific periodic transfer intended to help keep the perp near its index. In many venues positive funding means longs pay shorts, but verify the venue convention. Extreme funding can indicate stretched positioning without predicting the next direction.
- **Open interest (OI):** total outstanding contracts. Every contract has both a long and a short, so rising OI shows more paired exposure, not "new longs" or "new shorts" by itself. Combine it with price, funding, order flow, liquidations, and spot volume.
- **Basis:** the difference between futures and spot. Cash-and-carry and its unwind can affect both legs, but basis compression alone does not identify who removed liquidity or why.
- **Liquidation engines:** when margin falls below maintenance, the venue force-closes the position at market, which pushes price toward the next cluster of stops. This is the mechanism behind cascades.
- **Options:** dealer gamma positioning can pin or accelerate price near large strikes around expiry.

Implication: funding, OI, depth, and liquidation clusters can show where forced flows may amplify a move. They do not establish the catalyst or magnitude without observed executions and spot context.

## 5. Structural volatility drivers

1. 24/7 trading with no circuit breakers.
2. High leverage availability relative to spot depth.
3. Reflexive collateral — tokens used as margin for positions in the same tokens.
4. Concentrated holders and thin long-tail liquidity.
5. Stablecoin and oracle dependencies that fail correlated.
6. Fragmented venues that arbitrage imperfectly in stress.

## 6. Explaining a price move mechanically

Work through this checklist before accepting a narrative explanation:

1. Did OI drop sharply, and do liquidation or trade records show forced closing rather than voluntary deleveraging?
2. Did funding flip or reset, and did prices diverge across spot and perpetual venues in a way consistent with a squeeze?
3. Did basis compress, and is there evidence that cash-and-carry positions unwound?
4. Did exchange balances or stablecoin flows shift, and can the destination and transaction purpose support a spot-flow inference?
5. Was the move venue-specific or broad, and did arbitrage close the difference?
6. Which event or narrative coincided, and is there evidence it caused flows rather than merely arriving at the same time?

## Output format

```markdown
**Mechanism:** [what structurally happened or how the thing works]
**Evidence for the mechanism:** [OI, funding, basis, flows — verified or pending]
**What it is not:** [the narrative explanation this mechanism displaces or downgrades]
**Implication for the board:** [timing, risk, or execution consequence]
**Pending verification:** [list]
```

## Anti-patterns

- Explaining a liquidation cascade as "the market lost faith."
- Treating exchange volume as if it were all real spot demand.
- Ignoring venue and custody risk when discussing a token's liquidity.
- Quoting live figures from memory.
