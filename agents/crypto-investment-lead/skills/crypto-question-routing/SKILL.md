---
name: crypto-question-routing
description: >
  Reframe an incoming crypto question as an investment decision, classify it
  into one of seven categories (majors thesis, early-stage candidate, DeFi
  yield, market timing, portfolio fit, risk-compliance, mixed), and decide
  which board seats to convene and in what order. Use on every new question
  reaching the crypto investment board, whenever a scout surfaces a candidate,
  or when a specialist output raises a follow-up that needs re-routing.
---

# Crypto Question Routing

## Purpose

Turn a raw question into a decision the board can actually deliberate, then pick the smallest set of seats that can decide it well. Over-convening wastes the board's attention; under-convening skips the seat whose objection would have changed the answer.

## Step 1 — Reframe as a decision

Write three sentences before classifying anything:

1. **The decision:** "Should we [hold / add / trim / exit / pass on / size] [asset or position] [in which book]?"
2. **The downside:** name the worst realistic outcome and its type — drawdown, illiquidity trap, smart-contract loss, regulatory freeze, or total loss.
3. **The invalidation:** one observable event that would prove the thesis wrong.

If the request is purely "how does X work" with no decision attached, mark it EDUCATIONAL and route to `blockchain-fundamentals` and the explainer only.

## Step 2 — Classify

| Category | Signals | Book |
| --- | --- | --- |
| Majors thesis | BTC, ETH, top-tier L1s; multi-year horizon; monetary premium, security budget, adoption | Long-term |
| Early-stage candidate | New token, small cap, scout-surfaced, pre-listing, airdrop, narrative play | Speculative sleeve |
| DeFi yield | Staking, lending, LP, restaking, yield source and counterparty questions | Either — determine by asset |
| Market timing | "Is now a good time," cycle position, macro, halving, ETF flows | Cross-cutting |
| Portfolio fit | Allocation between books, correlation, rebalancing, concentration | Cross-cutting |
| Risk-compliance | Custody, jurisdiction, tax, sanctions, exchange counterparty | Cross-cutting |
| Mixed | Two or more of the above with no clear primary | Split into sub-questions |

For MIXED, decompose into the component questions and route each separately; synthesize into one decision record at the end.

## Step 3 — Convene

Mandatory on every non-educational question:

- **Contrarian** — always. No exceptions.
- **Web-researcher (dated-fact verification)** — whenever a material fact is current or could have changed since the cited source. Do not use an arbitrary age cutoff in place of judging the claim.

Category-driven additions:

| Category | Convene | Usually skip |
| --- | --- | --- |
| Majors thesis | Diligence (fundamentals), portfolio strategist, risk | Discovery scout |
| Early-stage candidate | Diligence, risk, contrarian, web-researcher — all four must record before portfolio strategist | None; full gate applies |
| DeFi yield | Diligence (contract and counterparty), risk, web-researcher | Scout |
| Market timing | Contrarian, web-researcher, portfolio strategist | Diligence unless asset-specific |
| Portfolio fit | Portfolio strategist, risk, contrarian | Scout, diligence |
| Risk-compliance | Risk, web-researcher, contrarian | Scout |

## Step 4 — Order of speaking

1. Fact-setting seats first (web-researcher, diligence) so the board argues from dated evidence.
2. Bull owner, then bear owner, then contrarian.
3. Risk states custody, counterparty, regulatory, tax, scam, and security blockers.
4. Portfolio strategist sizes last, only once the gate is satisfied and the user's risk constraints are known.

## Step 5 — Record the routing

Emit a short routing block:

```
Reframed decision: ...
Downside type: ...
Invalidation: ...
Category: ...
Book: ...
Convened (in order): ...
Excluded and why: ...
Gate status (early-stage only): diligence [ ] risk [ ] contrarian [ ] dated-fact [ ]
```

## Anti-patterns

- Routing on the asset name instead of the decision. "ETH" can be a majors thesis, a DeFi yield question, or a timing question.
- Skipping the contrarian because the answer seems obvious.
- Letting a scout name skip straight to sizing because it is "moving fast."
- Treating a MIXED question as a single deliberation; it produces mush.
