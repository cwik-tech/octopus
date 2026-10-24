---
name: first-principles-analysis
description: >
  Demands plain-language definitions, runs regress chains, and catches circular reasoning in
  investment deliberations. Forces the committee to justify foundational claims that experience
  makes invisible. Used primarily by the Thesis Defounder agent.
---

# First Principles Analysis Skill

The most dangerous assumptions in VC are the ones nobody questions because "everyone knows" they're true. This skill provides the protocol for systematic foundation auditing.

## When to Use

On every deal, after other agents have delivered their position statements. The Thesis Defounder operates last (before synthesis) specifically to audit what everyone else has assumed.

---

## Foundation Audit Protocol

### Step 1 — Definition Demand

Scan all position statements for terms used without operational definition. Common VC terms that sound precise but are often vague:

| Term | Demand this definition |
|---|---|
| "Platform" | What makes this a platform and not a product? What do third parties build on it? |
| "Product-market fit" | By what measurable criteria? Retention rate? NPS? Revenue growth? |
| "Moat" | What specific mechanism prevents competition? How long does it last? |
| "Network effects" | Which side benefits from the other growing? Is it direct or indirect? At what scale does it kick in? |
| "Scalable" | What's the marginal cost of the next customer? Does it actually decrease with scale? |
| "AI-native" | What does AI do in the product that couldn't be done otherwise? Is AI core or wrapper? |
| "Category creator" | What evidence exists that this category will exist in 5 years? |
| "Venture-scale" | What specific exit size and path justifies venture capital vs. other funding? |

**Process:** List every undefined term. For each, demand an operational definition: what would you measure, and how would you know?

### Step 2 — Regress Chain

Take the 2-3 most central claims from the committee's deliberation and ask "why?" repeatedly:

**Example chain:**
- Claim: "This company has strong product-market fit."
- Why? "Because retention is high."
- Why is retention high? "Because the product is sticky."
- Why is the product sticky? "Because customers have invested time setting it up."
- Why does setup time create stickiness? "Because switching costs are high."
- Why are switching costs high? "Because..." → Now we're getting to a first principle (switching costs from data migration and workflow retraining) or to circular reasoning ("because the product is sticky").

**Go at least 3 levels deep.** Report where the chain hits either:
- **Bedrock:** An observable, testable first principle (physics, mathematics, human behavior)
- **Quicksand:** A circular argument or an unsupported assumption

### Step 3 — Plain Language Translation

Rewrite the committee's investment thesis in the simplest possible language. Does it still make sense?

**Jargon version:** "This AI-native vertical SaaS platform leverages proprietary data moats and network effects to capture a $50B TAM through a product-led growth motion."

**Plain language:** "This software for [specific customer] uses AI to [do what specifically]. It gets better as more people use it [how exactly?]. The market is [$X] [based on what?]. People find it through using the free version [how many convert?]."

The plain language version reveals where the jargon was hiding vague thinking.

### Step 4 — Emperor's Clothes Test

When the committee converges on a position (especially a bullish one), push hardest:

- "Everyone agrees the team is strong — what specific evidence supports that beyond pedigree?"
- "Everyone agrees the market is large — has anyone independently sized it, or are we all citing the same pitch deck number?"
- "Everyone agrees this is the right time — what would the 'wrong time' look like, and how do we know we're not in it?"

Universal agreement is not the same as being right. It can signal genuine consensus OR groupthink. This test distinguishes them.

### Step 5 — Circular Reasoning Detection

Watch for these patterns in the committee's reasoning:

| Pattern | Example | What's Really Happening |
|---|---|---|
| **Tautology** | "This will succeed because it's a great company" | Restating the conclusion as the premise |
| **Appeal to analogy** | "This is like Uber, so it will scale like Uber" | Using conclusion (it scales) to justify premise (it's like Uber) |
| **Metric circularity** | "The TAM is $50B therefore this can be a big company therefore the TAM is real" | Market size used as both evidence and conclusion |
| **Social proof loop** | "Smart investors are in, so it must be good, so smart investors are right to be in" | Investor quality used to validate the deal and the deal used to validate the investors |

---

## Output: Foundation Audit Report

Deliver as a catalog of unexamined foundations:

1. **Undefined terms:** List with what's ambiguous and why it matters
2. **Circular reasoning:** 2-3 places where the reasoning loops
3. **Regress findings:** Where chains hit bedrock vs. quicksand
4. **Plain language translation:** The thesis stripped bare
5. **The question nobody answered:** The one question that, if answered honestly, might change everything

---

## References & Templates

| File | Content |
|---|---|
| `references/socratic-protocols.md` | Socratic questioning techniques and regress chain methodology |
| `templates/foundation-audit.md` | Foundation audit output template |
