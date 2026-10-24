---
name: early-stage-token-diligence
description: >
  Checklist-driven structural assessment of a young token across contract control, audit status,
  liquidity locks, vesting cliffs, team identity, holder concentration, and protocol risk, with
  hard gates that stop the review on disqualifying findings. Use when the discovery scout hands
  over a candidate, when any token is under roughly one year old, or when asked about rug risk,
  admin keys, upgradeability, liquidity lock, honeypot, holder distribution, or whether a new
  project is safe to consider at all.
---

# Early-Stage Token Diligence

A candidate must clear every **hard gate** before any tokenomics or narrative work is done. A hard-gate failure is the primary red flag and caps the diligence score at 3. Every item is recorded as PASS, FAIL, or UNVERIFIED. **UNVERIFIED counts as FAIL for scoring** until `web-researcher` confirms it. Numeric thresholds are board screening policies, not universal proof of safety. Use user-approved thresholds when supplied; otherwise report the raw value, compare multiple scenarios, and mark the policy choice pending.

## Section A — Contract control (hard gates)

| # | Check | Pass condition |
| --- | --- | --- |
| A1 | Source verified | Contract source is verified on the relevant explorer and matches deployed bytecode |
| A2 | Audit | A named firm, a readable report, scope covering the deployed contracts, and all critical/high findings resolved. "Audited" with no report = FAIL |
| A3 | Upgradeability | Identify every upgrade authority, signer threshold, timelock, emergency bypass, and exercised history. Immediate single-key control = FAIL; any numeric minimum must come from an explicit board policy |
| A4 | Mint authority | No unlimited mint, or mint restricted to a governed, timelocked contract |
| A5 | Pause / blacklist / fee-change | Absent, or held by a timelocked multisig; any owner-settable transfer tax or blacklist is a FAIL unless justified and governed |
| A6 | Honeypot / transfer restrictions | Sells are not restricted; no hidden max-sell, cooldown, or whitelist |

## Section B — Liquidity (hard gates)

| # | Check | Pass condition |
| --- | --- | --- |
| B1 | Liquidity depth | Enough depth that a position of the strategist's likely size can exit with tolerable slippage; state the figure as UNVERIFIED if not supplied |
| B2 | LP control | Identify who can remove or migrate liquidity, including concentrated-liquidity positions and protocol-owned liquidity. A lock or burn is evidence, not a guarantee; team-controlled immediate removal = FAIL |
| B3 | Liquidity ownership | Team or deployer does not control the majority of LP |
| B4 | Venue | Venue identity, contract, exit depth, withdrawal or settlement behavior, and counterparty risks are verified. Reputation alone is not a pass |

## Section C — Team and provenance

| # | Check | Pass condition |
| --- | --- | --- |
| C1 | Identity | Team members identifiable with checkable prior work. Anonymous is not automatic FAIL but is a red flag and shifts all C items to UNVERIFIED |
| C2 | Track record | No prior abandoned or exploited projects, or a credible explanation |
| C3 | Deployer history | Deployer address has no history of rugged contracts |
| C4 | Raise and investors | Amounts, valuation, and investor names reconcile with public statements |

## Section D — Holder distribution and vesting

| # | Check | Pass condition |
| --- | --- | --- |
| D1 | Top-holder share | Report concentration after classifying known contracts, custodians, bridges, vesting wallets, and related wallets; apply only a stated board threshold |
| D2 | Single-wallet share | Report the largest controllable position and plausible common control; do not assume separate addresses mean separate owners |
| D3 | Team + investor allocation | Report allocation, enforceability, recipients, and vesting; concentrated insider exposure is a risk even when the schedule is on-chain |
| D4 | Unlock cliffs | Report each material unlock against circulating supply, liquidity, recipient incentives, and plausible demand; attach dates instead of using one universal cutoff |
| D5 | Airdrop / farmer concentration | Airdropped supply is not the majority of active holders |

## Section E — Protocol and product risk

| # | Check | Pass condition |
| --- | --- | --- |
| E1 | Product exists | Something is live and used, not only a roadmap |
| E2 | Dependency risk | Critical dependencies (oracles, bridges, base protocols) named with their own risk noted |
| E3 | Economic design | Yield or reward sources named; refer to `defi-and-stablecoin-mechanics` for anything yield-bearing |
| E4 | Regulatory surface | Obvious securities-like structure or sanctioned-jurisdiction exposure noted |
| E5 | Narrative dependency | The project's value does not rest solely on a currently rotating narrative |

## Scoring rule

- Any FAIL in Sections A or B → hard-gate failure; score ≤ 3; state which gate.
- Two or more UNVERIFIED hard gates → treat as hard-gate failure until verified.
- All hard gates PASS with ≤2 red flags elsewhere → eligible to proceed to `tokenomics-analysis` and speculative-sleeve consideration.
- Otherwise → eligible only after specified verifications.

## Output of this skill

- Checklist table with PASS / FAIL / UNVERIFIED per item
- Hard-gate verdict and the specific failing item
- Red flags ranked by severity
- Numbered list of UNVERIFIED items rewritten as checkable statements for a researcher
- Eligibility note: proceed, proceed-after-verification, or reject
