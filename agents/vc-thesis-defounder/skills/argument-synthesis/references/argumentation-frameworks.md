# Argumentation Frameworks for Investment Analysis

## Toulmin Model (Adapted for VC)

The Toulmin model provides the structure for any investment argument. Every position statement should contain these elements:

**Claim:** The investment recommendation. "We should invest $3M at $15M pre-money."

**Data/Evidence:** The observable facts supporting the claim. "$1.2M ARR (Annual Recurring Revenue), 15% month-over-month growth, 120% NRR (Net Revenue Retention), 3 enterprise contracts signed in Q1."

**Warrant:** The reasoning bridge — *why* this evidence supports this claim. "Companies at this ARR with this growth rate and retention profile historically reach $5M+ ARR within 18 months, creating a clear Series B path at 3-5x markup."

**Backing:** Support for the warrant itself. "Based on OpenView's 2024 SaaS benchmarks, top-quartile Series A companies grow at 12-18% MoM. This company is at the 85th percentile."

**Qualifier:** The degree of confidence. "With moderate confidence — contingent on Q2 retention data confirming the Q1 trend."

**Rebuttal:** The acknowledged counterargument. "Unless the enterprise pipeline is lumpy and Q1 was an outlier driven by a single champion buyer at the anchor customer."

### Application Rules

- Every investment position must have at minimum: Claim + Data + Warrant.
- Positions without warrants are opinions, not arguments. "The team is great" is an opinion. "The team is great because the CTO built and scaled the engineering org at [Company] from 5 to 120 engineers, which is the exact scaling challenge this startup faces next" is an argument.
- Positions without rebuttals are incomplete. If you can't articulate what would make your position wrong, you haven't thought hard enough.

## Dialectical Reasoning for Investment Committees

Investment committees produce better decisions through structured disagreement, not consensus-seeking. The dialectical process:

**Thesis:** The initial investment position. Usually the deal sponsor's pitch: "This is a strong Series A opportunity in vertical SaaS for healthcare."

**Antithesis:** The strongest counter-position. Not a weak strawman but the most dangerous challenge: "Healthcare vertical SaaS has a 7-year sales cycle to health systems, the regulatory burden makes iteration slow, and three well-funded competitors entered this space in the last 12 months."

**Synthesis:** The position that incorporates the truth from both sides. "The market opportunity is real but the go-to-market must be bottoms-up through individual practitioners, not top-down through health systems. The competitors are selling to CIOs; this startup is selling to physicians directly. If the bottoms-up motion works, the competitive threat is manageable."

### Dialectical Rules

1. The antithesis must be *at least as strong* as the thesis. Weak antitheses produce false confidence.
2. The synthesis must not be a compromise. "Let's invest but at a lower valuation" is a compromise, not a synthesis. A true synthesis reframes the question.
3. If no synthesis emerges, the tension is unresolvable with current information. Name it as an open question and specify what data would resolve it.

## Pyramid Principle for Investment Memos

Structure investment arguments top-down:

**Level 1 — The answer.** State the recommendation first: "Invest / Pass / Conditional." Never bury the lead.

**Level 2 — The supporting arguments.** 3-5 key reasons, each independently sufficient to be worth stating. Group by: market, team, product, financials, deal terms.

**Level 3 — The evidence.** Under each supporting argument, the specific data points. Each data point must be verifiable and sourced.

### Pyramid Rules

- **MECE (Mutually Exclusive, Collectively Exhaustive) at every level.** The supporting arguments shouldn't overlap, and together they should cover all relevant dimensions.
- **So-what test.** Every data point must answer "so what?" in the next level up. If a data point doesn't support a specific argument, it's noise.
- **Horizontal logic.** Arguments at the same level should tell a coherent story when read in sequence: "The market is large and growing [1], the team has unique domain expertise to capture it [2], the product shows early traction [3], and the financials support a path to our target returns [4]."

## Inversion Technique

Before finalizing any investment thesis, invert it:

1. **State the thesis:** "This company will succeed because of X, Y, Z."
2. **Invert:** "This company will fail. What would cause that?"
3. **List failure paths:** Team breakup, market collapse, competitive displacement, regulatory change, capital starvation, technology failure, customer concentration, key person dependency.
4. **For each failure path:** How likely? How detectable early? How mitigable through deal terms or board involvement?

The inversion often reveals risks that the forward-looking thesis systematically obscures. A thesis that survives inversion is dramatically stronger than one that hasn't been inverted.

## Analogy Discipline

Analogies are the most common and most dangerous reasoning tool in VC. "This is the Shopify of healthcare" sounds compelling but is usually misleading.

**Structural analogy (useful):** "Like Shopify, this company is building a platform that gives individual practitioners tools previously available only to large organizations. The mechanism — democratizing enterprise tooling — transfers because the same dynamics apply: fragmented market of small players, high willingness to pay for autonomy, network effects from shared infrastructure."

**Surface analogy (dangerous):** "Like Shopify, this company is growing fast and has a charismatic founder." This analogy shares no structural mechanism. It's pattern-matching on irrelevant features.

**Test:** For any analogy, ask: "What *mechanism* transfers from the source to the target? Do the conditions for that mechanism exist in the target market?" If you can't answer both, the analogy is decorative, not analytical.
