---
name: web-research
description: General web research method for current external questions. Focuses on framing, evidence quality, source selection, contradiction handling, and confidence grading rather than any one domain. Use when a question needs current external evidence or source verification.
---

# Web Research Skill

This skill is for answering external questions with enough evidence to support the next decision. It is not tied to company research only. Use it for any current-question task that depends on material outside the brief.

## Core Principle

Do not start with websites. Start with the question.

A good research result answers four things clearly:

1. What exactly are we trying to know?
2. What evidence would actually answer that?
3. How reliable is the evidence?
4. What still remains uncertain?

## Step 1: Frame The Question

Convert the request into a precise research question before searching.

Good framing usually includes:

- target subject
- claim or uncertainty to resolve
- time horizon
- required confidence level
- decision the answer will support

Examples:

- weak: "research this market"
- better: "what has changed in this market in the last 12 months that would affect entry timing?"

- weak: "check this company"
- better: "does this company currently sell to enterprise buyers, and what direct evidence supports that?"

## Step 2: Decompose Into Sub-Questions

If the question is broad, split it into smaller checks.

Useful decomposition patterns:

- fact check: is claim X true?
- state check: what is true now?
- comparison: how does A differ from B?
- trend check: what changed over time?
- causality check: what explains the observed change?
- risk check: what could make this conclusion wrong?

Do not search a broad question all at once if it actually contains several distinct claims.

## Step 3: Choose Source Types By Claim Type

Pick sources based on what kind of claim you are testing.

| Claim Type | Stronger Sources | Weaker Sources |
|------------|------------------|----------------|
| Current facts | official site, official docs, regulator, raw data | blogs, summaries, reposts |
| Historical events | dated primary reporting, filings, archived pages | memory-based commentary |
| Pricing / packaging | live pricing page, terms, checkout flow | listicles, old screenshots |
| Product capability | official docs, demos, code, release notes | marketing copy alone |
| Legal / regulatory | statute, regulator guidance, enforcement records | commentary without citations |
| Market behavior | raw datasets, earnings calls, primary reporting | opinion pieces |
| Reputation / sentiment | broad cross-source pattern, direct quotes, reviews with context | isolated anecdotes |
| YouTube / video claims | externally supplied transcript plus independent verification; otherwise escalate acquisition to the YouTube extraction workflow | paraphrases of the video alone |

Rule: match the source to the claim. A source can be strong for one kind of claim and weak for another.

## Step 4: Gather Evidence Narrowly

Search only for evidence that resolves the framed question.

Guidelines:

1. Prefer primary sources first.
2. Use secondary sources to discover leads, not to end the search.
3. Capture dates whenever recency matters.
4. Follow citations upstream to the original source.
5. Search for disconfirming evidence, not just confirming evidence.
6. Treat absence of evidence as a finding when the claim should be easy to verify.

## Step 5: Evaluate Evidence Quality

Judge each source on the dimensions that matter for the current question:

- relevance: does it answer this exact question?
- recency: is it current enough?
- proximity: is it close to the underlying event or data?
- independence: is it repeating someone else?
- incentives: who benefits if this is believed?
- specificity: does it provide details, or only vague claims?

### Typical Failure Modes

Watch for:

- stale pages presented as current
- vendor self-description treated as independent proof
- multiple articles repeating one uncited claim
- selective screenshots without surrounding context
- strong conclusion drawn from one weak source
- source mismatch, such as using commentary to prove legal status

## Step 6: Separate Fact, Inference, And Open Question

Every material point should fall into one of these buckets:

- **Fact**: directly supported by inspected evidence
- **Inference**: reasonable interpretation of several facts
- **Open question**: still unresolved or weakly evidenced

Do not let inference masquerade as fact.

## Step 7: Handle Contradictions Explicitly

When sources conflict, do not average them into a blurry summary.

Instead:

1. state the conflict directly
2. check dates and definitions
3. check whether one source is secondary and the other primary
4. note whether the disagreement is resolvable or still open

Contradiction is often the most important output of the research.

## Step 8: Grade Confidence

Use confidence tags on the conclusion and on major findings.

- **High** — recent, direct, relevant, and independently corroborated
- **Medium** — credible but partial, indirect, or not fully corroborated
- **Low** — weak, stale, promotional, conflicting, or single-source

Confidence is about evidence quality, not writing tone.

## Decision Rule: Stop Or Go Deeper

Stop when:

- the question is answered clearly enough for the next decision
- remaining uncertainty is non-critical
- additional searching is unlikely to change the answer materially

Go deeper when:

- core claims still conflict
- the source base is weak or highly biased
- the question actually requires a full domain model
- the decision risk is high and the current evidence is thin

## Output Standard

This skill decides what you know and how well you know it. The persona decides
what you return. Do not choose a report shape here.

Whatever the shape, every material finding carries its date, its confidence, and
a clickable Markdown link to the exact observed page URL. Contradictions and
unresolved questions stay visible; they are findings, not untidiness.

## Lightweight Domain Examples

Examples of questions this method should handle well:

- company facts
- competitor positioning
- pricing checks
- product capability verification
- market or category shifts
- policy or regulatory checks
- public narrative and sentiment scans
- event timelines
- source verification for claims found in videos, articles, or decks

These are examples only. The method comes first.
