---
name: defi-and-stablecoin-mechanics
description: >
  Trace where a DeFi yield actually comes from and enumerate the failure modes of AMMs, lending
  markets, yield aggregators, liquid staking, and stablecoin designs including the specific depeg
  path. Use when the asset or opportunity involves DeFi, staking yield, LP positions, lending or
  borrowing, restaking, real-yield claims, algorithmic or collateralized stablecoins, or when the
  board asks about depeg risk or why an APY is so high.
---

# DeFi and Stablecoin Mechanics

Every yield has a payer and every peg has a defender. This skill names both and lists how each fails. Record findings as *verified* or *claimed*.

## 1. Yield source decomposition

Break any advertised APY into its economic components. Start with these common categories and add any source that does not fit instead of forcing it into the table:

| Source | Who pays | Durability | Note |
| --- | --- | --- | --- |
| Trading fees | Traders | Tied to volume and fee policy | External fee revenue only to the extent volume and distribution are verified |
| Borrow interest | Borrowers or incentive programs | Tied to borrowing demand and subsidies | Separate borrower-paid interest from token incentives |
| Protocol revenue share | Product users | Tied to usage and enforceable distribution | Verify the fee switch, claim priority, costs, and who can change it |
| Token emissions | Existing holders through dilution | Depends on the issuance schedule and token demand | Nominal yield; not net value creation by itself |
| Liquidation, MEV, incentives, or other transfers | Identify the payer | Source-specific | State whether it is recurring, subsidized, adversarial, or correlated with losses |
| Leverage / recursion | Not an independent payer | Ends or reverses under deleveraging | Amplifies the underlying sources and failure paths |

State the percentage of the advertised APY funded by emissions and show both token units and a value scenario. If the majority is emissions in the protocol's own token, record: **nominal yield is primarily dilution-funded**. If the source cannot be named, record: **unexplained return — unverified and blocking**. Do not label fraud without evidence of deception.

## 2. Failure modes by primitive

**AMMs / LP positions**
- Impermanent loss versus fees earned; state break-even volatility if data allows
- Pool token composition — a pool paired against the protocol's own token doubles the exposure
- Concentrated liquidity ranges that fall out of range
- Router or pool contract upgradeability (defer to `early-stage-token-diligence` gates)

**Lending markets**
- Bad-debt path: collateral drops faster than liquidations execute; oracle lag or manipulation
- Isolated vs cross-collateral; which assets can be borrowed against which
- Utilization spikes trapping lenders (cannot withdraw at 100% utilization)
- Governance-listed long-tail collateral as a tail-risk path through oracle manipulation, thin liquidation markets, and bad debt

**Yield aggregators / vaults**
- Strategy opacity: what the vault actually does with deposits
- Stacked contract risk: every underlying protocol's risk is inherited
- Withdrawal queues and gating under stress

**Liquid staking / restaking**
- Validator slashing and operator concentration
- LST/LRT discount to underlying during exit queues
- Rehypothecation depth: how many layers of claims sit on the same underlying

**Bridges and wrapped assets**
- Custodial vs light-client; who holds the keys or the proofs
- A wrapped asset adds bridge, validator, operator, or custodian risk on top of the underlying asset risk

## 3. Stablecoin design and depeg path

Classify the design, then trace the exact sequence of a depeg.

| Design | Peg defender | Primary depeg path |
| --- | --- | --- |
| Fiat-backed | Issuer's reserves and redemption | Reserve opacity, banking partner failure, redemption freeze, blacklisting |
| Overcollateralized crypto-backed | Liquidation engine and collateral haircuts | Collateral crash outpacing liquidations; oracle failure; collateral itself is a stablecoin (circular) |
| Delta-neutral / basis-trade | Funding rates and exchange counterparties | Negative funding for extended periods; exchange insolvency; hedge cannot be unwound |
| Algorithmic / endogenous collateral | Arbitrage against the protocol's own token | Reflexive death spiral when the backing token falls; no exogenous value to stop it |
| Hybrid | Combination | Components can fail independently or reinforce one another; test the combined stress path |

For each stablecoin under review state: collateral composition and quality, redemption mechanism and who can use it, historical worst deviation from peg, and what the redemption queue looks like under a run. Endogenous-collateral designs require an explicit reflexive-death-spiral stress test and remain blocked until the board records why exogenous support or controls can interrupt it.

## 4. Stress narrative

Write the two-to-four-sentence story of how this specific position loses most of its value: the trigger, the mechanism, the speed, and whether an exit is possible mid-event. If no plausible loss story can be written, the analysis is incomplete, not the position safe.

## Output of this skill

- Yield decomposition with emissions percentage and a real-yield verdict
- Applicable primitive failure modes, ranked by likelihood × severity
- Stablecoin classification and depeg path where relevant
- Stress narrative
- Claims requiring verification (reserve attestations, audit reports, funding-rate history, on-chain collateral ratios) phrased for a researcher
