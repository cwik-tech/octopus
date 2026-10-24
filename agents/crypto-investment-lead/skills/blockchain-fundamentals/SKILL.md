---
name: blockchain-fundamentals
description: >
  Explain how blockchain technology works at the level an investor needs —
  consensus mechanisms, wallets and keys, smart contracts, L1 versus L2,
  bridges, token supply mechanics — and connect each concept to the risk it
  creates for a position. Use when the user asks how X works, when a
  specialist answer assumes basics the user lacks, or when a decision record
  needs a fundamentals section for a newcomer.
---

# Blockchain Fundamentals

## Purpose

Give the user enough of the machinery to understand why a risk exists, not to become an engineer. Every explanation ends by naming the investment consequence. If a concept has no investment consequence for the question at hand, it is can-skip.

## Method

1. Identify which concept the user is missing from the way they phrased the question or from the jargon in the specialist's answer.
2. Explain it in the three-layer pattern below.
3. Hand the output to `crypto-plain-language-explainer` for the analogy and need-to-know split.

**Three-layer pattern for every concept:**
- **What it is** — one or two sentences, no jargon that has not itself been defined.
- **Why it works that way** — the design problem it solves.
- **Why an investor cares** — the specific risk or value driver it creates.

## Core concepts and their investment consequences

### Consensus (how the network agrees)
- **Proof of work:** miners spend energy to propose blocks; security is bought with electricity. Consequence: security budget depends on block rewards and fees continuing to pay miners; watch issuance schedules.
- **Proof of stake:** validators lock tokens and, in protocols with slashing, may lose part of them for specified faults. Consequence: staking returns can combine issuance, fees, and other rewards; operator concentration and protocol-specific penalty rules need separate review.
- **Finality:** the protocol's rule for when a transaction is treated as irreversible. Consequence: speed alone does not reveal safety or decentralization; verify the chain's assumptions, validator distribution, recovery rules, and incident history.

### Wallets and keys
- A private key authorizes transactions. Anyone who obtains it may be able to move the funds, while losing every valid recovery path may make the funds unreachable.
- **Self-custody** means the user holds the key and bears the loss if it is lost or stolen. **Exchange custody** means a company holds it and the user bears counterparty risk.
- Consequence: custody choice is a risk decision, not a convenience decision. Exchange failures have wiped out positions that were fundamentally sound.

### Smart contracts
- Programs that run on the chain and move funds according to fixed rules once deployed.
- Consequence: code is the counterparty. Audits reduce but do not remove exploit risk; upgradeable contracts mean an admin key can change the rules; immutable contracts mean bugs are permanent.

### L1 versus L2
- **L1** is the base chain that provides security and final settlement. **L2** runs transactions off the base chain and posts results back to it, trading some trust assumptions for lower cost.
- Consequence: an L2 token's value depends on its own economics, while the system also inherits base-chain and additional operator or upgrade risks. Check current sequencer, proof, pause, and upgrade controls rather than assuming they are decentralized.

### Bridges
- Mechanisms for moving assets between chains, usually by locking on one side and minting a representation on the other.
- Consequence: bridges add contracts, operators, validators, or custodians that can fail and have been targets of high-value exploits. A wrapped asset inherits the original asset's risks plus the specific bridge or custodian's failure paths.

### Token supply mechanics
- **Circulating vs total vs max supply:** how many tokens trade today versus how many will exist.
- **Unlocks and vesting:** scheduled releases to team, investors, or treasury.
- **Emissions:** new tokens created as rewards.
- Consequence: a small circulating float with large upcoming unlocks creates potential dilution and concentrated-holder risk, but does not predict the price by itself. Compare fully diluted valuation, unlock timing and recipients, liquidity, and plausible demand.

### DeFi primitives
- **Lending:** deposit to earn interest from borrowers; risk is bad debt from collateral crashes and oracle failure.
- **Liquidity provision:** supply two assets to a pool for fees; risk is impermanent loss when prices diverge.
- **Staking and restaking:** lock tokens to secure a network or another protocol; risk is slashing and layered smart-contract exposure.
- Consequence: yield has a source. If the source is token emissions rather than fees paid by real users, the yield is dilution wearing a costume.

## When to stop

Stop once the user can follow the specialist's argument and see why the named risk exists. Do not explain cryptography, virtual machines, or networking unless the risk in question depends on it.
