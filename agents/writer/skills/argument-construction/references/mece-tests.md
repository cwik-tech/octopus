# MECE Tests — Reference

Common Mutually Exclusive, Collectively Exhaustive (MECE) mistakes in business consulting documents, with detection tests and fixes.

---

## The Two Tests

**Test 1 — Mutual Exclusivity:** Pick any specific real-world example. Does it fit in exactly one category? If it fits two, the categories overlap.

**Test 2 — Collective Exhaustivity:** Ask "is there anything else?" Is there a real-world example that fits none of the categories? If yes, there's a gap.

---

## Common Overlap Failures (not Mutually Exclusive)

### Failure 1 — Feature overlap in options analysis

**Broken:**
- Option A: Reduce costs through headcount reduction
- Option B: Improve efficiency through process automation
- Option C: Restructure the operations team

Problem: Restructuring (C) may involve both headcount reduction (A) and automation (B). Options are not mutually exclusive.

**Fixed:**
- Option A: Maintain current structure with targeted cost reduction (headcount and non-headcount)
- Option B: Restructure with automation-first approach (invest before cutting)
- Option C: Outsource operations function entirely

Each option now represents a distinct strategic posture.

---

### Failure 2 — Time period overlap

**Broken:**
- Short-term initiatives (0-6 months)
- Medium-term initiatives (3-12 months)
- Long-term initiatives (12+ months)

Problem: A 4-month initiative fits in both "short-term" and "medium-term."

**Fixed:**
- Immediate initiatives (0-3 months)
- Near-term initiatives (4-12 months)
- Strategic initiatives (13+ months)

No overlap possible when ranges are defined with no gaps.

---

### Failure 3 — Audience segment overlap

**Broken:**
- Small businesses (under 50 employees)
- Growing companies (20-200 employees)
- Enterprise (200+ employees)

Problem: A 35-employee company fits in both "small businesses" and "growing companies."

**Fixed:**
- Small businesses (1-49 employees)
- Mid-market companies (50-499 employees)
- Enterprise (500+ employees)

---

## Common Gap Failures (not Collectively Exhaustive)

### Failure 1 — Missing segment

**Broken market segmentation for a software product:**
- Individual users (1 seat)
- Team users (2-10 seats)
- Enterprise users (100+ seats)

Gap: The 11-99 seat segment is missing entirely.

**Fixed:**
- Individual (1 seat)
- Small team (2-10 seats)
- Business (11-99 seats)
- Enterprise (100+ seats)

---

### Failure 2 — Missing option

**Broken options for a struggling product:**
- Fix the product (invest in development)
- Sunset the product (wind it down)

Gap: "Sell or spin off the product" is a third option that isn't covered.

**Fixed:**
- Fix (invest and grow)
- Sell or spin off (find a buyer or create a separate entity)
- Sunset (wind down gracefully)

---

### Failure 3 — Missing risk category

**Broken risk register:**
- Market risk
- Financial risk
- Operational risk

Gap: Regulatory risk and reputational risk are absent — relevant in most consulting contexts.

**Fixed:**
- Market risk (demand, competition, pricing)
- Financial risk (capital, liquidity, credit)
- Operational risk (process, people, systems)
- Regulatory risk (compliance, legal, government policy)
- Reputational risk (brand, public perception, stakeholder relations)

---

## When MECE Doesn't Matter

Not every list in a document needs to be perfectly MECE. MECE is most important when:

- **Presenting options** — overlapping options mislead the reader about the real choice
- **Segmenting a market** — gaps or overlaps distort sizing and targeting
- **Categorising risks** — overlaps cause double-counting; gaps leave real risks unexamined
- **Structuring recommendations** — overlapping recommendations create implementation confusion

MECE matters less for:
- Illustrative examples (you don't need to list every example)
- Supporting evidence within a section (points can reinforce each other)
- Background context (exhaustiveness is less critical than relevance)
