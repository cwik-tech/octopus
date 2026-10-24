---
name: vc-scorecard
description: >
  Standardized venture scorecard for startup investment review. Converts a loose
  evaluation rubric into explicit scoring anchors, evidence requirements,
  weighting, fatal-flaw rules, confidence handling, and recommendation logic.
---

# VC Scorecard Skill

## Purpose

Provide a consistent venture-capital scoring method that reduces impressionistic judgments and forces evidence-backed evaluation. Use this skill to turn startup diligence materials into a comparable scorecard, explicit risk view, and recommendation.

## When To Use

- On any startup investment memo, accelerator evaluation, venture screening note, or internal diligence review.
- Mandatory for `deal-evaluator` when producing a final recommendation.
- Use for specialist scoring whenever the agent is assessing one or more scorecard dimensions directly.
- Do not use as a substitute for specialist analysis. Use it to structure judgment after analysis.

## Core Rules

1. Separate **observed fact**, **reasoned inference**, and **recommendation**.
2. Do not let founder charisma or a fashionable market inflate unrelated categories.
3. If evidence is missing, mark it explicitly as `Information not provided`. Do not silently award a middle score.
4. A high total score does not override a fatal flaw.
5. Stage matters. Pre-seed tolerates more uncertainty than Series A+, but not dishonesty, broken ownership, or incoherent market logic.
6. Never fabricate, smooth over, or infer absent diligence materials as if they were provided.

## Score Dimensions

Use these 12 dimensions.

| Dimension | Weight | What It Measures |
|---|---:|---|
| Coachability | 8 | Receptivity to feedback, learning velocity, and response to challenge |
| Team expertise | 10 | Relevant domain, technical, and operating capability |
| Team size and structure | 6 | Whether the current team shape matches the next 12-18 months |
| Revenue / monetization | 8 | Clarity and realism of revenue model and early monetization evidence |
| Financial health | 8 | Burn, runway, capital efficiency, and financial discipline |
| Funding strategy | 6 | Quality of financing plan across dilutive and non-dilutive options |
| Commercialization potential | 12 | Product-market fit signals and go-to-market plausibility |
| Market attractiveness | 12 | Market size, growth, accessibility, and timing |
| Competitive positioning | 10 | Distinctiveness and defensibility versus direct and substitute alternatives |
| Diversity and inclusion | 4 | Observable team diversity and inclusion strength where relevant to execution and access |
| Regulatory and compliance | 8 | Burden, readiness, and regulatory risk severity |
| Intellectual property / defensibility | 8 | Ownership, protection, and defensibility of the company’s advantage |

Total possible weighted score: `100`.

## Evidence Standard

For each dimension, provide:

- `Score (0-4)`
- `Evidence`
- `Confidence: High / Medium / Low`
- `Why not higher`
- `Open diligence question`

Evidence quality guidance:

- **High:** direct documents, metrics, contracts, customer evidence, cap table, legal docs, or multiple converging sources
- **Medium:** management claims partially supported by artifacts or credible third-party sources
- **Low:** mostly narrative, weak proxies, sparse data, or unverified assumptions
- **Information not provided:** the material needed to assess the dimension was not supplied; say that verbatim and score conservatively

## Scoring Anchors

Use real `0-4` anchors, not `0 / 1-3 / 4`.

### 0 — Failing / Absent

- Material weakness, missing capability, or no credible evidence
- In some categories, may indicate an immediate pass risk

### 1 — Weak

- Early signal exists, but major gaps remain
- Meaningful skepticism is warranted

### 2 — Mixed / Emerging

- Some credible positives, but the case is still incomplete
- Acceptable for some pre-seed dimensions, not strong enough to underwrite with confidence

### 3 — Strong

- Clear evidence supports the dimension
- Risks remain, but they are manageable and explicit

### 4 — Exceptional

- Unusually strong evidence relative to stage
- Clear advantage or readiness that materially improves the investment case

## Dimension-Specific Guidance

### Coachability

Evidence: response to feedback, iteration speed, reference feedback, ability to name mistakes, behavior under challenge.

- `0`: defensive, evasive, blames others, no evidence of learning
- `1`: verbally open but little evidence of behavioral change
- `2`: accepts feedback inconsistently; some learning signal
- `3`: clearly receptive, updates decisions based on evidence, strong self-awareness
- `4`: actively seeks challenge, learns quickly, improves visibly, references confirm this pattern

### Team Expertise

Evidence: founder-market fit, technical depth, operating history, prior startup or domain execution.

- `0`: no relevant expertise for the problem being solved
- `1`: partial relevance, but critical competence gaps dominate
- `2`: credible domain or technical fit, but execution evidence is still thin
- `3`: strong relevant expertise across core functions needed now
- `4`: rare combination of domain, technical, and operating credibility for this category

### Team Size And Structure

Evidence: role coverage, co-founder complementarity, critical hiring gaps, team design for next 12-18 months.

- `0`: team shape is misaligned to survival and execution
- `1`: serious role gaps or founder dependency risks
- `2`: workable for current stage, but near-term scaling gaps are obvious
- `3`: team is well-shaped for current milestones with manageable hiring gaps
- `4`: unusually strong structure, complementarity, and succession depth for stage

### Revenue / Monetization

Evidence: revenue model clarity, pricing logic, early revenue, conversion proof, customer willingness to pay.

- `0`: no credible revenue model
- `1`: model exists conceptually, but little evidence customers will pay
- `2`: early monetization path is plausible with some signal
- `3`: clear model with credible early proof or strong pricing logic
- `4`: strong monetization evidence and unusually good pricing power for stage

### Financial Health

Evidence: runway, burn discipline, cash planning, unit economics, budget realism.

- `0`: runway crisis, uncontrolled burn, or unreliable financial visibility
- `1`: fragile position with weak discipline or unclear assumptions
- `2`: near-term stability but important weaknesses remain
- `3`: sound burn discipline and credible path to next milestone
- `4`: exceptional capital efficiency and disciplined planning

### Funding Strategy

Evidence: target raise logic, source mix, relationship development, milestone-based financing plan.

- `0`: no meaningful funding strategy
- `1`: generic raise intent without sequencing or source logic
- `2`: basic plan exists, but contingency coverage is weak
- `3`: thoughtful financing plan with multiple paths and milestone logic
- `4`: unusually mature financing strategy with strong investor/grant relationship groundwork

### Commercialization Potential

Evidence: product-market fit signal, GTM clarity, buyer definition, sales motion realism, customer proof.

- `0`: no credible path to customers
- `1`: GTM story exists, but little evidence it works
- `2`: emerging signal with important execution uncertainty
- `3`: strong early commercialization logic and evidence
- `4`: unusually compelling PMF and GTM proof for stage

### Market Attractiveness

Evidence: TAM/SAM/SOM logic, market growth, accessibility, structural tailwinds, venture-scale potential.

- `0`: stagnant, tiny, inaccessible, or structurally unattractive market
- `1`: market may exist, but venture scale is doubtful
- `2`: market case is plausible but not yet robust
- `3`: strong market with credible growth and accessibility
- `4`: exceptional market timing and scale for venture outcomes

### Competitive Positioning

Evidence: differentiation, customer alternatives, switching friction, defensibility, speed of imitation.

- `0`: no real advantage; commodity or crowded with no edge
- `1`: weak differentiation or founder-claimed edge not supported by customer reality
- `2`: some real edge, but durability is uncertain
- `3`: clear competitive advantage with credible defense path
- `4`: distinctive and hard-to-copy position with durable advantage signals

### Diversity And Inclusion

Evidence: composition of leadership/team, inclusive hiring pattern, access to underserved users or talent pools where relevant.

- `0`: no observable diversity signal and no evidence the team takes inclusion seriously
- `1`: limited signal; not clearly harmful, not clearly a strength
- `2`: some meaningful diversity or inclusion evidence
- `3`: strong inclusion and team diversity that plausibly improves execution or access
- `4`: exceptional strength with clear strategic relevance to company building

### Regulatory And Compliance

Evidence: burden level, approvals needed, compliance readiness, legal counsel readiness, documentation.

- `0`: major regulatory blocker with no credible response
- `1`: severe burden with thin readiness
- `2`: material regulatory risk, but manageable with work
- `3`: clear awareness and credible compliance plan
- `4`: favorable position with strong readiness and low surprise risk

### Intellectual Property / Defensibility

Evidence: ownership clarity, patents, trade secrets, licensed rights, data advantage, distribution moat, switching costs.

- `0`: no defensibility and unclear ownership
- `1`: weak protection or major ownership ambiguity
- `2`: some protection or advantage, but not yet durable
- `3`: strong defensibility case with clear ownership
- `4`: exceptional defensibility for stage and category

## Stage Adjustment Rules

- **Pre-seed:** tolerate more unknowns in revenue and financial maturity; do not tolerate unclear ownership, dishonest claims, or incoherent market logic.
- **Seed:** expect early commercialization proof, clearer GTM, and a sharper financing plan.
- **Series A and beyond:** require stronger traction quality, economic visibility, and organizational readiness. Scores of `2` in core dimensions become more concerning.

## Missing-Information Handling

When a required input is absent:

- write `Information not provided` in the evidence field
- lower confidence accordingly
- do not invent metrics, legal readiness, customer validation, or market proof
- score only what is actually supported by the materials
- add a concrete `Open diligence question` that names the missing item

Examples:

- no cap table provided: write `Information not provided`; do not assume clean ownership
- no cohort data provided: write `Information not provided`; do not infer retention quality from topline growth
- no market source provided: treat TAM or CAGR claims as unverified management assertions, not established fact

## Fatal-Flaw Rules

Any of the following should trigger a `fatal flaw` flag, regardless of total score:

- unresolved IP ownership or licensing rights that undermine the product
- cap table dysfunction, founder integrity concerns, or severe governance risk
- regulatory burden likely to block go-to-market with no credible plan
- no plausible path to venture-scale returns
- evidence of fabricated metrics or materially misleading diligence materials

If a fatal flaw exists:

- default to `Pass`, or
- use `Invest with Conditions` only if the flaw is concrete, remediable, and the condition is explicit and near-term

## Recommendation Logic

Use the weighted score, fatal flaws, and confidence together.

- **Invest:** weighted score usually `75+`, no fatal flaw, and conviction supported by evidence
- **Invest with Conditions:** weighted score usually `65-84`, no unresolved fatal flaw, but clear milestones or term protections are required
- **Wait:** weighted score usually `50-69`, or the company needs more proof before underwriting
- **Pass:** weighted score usually `<50`, or any unresolved fatal flaw

Do not apply thresholds mechanically. Explain the override if the recommendation differs from the score band.

## Method

### Step 1 — Build The Evidence Base

Collect the relevant materials:

- pitch deck
- financials and projections
- cap table
- legal/IP documents
- customer or traction data
- diligence notes
- founder interaction notes

### Step 2 — Score Each Dimension Independently

Evaluate each dimension on its own evidence. Do not let one strong area create a halo effect.

### Step 3 — Record Confidence

Confidence is about evidence quality, not enthusiasm.

### Step 4 — Identify Critical Risks And Fatal Flaws

List the top risks separately from the score. Risks are not the same as low scores.

### Step 5 — Calculate Weighted Score

Use this formula per dimension:

`weighted_result = (score / 4) * weight`

Then sum all weighted results to produce a total score out of `100`.

### Step 6 — Form Recommendation

Choose one:

- `Invest`
- `Invest with Conditions`
- `Wait`
- `Pass`

### Step 7 — State What Would Change The Decision

Name the evidence, milestone, or term change that would move the recommendation up or down.

## Output

Produce a VC scorecard in this structure:

```markdown
## Scorecard Summary

| Dimension | Score | Weight | Weighted Result | Confidence | Evidence Quality |
|---|---:|---:|---:|---|---|

**Weighted score:** [X / 100]
**Raw score:** [X / 48]
**Critical-risk flags:** [list]
**Fatal flaws:** [none / list]
**Overall confidence:** [High / Medium / Low]

## Criterion Notes

### [Dimension]
- Score:
- Evidence: [Use `Information not provided` when applicable]
- Why not higher:
- Confidence:
- Open diligence question:

## Recommendation
- Recommendation:
- Rationale:
- Conditions / milestones:

## What Would Change The Decision
- Toward invest:
- Toward wait:
- Toward pass:
```
