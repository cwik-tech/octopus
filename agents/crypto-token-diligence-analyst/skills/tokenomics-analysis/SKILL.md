---
name: tokenomics-analysis
description: >
  Read a token's supply schedule, emissions, burns, governance rights, treasury, and value-accrual
  mechanism, then test the stated narrative against on-chain usage and flag tokens with no economic
  reason to hold value. Use when asked about tokenomics, supply, inflation, unlocks, vesting, FDV
  versus market cap, fee switches, buybacks, staking rewards, governance power, or "why is this
  token worth anything", for any major, established protocol, or early-stage token that has passed
  its structural gates.
---

# Tokenomics Analysis

Answer one question: **does this token have a durable, mechanically enforced reason to hold value, and is real usage consistent with the story?** Work through the sections in order; each produces a finding marked *verified* (from supplied on-chain data or primary documents) or *claimed* (team, scout, or third-party assertion).

## 1. Supply picture

| Item | What to establish | Why it matters |
| --- | --- | --- |
| Max / total / circulating supply | The three numbers and whether max is capped or open | Uncapped supply needs a burn or sink to avoid perpetual dilution |
| FDV vs market cap ratio | Circulating as % of total; FDV multiple | A low circulating fraction means more potential future supply; timing, recipients, liquidity, and demand determine whether it becomes sell pressure |
| Emission schedule | Annual inflation now, in 1 year, in 3 years; who receives emissions | Emissions paid to insiders or mercenary LPs are sell pressure, not adoption |
| Unlock calendar | Next 12 months of cliffs and linear unlocks by recipient category | Large cliffs are dated selling events; note if unlocks exceed average daily volume |
| Burn / sink mechanisms | What removes supply, whether it is usage-driven or discretionary | A usage-driven burn ties value to activity; a discretionary one is a promise |

State the net inflation after burns. If it cannot be computed from supplied data, mark the whole supply picture *claimed*.

## 2. Allocation and vesting

- Team, investors, foundation/treasury, community, ecosystem incentives, public sale: percentages and vesting terms.
- Compare stated vesting to on-chain balances where addresses are known. Discrepancy is a red flag.
- Report category concentration, team and investor control, and dated cliffs. Apply a numeric warning threshold only when the board has adopted it, and show the raw values so the conclusion does not depend on the label.

## 3. Value-accrual mechanism

Identify the mechanism that converts protocol activity into token demand or supply reduction. Exactly one or more of:

1. **Fee capture** — fees paid in or converted to the token, distributed to stakers or used for buybacks. Verify a fee switch is on, not merely governance-enabled.
2. **Burn on usage** — activity destroys tokens (e.g. base-fee burn).
3. **Required collateral or gas** — the token must be held or spent to use the network.
4. **Governance with economic stakes** — governance controls real cash flows or parameters that matter.
5. **Staking for security** — yield paid from real fees rather than inflation.

If the only claimed mechanism is governance with no demonstrated economic control or staking rewards funded only by new emissions, record: **no demonstrated required-use or cash-flow value accrual**. List any other demand thesis separately and mark its evidence status.

## 4. Governance and treasury

- Who can change emission, fees, or treasury spend; quorum and voter concentration; whether decisions are enforced on-chain or by a multisig.
- Treasury size, composition, runway, liquidity, and spending authority. A treasury concentrated in its own token is reflexive and may have far less realizable value than its marked balance.

## 5. Usage versus narrative

Build a two-column comparison: the adoption story vs the on-chain measure.

| Narrative claim | On-chain test |
| --- | --- |
| "Growing users" | Active addresses excluding airdrop farmers; retention |
| "High TVL" | TVL excluding the protocol's own token and incentive-farmed deposits |
| "Revenue-generating" | Fees paid by users vs emissions paid to users; net of incentives |
| "Strong community" | Governance participation, developer activity, not follower counts |

Record each divergence. Two or more material divergences is a red flag.

## 6. Competitive position

Name direct competitors, the switching cost for users, and whether the token is essential to the product or bolted on. A product that would work identically without its token gets no value-accrual credit.

## Output of this skill

- Net inflation estimate and 12-month unlock summary (verified/claimed)
- Named value-accrual mechanism, or the explicit statement that none exists
- Governance and treasury control summary
- Usage-vs-narrative divergences
- Tokenomics red flags, ranked
- Claims requiring verification, phrased as checkable statements for a researcher
