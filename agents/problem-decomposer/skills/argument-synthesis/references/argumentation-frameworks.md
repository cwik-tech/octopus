# Argumentation Frameworks

Three structured models for building and analyzing arguments in consulting contexts.

## Toulmin Model

**Use this when**: Constructing a defensible position or identifying weak links in someone else's argument.

**Structure**:
- **Claim**: The position you're advancing
- **Grounds**: Evidence—facts, data, observations that support the claim
- **Warrant**: The logical bridge connecting grounds to claim (the assumption that makes the connection valid)
- **Backing**: Evidence or reasoning that supports the warrant itself (the foundation beneath the assumption)
- **Qualifier**: The scope and strength of the claim (e.g., "probably," "in this context," "unless X happens")
- **Rebuttal**: Conditions under which the claim would not hold or would be weakened

**Example**:
- Claim: "We should exit this product line."
- Grounds: "Revenue declined 15% YoY; churn is 2x the company average."
- Warrant: "Declining revenue + high churn = structural misalignment, not cyclical downturn."
- Backing: "In three prior exits, we saw this exact pattern before the ultimate failure."
- Qualifier: "...unless the recent product redesign reverses churn within 90 days."
- Rebuttal: "If a competitor acquires this product, they might succeed where we failed (different distribution, cost structure)."

**How to challenge**: Attack the warrant (the assumption), not just the grounds. "Your evidence is correct, but the warrant—that this trend will continue—isn't obvious given the redesign."

## Dialectical Reasoning

**Use this when**: Two opposing positions are both partially true, or when you need to synthesize competing views.

**Structure**:
- **Thesis**: The first position (claim + reasoning)
- **Antithesis**: The opposing position (claim + reasoning)
- **Synthesis**: A higher-order resolution that incorporates truth from both while transcending the original tension

**Key principle**: The synthesis is not a compromise; it reframes the problem so that elements of both thesis and antithesis become compatible.

**Example**:
- Thesis: "Fast scaling captures market share before competitors establish dominance."
- Antithesis: "Fast scaling burns cash and ruins unit economics; slow, profitable growth is sustainable."
- Synthesis: "Segment the market by customer type. Scale fast in high-margin segments where profitability is inherent; scale slowly in price-sensitive segments where unit economics must be proven first. This avoids the false choice between speed and profitability."

**When dialectical reasoning fails**: If the synthesis just restates both sides without resolving the trade-off, you haven't actually synthesized. Keep pushing until the original tension genuinely softens.

## Pyramid Principle

**Use this when**: Structuring an argument for maximum clarity and persuasiveness; especially useful in written positions or briefings.

**Structure**:
- **Apex (top)**: The main conclusion or recommendation in one sentence
- **Level 1 (supporting ideas)**: 2–4 major reasons or findings that support the apex
- **Level 2 (evidence)**: Data, examples, or reasoning that support each Level 1 point
- **Remaining levels**: Additional detail, caveats, implications

**Rules**:
- Ideas at the same level must be logically distinct (non-overlapping)
- Ideas must be collectively exhaustive (together, they fully support the claim)
- Order by importance or narrative flow, not by the order you discovered them

**Example structure**:
```
Main: "Invest in the enterprise segment now."
  ├─ The market is expanding 3x faster than mid-market
  ├─ Our product-market fit with enterprises is proven (3 pilot wins)
  └─ Competitors lack our technical depth for enterprise requirements
    ├─ Data: 60% of top 20 enterprise prospects cite this in RFPs
    └─ Data: Our NPS among pilot customers is 72; peers average 45
```

**Advantage**: The reader understands your conclusion immediately and decides how deep to go. Works well when deliberating with multiple agents with different attention spans or priorities.

## Choosing Your Framework

| Situation | Framework | Why |
|-----------|-----------|-----|
| Building a position; preparing for challenge | Toulmin | Forces you to name assumptions before they're attacked |
| Two strong positions in tension; need synthesis | Dialectical | Designed specifically for transcending either/or thinking |
| Presenting a position to multiple agents; need clarity | Pyramid | Scales from headline to detail; audience controls depth |
| Validating a position's logical structure | Toulmin | Easiest to audit for gaps and weak assumptions |
