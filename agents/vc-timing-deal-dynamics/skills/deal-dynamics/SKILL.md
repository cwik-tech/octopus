---
name: deal-dynamics
description: >
  Evaluates the meta-signals of the fundraising process itself — round competitiveness, valuation
  anchoring, access signals, capital market positioning, and co-investor dynamics. Reads the deal
  dynamics separately from the business quality. Used primarily by the Timing & Deal Dynamics agent.
---

# Deal Dynamics Skill

The fundraising process itself contains information. A great company raising in a quiet market signals differently than the same company raising in a hot market. This skill reads the meta-signals.

## When to Use

On every deal. The dynamics of the fundraise are always informative.

---

## Deal Dynamics Protocol

### Step 1 — Round Competitiveness Assessment

| Signal | Interpretation |
|---|---|
| Multiple term sheets (3+) | High demand. Valuation may be bid up. We're competing for allocation. |
| Two term sheets | Moderate demand. We have leverage to negotiate but aren't the only option. |
| We're the only term sheet | Either we have unique edge or something is wrong. Investigate deeply. |
| Company has been fundraising >4 months | Struggling to close. Negative signal. Why is nobody investing? |
| Round closing in <2 weeks | High urgency. Could be FOMO-driven. Ensure diligence isn't being compressed. |
| Existing investors not participating | They have more information than we do and they're passing. Strong negative signal. |
| Existing investors increasing allocation | Strongest positive signal — people with inside information are doubling down. |

### Step 2 — Access Signal Decoding

**Why are we seeing this deal?**

| Access Path | Signal | Implication |
|---|---|---|
| Warm intro from trusted source | Positive — deal was sourced through quality network | Diligence focus on business quality |
| Founder reached out directly to us | Neutral — could be broad outreach or targeted | Ask how many firms they're talking to |
| Shared by another VC who passed | Negative unless they passed for thesis-fit reasons, not quality | Ask why they passed |
| Inbound from accelerator demo day | Neutral — mass market process | No edge, high competition |
| We found them (outbound sourcing) | Positive for us — we have conviction edge | But may face resistance on terms |
| Everyone is talking about it | High social proof but high competition | Edge is low; price may be inflated |

**The access question:** "Are we seeing this deal because we're smart, or because we're the last option?"

### Step 3 — Valuation Anchoring Analysis

**Is the valuation set by the market or by the founder?**

- **Market-set:** Multiple term sheets have converged on a range. Valuation reflects demand/supply equilibrium.
- **Founder-set:** Founder has a target valuation not tested by the market. May be anchored to: last round's valuation, a recent comparable, a desired ownership dilution, or an advisor's suggestion.
- **Investor-set:** Lead investor proposed a valuation, often below founder's ask.

**Anchoring checks:**
- How does this valuation compare to stage benchmarks? (See deal-classification/references/stage-benchmarks.md)
- How does it compare to similar recent rounds in the sector?
- Is the valuation justified by current metrics or by projected metrics?
- At this valuation, does the return math work for our fund? (See financial-modeling)

### Step 4 — Capital Market Cycle Positioning

**Where are we in the capital cycle?**

| Environment | Characteristics | Implication for Deal Evaluation |
|---|---|---|
| **Risk-on (frothy)** | Valuations inflated, rounds oversubscribed, diligence compressed, new investor entrants | Be more selective. Overpaying is the primary risk. Apply higher discount to valuations. |
| **Neutral** | Normal deal flow, competitive but not frenzied, valuations in line with benchmarks | Standard evaluation applies. |
| **Risk-off (downturn)** | Valuations compressed, deals struggling to close, bridge rounds common, investors cautious | Opportunity for better terms. But: follow-on risk increases (companies may not be able to raise next round). |

### Step 5 — Follow-On Signal Analysis

**Who else is investing, and what does it tell us?**

- **Lead investor quality:** Reputable lead with track record in this sector = positive signal (but do your own work — see cognitive-biases/social-proof).
- **Round composition:** A round with one strong lead + 2-3 smaller participants is healthier than a "party round" with no lead.
- **Strategic investor presence:** A corporate strategic investor can be positive (validation, distribution) or negative (may limit exit options, may have access to proprietary information).
- **Investor-founder relationship:** Has the lead investor worked with this team before? (Repeat relationships are a strong positive signal.)

### Step 6 — Timing Synthesis

Combine all signals into a timing assessment:

**Invest now if:** Business quality is strong, terms are reasonable for the market, we have competitive edge or unique value-add, and the round is structured well.

**Wait or negotiate if:** Valuation seems anchored above market, round dynamics suggest weak demand, or capital market conditions suggest better terms may be available.

**Pass on timing if:** We're the last option, the round has been open too long, existing investors are passing, or the capital market environment makes follow-on risk too high.

---

## References & Templates

| File | Content |
|---|---|
| `references/market-cycle-indicators.md` | Capital market cycle indicators and historical patterns |
| `references/round-dynamics.md` | How to read round composition, timing, and investor behavior |
| `templates/deal-dynamics-assessment.md` | Deal dynamics output template |
