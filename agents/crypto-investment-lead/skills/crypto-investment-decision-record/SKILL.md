---
name: crypto-investment-decision-record
description: >
  Structure a crypto investment board conclusion into an auditable decision
  record with thesis, bull and bear cases, contrarian objections, key risks,
  invalidation triggers, the strategist's sizing, a dated-fact register, and
  open questions. Use whenever the board reaches or stalls on a conclusion
  about an asset, allocation, DeFi position, or timing question, and when a
  prior record needs re-opening because an invalidation trigger fired.
---

# Crypto Investment Decision Record

## Purpose

Produce a record someone can read in six months and judge whether the board reasoned well, regardless of how the price moved. A good record makes the bet legible: what we believed, what we feared, what would have changed our mind, and how much we put at risk.

## Hard gates — the record does not ship if any fail

1. The contrarian's objections are listed, each marked **answered**, **partially answered**, or **unanswered**.
2. At least one invalidation trigger is specific and observable (not "if fundamentals deteriorate").
3. Every material fact has a date and a source, or is explicitly marked UNVERIFIED.
4. Sizing is attributed to the portfolio strategist or marked PENDING with the reason.
5. The book (majors / speculative sleeve) is named and the risk-budget status stated.
6. For early-stage candidates: diligence, risk, contrarian, and dated-fact seats each have a recorded position.

If a gate fails, the decision field is **HOLD** and the failing gate is named as the blocker.

## Record structure

### Header
- Session, date, category, book, seats convened.

### Decision as reframed
- The three sentences from routing: decision, downside type, invalidation.

### Thesis
- "For this to work, the following must be true:" — a numbered list.
- Beside each item: **evidenced (date, source)** / **partially evidenced** / **assumed**.
- Identify every assumption that could change the decision or sizing. Any such assumption is blocking until verified or explicitly carried as a scenario; a raw count is not a substitute for materiality.

### Bull case
- Owner, strongest single argument, supporting evidence with dates.

### Bear case
- Owner, strongest single argument, supporting evidence with dates.
- Must be comparable in scope, evidence, and specificity to the bull case. Do not use word count as a proxy for whether the downside received serious analysis.

### Contrarian objections
| # | Objection | Response | Status |
| --- | --- | --- | --- |

Any **unanswered** objection that would change the decision if true is blocking.

### Key risks
| Risk | Type (drawdown / liquidity / contract / regulatory / total loss) | Likelihood | Severity | Mitigation or acceptance |
| --- | --- | --- | --- | --- |

Rank by severity times likelihood. Name the single risk that dominates.

### Invalidation triggers
| Trigger (observable event) | Data source to watch | Action if it fires |
| --- | --- | --- |

Examples of acceptable triggers: a named token unlock exceeding X% of float, TVL falling below a stated level for 30 days, a core team departure, a regulatory action against a named entity, loss of a specific exchange listing, an exploit above a stated dollar amount. Unacceptable: "sentiment turns," "price drops a lot."

### Sizing
- Portfolio strategist's recommendation, quoted and attributed.
- Risk seat's non-market clearance and the portfolio strategist's confirmation that the analysis stays within the user's stated risk budget.
- If PENDING: what is missing.

### Decision
- **PROCEED** — all gates pass, no blocking objections.
- **PROCEED WITH CONDITIONS** — gates pass; named conditions must be met before or after entry.
- **HOLD** — a gate failed or a blocking objection is unanswered; blocker named.
- **PASS** — the board declines; the decisive reason stated in one sentence.

### Dated-fact register
| Fact | Value | As of | Source | Status |
| --- | --- | --- | --- | --- |

### Open questions
- Each with an owner seat and a rough horizon.

### Need-to-know for a newcomer
- Two to four plain sentences produced with the explainer skill. Everything else is can-skip.

## Re-opening a record

When an invalidation trigger fires on an existing position, re-open the record: state which trigger fired, the evidence and date, the action the record committed to, and whether the board is executing that action or revising the record — and if revising, why that is not just rationalization. Log the outcome to the experience pad.
