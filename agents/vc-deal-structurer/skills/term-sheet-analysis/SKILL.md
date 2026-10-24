---
name: term-sheet-analysis
description: >
  Analyzes venture capital deal terms independent of business quality. Evaluates valuation,
  governance rights, liquidation preferences, protective provisions, pro-rata rights, and
  co-investor dynamics. Used primarily by the Deal Structurer agent.
---

# Term Sheet Analysis Skill

A great company at bad terms is a bad investment. This skill evaluates deal structure independently from business quality.

## When to Use

On every deal with terms to evaluate. From SAFE/convertible note terms at pre-seed to full term sheets at Series A+.

---

## Term Sheet Evaluation Protocol

### Step 1 — Valuation Assessment

**Pre-money vs. post-money:** Confirm whether the stated valuation is pre-money or post-money. This is the most common source of confusion. Post-money = Pre-money + New investment.

**Option pool:** Is the option pool included in the pre-money (which dilutes existing shareholders, benefiting new investors) or post-money (which dilutes everyone equally)? Pre-money inclusion is investor-favorable.

**Valuation benchmarks:** Compare to stage-benchmarks (see deal-classification/references/stage-benchmarks.md). A valuation significantly above benchmark requires proportionally stronger metrics to justify.

**Valuation relative to milestones:** What milestones must be achieved to justify this valuation at the next round? If the company must 3x revenue in 18 months to raise at a markup, is that realistic?

### Step 2 — Economic Terms

| Term | What to Evaluate | Red Flag |
|---|---|---|
| **Liquidation preference** | 1x non-participating is standard. Anything above (2x, 3x) or participating preferred significantly reduces common shareholder returns. | >1x preference or participating preferred |
| **Anti-dilution** | Broad-based weighted average is standard. Full ratchet is extremely investor-favorable and punitive to founders. | Full ratchet anti-dilution |
| **Dividends** | Non-cumulative or none is standard for VC. Cumulative dividends accrue and increase the liquidation preference over time. | Cumulative dividends |
| **Pay-to-play** | Requires existing investors to invest pro-rata or lose preferential rights. Protects against free-rider investors. | Absence when multiple investors (allows some to not participate in bridges) |

### Step 3 — Governance Terms

| Term | What to Evaluate | Red Flag |
|---|---|---|
| **Board composition** | Common: 2 founders + 1 investor + 1-2 independent. Who controls the board? | Investor-majority board at early stage |
| **Protective provisions** | Standard: investor approval for major actions (sale, new equity, debt >$X, change of control). How broad? | Excessively broad provisions that give investors veto over operational decisions |
| **Information rights** | Monthly/quarterly financials, annual audit, board meeting attendance. | Excessive reporting requirements that distract management |
| **Drag-along** | Majority investors can force a sale. Standard, but threshold matters. | Low threshold drag-along (e.g., simple majority can force sale) |
| **Registration rights** | Investors can request IPO registration. Standard at later stages. | Unusual registration requirements at early stage |

### Step 4 — Investor Rights

| Term | What to Evaluate |
|---|---|
| **Pro-rata rights** | Right to invest in future rounds to maintain ownership %. Critical for early-stage investors. Standard and important. |
| **Right of first refusal (ROFR)** | Investor right to purchase shares before they're sold to third parties. Standard. |
| **Co-sale rights** | If founders sell shares, investors can sell proportionally. Standard. |
| **Preemptive rights** | Right to participate in any new equity issuance. Broader than pro-rata. |

### Step 5 — SAFE / Convertible Note Analysis

For pre-priced rounds:

| Term | What to Evaluate |
|---|---|
| **Valuation cap** | Maximum conversion price. Lower cap = more investor-friendly. Compare to anticipated Series A valuation. |
| **Discount** | Typically 15-25%. Applied to next round price. |
| **Cap + discount** | Investor gets the better of cap or discount conversion. Standard. |
| **MFN (Most Favored Nation)** | If later SAFEs have better terms, early SAFEs get the better terms too. |
| **Pro-rata rights** | Some SAFEs include pro-rata. Increasingly common. |

**SAFE-specific risk:** Multiple SAFE rounds at different caps create a complex cap table. Model the dilution waterfall — founders may not realize how much they've given up.

### Step 6 — Co-Investor Signal Analysis

Who else is investing, and what does their presence (or absence) signal?

**Strong signals:** Top-tier VC firm leading with board seat. Strategic investor with domain expertise. Existing investors following on (signals confidence).

**Weak signals:** No lead investor (party round). Only angels/individuals (no institutional validation). Existing investors NOT following on (negative signal — they have the most information).

**Warning signals:** Desperate terms (high valuation cap, aggressive governance) to attract any investor. "Strategic" investor who actually wants to acquire or copy the technology.

---

## Downside Scenario Analysis

For every deal, model the downside: What do we get if the company sells for $30M? $50M? $100M?

**Liquidation preference waterfall:**
1. Debt repayment
2. Liquidation preferences (in order of seniority)
3. Participation (if participating preferred)
4. Remaining to common shareholders (founders + employees)

**Key check:** At what exit price do common shareholders (founders) start getting meaningful returns? If the answer is >$200M and the realistic exit range is $50-150M, the founders have limited upside — which reduces their motivation and alignment with investors.

---

## References & Templates

| File | Content |
|---|---|
| `references/term-sheet-anatomy.md` | Detailed explanation of every term sheet clause |
| `references/negotiation-levers.md` | What's negotiable, what's standard, and when to push back |
| `templates/term-sheet-evaluation.md` | Term sheet evaluation output template |
