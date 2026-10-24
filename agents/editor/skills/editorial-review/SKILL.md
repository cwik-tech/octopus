---
name: editorial-review
description: >
  Protocols for reviewing business consulting documents against briefs, style profiles, and quality
  standards. Covers five-layer review (brief compliance, structural logic, clarity, style,
  consistency), issue severity classification, and revision decision-making. Core skill for the
  Editor agent.
  Use when reviewing a draft for clarity, structure, and consistency.
---

# Editorial Review Skill

## When to Use

On every document review. The Editor runs this skill as the structured protocol for evaluating a draft against the original brief, style profile, and style guide. Follow the layers in order — never skip to style checking before confirming the argument holds together.

---

## Review Protocol

### Layer 1 — Brief Compliance Check

This is the most important layer. A beautifully written document that doesn't do what the brief asked is a failure.

**Checklist:**

| Check | Question | Severity if failed |
|---|---|---|
| Section coverage | Does every section in the brief exist in the draft? | BLOCKING — missing sections mean incomplete deliverable |
| Section depth | Does each section match the depth specified in the brief? (Short / Medium / Long) | WARNING — underdeveloped sections weaken but don't break |
| Data usage | Does the draft use the data the brief pointed to? | BLOCKING if key data is ignored, WARNING if supplementary data is missed |
| Data fabrication | Is there data in the draft that wasn't in the brief or inputs? | BLOCKING — fabricated data is never acceptable |
| Audience alignment | Does the document speak at the right level for the reader? | WARNING — fixable in revision |
| Purpose delivery | Can the reader make the decision the brief intended? | BLOCKING — this is the document's reason for existence |
| Variable population | Are all template variables filled correctly? | WARNING — easy fix but embarrassing if missed |
| Placeholder status | Are there unresolved `[TODO: ...]` placeholders? | BLOCKING — each one means incomplete content |

**How to execute:**
1. Open the brief and the draft side by side
2. Walk through each section in the brief
3. For each section, check: exists? correct depth? uses specified data? achieves stated purpose?
4. Log every discrepancy with section reference, expected vs. actual, and severity

### Layer 2 — Structural Logic Analysis

Read the document as an argument, not a collection of sections.

**Test 1 — Claim-Evidence Chain:**

For every major claim in the document, trace it to supporting evidence:

```
CLAIM: "The company should enter the enterprise segment"
  ↓ supported by?
EVIDENCE: "Mid-market growth has declined 15% QoQ for 3 quarters"
  ↓ connected by?
REASONING: "Market saturation in mid-market makes enterprise the logical expansion"
  ↓ which implies?
IMPLICATION: "Enterprise entry would diversify revenue and reduce concentration risk"
```

If any link in the chain is missing, flag it:
- Missing evidence → BLOCKING: "Unsupported claim in [section]"
- Missing reasoning → WARNING: "Logical leap in [section] — evidence exists but connection to claim is unstated"
- Missing implication → SUGGESTION: "Add 'so what' after evidence in [section]"

**Test 2 — Logical Flow:**

Read the section headings in order. Do they tell a coherent story? Could you rearrange them without anyone noticing? If yes, the structure is weak.

**Good flow:** Situation → Problem → Analysis → Options → Recommendation → Next Steps (each section builds on the previous)

**Bad flow:** Background → Recommendation → Market Analysis → Financial Data → Team → Timeline (sections could be in any order)

**Test 3 — Circular Reasoning Detection:**

Watch for arguments that assume their own conclusion:

- "We recommend Option A because it's the best option." (Why is it the best?)
- "The strategy will succeed because the team is strong." (How does team strength guarantee strategy success?)
- "Customers will adopt the product because it meets their needs." (How do you know it meets their needs?)

For each circular argument, flag as BLOCKING and identify what evidence would break the circle.

**Test 4 — Internal Contradiction Detection:**

Check for statements in one section that conflict with statements in another:

- Section 2 says "the market is growing rapidly" → Section 4 says "market saturation is a concern"
- Executive summary says "we recommend immediate action" → Body says "more data is needed before deciding"
- Financial section says "ROI is projected at 3x" → Risk section says "financial returns are uncertain"

Contradictions are BLOCKING unless they represent genuine tension that's explicitly acknowledged.

**Test 5 — Executive Summary Alignment:**

Read only the executive summary. Then read only the body. Ask:
- Does the summary accurately represent the body's conclusions?
- Does the summary overstate the certainty of the body's findings?
- Does the summary introduce claims not in the body?
- Does the summary miss key findings from the body?

Misalignment is BLOCKING — the executive summary is often the only part senior readers see.

### Layer 3 — Clarity and Concision Audit

**Scan 1 — Corporate filler detection:**

Read every sentence and ask: "Does this sentence add information, advance the argument, or clarify a point?" If not, flag it.

Common filler patterns:
- **The Impressive Nothing:** "We take a holistic, integrated approach to driving cross-functional alignment." What does this actually mean? Flag and request a concrete replacement.
- **The Vague Quantifier:** "Significant growth," "substantial improvement," "numerous stakeholders." If the number exists, use it. If it doesn't, say "the data is unavailable."
- **The Double-Say:** Two paragraphs making the same point in different words. Flag the weaker one for deletion.
- **The Empty Introduction:** "In this section, we will explore the key factors that..." Just state the factors.

**Scan 2 — Sentence-level tightening:**

| Pattern | Example | Fix |
|---|---|---|
| Unnecessary qualifier | "very significant" | "significant" (or better: the actual number) |
| Wordy phrase | "in order to" | "to" |
| Wordy phrase | "due to the fact that" | "because" |
| Wordy phrase | "at this point in time" | "now" |
| Wordy phrase | "in the event that" | "if" |
| Hidden verb | "make a decision" | "decide" |
| Hidden verb | "conduct an analysis" | "analyze" |
| Passive hiding actor | "it was decided" | "[Who] decided" |
| Nominalisation | "the implementation of" | "implementing" |

**Scan 3 — Paragraph discipline:**

- Any paragraph > 6 sentences → flag for splitting
- Any paragraph = 1 sentence → flag (should be a heading or merged with adjacent paragraph)
- Three consecutive paragraphs of the same length → flag for rhythm variation

### Layer 4 — Style Compliance Check

Compare the draft against the active style profile field by field:

**Protocol:**

1. Read the style profile
2. Select 5 representative paragraphs from across the document (intro, middle, end, plus executive summary)
3. For each paragraph, check: tone match? formality match? sentence length? voice? person? hedging level?
4. Log drift: where does the draft deviate from the profile?

**Common drift patterns:**

| Drift | What it looks like | Severity |
|---|---|---|
| Formality collapse | Starts formal, becomes casual by page 5 | WARNING |
| Hedging creep | Starts confident ("the data shows"), becomes tentative ("it might suggest") | WARNING if pattern, SUGGESTION if isolated |
| Tone mismatch | Profile says "authoritative," document reads as tentative | WARNING |
| Voice inconsistency | Switches between active and passive without pattern | SUGGESTION |
| Person shifting | Switches between "we" and "the team" inconsistently | WARNING |

### Layer 5 — Consistency Check

**Terminology:** Search for the same concept described with different words. "The platform" vs. "the system" vs. "the tool" — pick one and use it throughout.

**Abbreviations:** Check that every abbreviation is defined on first use (full term first, abbreviation in parentheses). Check that after definition, usage is consistent.

**Formatting:** Check heading levels, bullet styles, table formatting, bold/italic usage for consistency.

**Tense:** Check that tense is consistent within sections. Past tense for findings. Present tense for analysis. Future tense for recommendations.

**Naming:** Check that people, organizations, and products are named consistently throughout.

---

## Issue Severity Classification

### BLOCKING

The document cannot be approved with this issue. It must be fixed.

**Criteria:** The issue prevents the document from accomplishing its purpose, introduces factual errors, or would embarrass the author in front of the reader.

**Examples:** Missing section from brief. Unsupported major claim. Fabricated data. Executive summary contradicts body. Unresolved placeholders.

### WARNING

The document is weakened by this issue. It should be fixed but won't catastrophically fail without the fix.

**Criteria:** The issue reduces clarity, undermines credibility, or creates an inconsistency that an attentive reader would notice.

**Examples:** Underdeveloped section. Logical leap (evidence exists but reasoning is unstated). Tone drift from profile. Terminology inconsistency.

### SUGGESTION

An optional improvement. The document works without it but would be better with it.

**Criteria:** The issue is a matter of craft refinement, not structural integrity.

**Examples:** A paragraph that could be tighter. A transition that could be smoother. A data point that could use more context.

---

## Verdict Decision Matrix

| BLOCKING count | WARNING count | Verdict |
|---|---|---|
| 0 | 0-3 | APPROVED |
| 0 | 4+ | REVISION (focused on WARNINGs) |
| 1-5 | any | REVISION (focused on BLOCKINGs) |
| 6+ | any | STRUCTURAL REVIEW (return to Brief Builder) |

## Runtime Output Contract

When emitting the actual review result for the runtime:

- Include exactly one structured decision tag:
  `<review_decision>APPROVE</review_decision>` or `<review_decision>REVISE</review_decision>`.
- You may place explanations, blocking issues, and warnings before or after the tag.
- Do not emit multiple decision tags.
- Treat the tag as a hard protocol requirement, not a style preference.

---

## References & Templates

| File | Content |
|---|---|
| `references/common-issues.md` | Catalog of the 30 most common business document issues with examples and fixes |
| `references/filler-phrases.md` | Comprehensive list of corporate filler with severity ratings and replacements |
| `templates/editorial-review.md` | Standard output template for the editorial review report |
