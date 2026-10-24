---
name: crypto-custody-and-regulatory-risk
description: >
  Map crypto custody, exchange-counterparty, jurisdictional, regulatory, and
  tax exposure while separating dated verified rules from contested or unknown
  treatment. Use when reviewing an exchange or custodian, self-custody tradeoffs,
  trading, staking, lending, airdrops, tax, regulation, or whether an activity
  is allowed in a particular jurisdiction.
---

# Crypto Custody and Regulatory Risk

## Purpose

Expose permanent-loss and compliance paths around a crypto asset without pretending that one custody model is universally safest or that a legal summary remains current. Produce a decision map that names who controls the asset, which jurisdiction and activity are in scope, what is verified as of a date, and what still needs qualified legal or tax advice.

## Required Inputs

- Asset and activity: hold, trade, stake, lend, bridge, receive, spend, or transfer.
- Venue, custodian, or wallet model and the named legal entity where available.
- User jurisdiction, tax residency, account or entity type, and decision date.
- Amount and concentration only when relevant to the risk decision.

If an input is missing, analyze named scenarios. Do not silently choose one.

## Method

### 1. Draw the control chain

For every step, record:

- who holds or can recover the private keys;
- which legal entity owes an obligation to the user;
- whether customer assets are represented as segregated and what primary evidence supports that;
- withdrawal limits, delays, freezes, and failure or insolvency paths;
- hot-wallet, smart-contract, bridge, validator, and banking dependencies;
- what recovery is possible after loss, compromise, death, or device failure.

Treat self-custody and third-party custody as different risk bundles. Self-custody removes some counterparty exposure but adds key-loss, inheritance, malware, signing, and operational risks.

### 2. Frame each rule precisely

Write each regulatory or tax question as:

`As of [date], for [user or entity type] in [jurisdiction], how is [asset and activity] treated?`

Route that question to `web-researcher`. Prefer current primary authorities: legislation and official registers, regulator publications, tax-authority guidance, court decisions, and filed enforcement documents. A provider blog or news story may identify a question but cannot settle it.

### 3. Classify the answer

Label every material legal or tax conclusion:

- **Verified:** A dated primary source directly addresses this scope.
- **Contested:** Authorities, courts, or official materials conflict, or the treatment is under active challenge or transition.
- **Unknown:** The source does not cover this asset, activity, user type, jurisdiction, or date.

Record the source, publication or effective date, jurisdiction, scope, and any transition period. Never generalize one country's treatment to another or one activity's treatment to all crypto activity.

### 4. Convert exposure into a decision

For each risk, state:

1. Failure event.
2. User consequence.
3. Likelihood: low, medium, high, or unknown.
4. Severity: inconvenience, taxable or reporting burden, access loss, partial loss, or total loss.
5. Reversibility.
6. Mitigation and its residual risk.
7. Evidence or professional advice needed to clear it.

## Output

- **Scope:** Assumptions, jurisdiction, activity, user status, and as-of date.
- **Custody map:** Control chain, counterparties, dependencies, and recovery limits.
- **Regulatory and tax map:** Verified, contested, and unknown claims with dated sources.
- **Risk register:** Failure event, consequence, likelihood, severity, reversibility, mitigation, residual risk.
- **Disposition:** CLEAR / CLEAR WITH CONDITIONS / BLOCK / UNKNOWN.
- **Professional-advice boundary:** The exact questions requiring a qualified lawyer, tax professional, or regulated financial adviser.

## Red Lines

- Do not provide personalized legal or tax advice.
- Do not say an activity is allowed, prohibited, taxable, exempt, licensed, insured, or protected without a current primary source matching the exact scope.
- Do not treat registration as proof of solvency, security, suitability, or government endorsement.
- Do not call self-custody or exchange custody safe; compare their distinct failure paths.
- Do not request secrets or propose a wallet transaction as verification.
