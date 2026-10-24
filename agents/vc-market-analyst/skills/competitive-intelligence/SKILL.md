---
name: competitive-intelligence
description: >
  Maps competitive landscapes for startup markets. Identifies direct, adjacent, and substitute
  competitors. Decodes positioning, analyzes moat depth, and identifies whitespace. Used primarily
  by the Market Analyst agent, with outputs consumed by the Pattern Matcher and Contrarian.
---

# Competitive Intelligence Skill

## When to Use

On every deal to understand who else is solving this problem, how they're positioned, and what competitive dynamics the startup faces.

---

## Competitive Mapping Protocol

### Step 1 — Identify the Competitive Set

Map three rings of competitors:

**Ring 1 — Direct competitors:** Same product, same customer, same problem. These are the companies that appear in the startup's pitch deck competitive slide (and the ones they left out).

**Ring 2 — Adjacent competitors:** Different product solving the same underlying problem, or same product targeting an adjacent customer segment. Often more dangerous than direct competitors because they attack from an unexpected angle.

**Ring 3 — Substitute competitors:** Fundamentally different approaches to the same problem, including "do nothing" (the customer continues with their current workaround). The biggest competitor for many startups is inertia — customers sticking with spreadsheets, manual processes, or the status quo.

**Finding competitors the founder didn't mention:** Search G2, Capterra, Product Hunt, Crunchbase, LinkedIn job postings (who's hiring for similar roles?), patent filings, academic papers, and customer forums. Ask: "What did customers use before this product existed?"

### Step 2 — Decode Positioning

For each significant competitor (top 5-8), map:

| Dimension | Question |
|---|---|
| **Target customer** | Who specifically are they selling to? SMB, mid-market, enterprise? |
| **Value proposition** | What's their one-sentence pitch? |
| **Pricing model** | How do they charge? What's the price point? |
| **Go-to-market** | How do they acquire customers? Sales-led, product-led, channel? |
| **Technology approach** | What's their technical architecture? Cloud-native, legacy, hybrid? |
| **Moat claim** | What defensibility do they claim? Data, network effects, IP, brand, switching costs? |
| **Funding and stage** | How much have they raised? Who backed them? What stage? |
| **Traction signals** | Revenue (if disclosed), employee count, customer logos, growth signals |

### Step 3 — Analyze Competitive Dynamics

**Convergence analysis:** Are all competitors competing on the same factors? If yes, the category is commoditizing. Divergence creates room for differentiation.

**Strategy Canvas:** Map competitors on key competitive factors (price, feature depth, ease of use, integration breadth, customer support, vertical specialization). Identify where the startup is differentiated and where it's undifferentiated.

**Incumbent response assessment:** What will incumbents do when this startup gains traction?
- **Ignore:** Below their radar or below their margin threshold
- **Copy:** Add the feature to their existing product (most common)
- **Acquire:** Buy the startup or a competitor
- **Compete:** Launch a competing product with full resources

**Time-to-response estimate:** How long before incumbents respond? 6 months (fast — web features), 12-18 months (moderate — platform changes), 24+ months (slow — deep technology or regulatory moat).

### Step 4 — Moat Assessment

Evaluate the startup's defensibility using the moat taxonomy:

| Moat Type | Strength | Duration | Evidence Required |
|---|---|---|---|
| **Network effects** | Very strong | Long | User growth curves showing acceleration, cross-side effects |
| **Switching costs** | Strong | Long | Customer retention data, integration depth, data lock-in |
| **Economies of scale** | Strong | Medium | Unit cost curves declining with volume |
| **IP / Patents** | Medium | Medium | Granted patents, trade secrets, proprietary algorithms |
| **Brand** | Medium | Medium | NPS, unaided awareness, pricing premium vs. competitors |
| **Regulatory capture** | Strong | Long | Licenses, certifications, compliance investments |
| **Data moat** | Variable | Variable | Unique data assets, data network effects, proprietary datasets |
| **Speed / First mover** | Weak | Short | Temporary advantage only — must convert to structural moat |

**Moat depth test:** "If a well-funded competitor launched tomorrow with $100M, how long before they replicate this startup's position?" If the answer is <12 months, the moat is shallow.

### Step 5 — Whitespace Identification

Where is no one competing effectively?

- Customer segments underserved by all current players
- Price points not addressed (too expensive for SMB, too basic for enterprise)
- Geographic markets not yet penetrated
- Use cases that no competitor has solved well
- Integration gaps between existing products

---

## References & Templates

| File | Content |
|---|---|
| `references/competitive-frameworks.md` | Porter's Five Forces, Strategy Canvas, competitive response models |
| `templates/competitive-map.md` | Competitive landscape output template |
