---
name: brief-scoping
description: >
  Protocols for transforming raw inputs into structured writing briefs. Covers audience analysis,
  template matching, gap detection, and section-level guidance generation. Core skill for the
  Brief Builder agent.
  Use when turning a document request into a structured writing brief.
---

# Brief Scoping Skill

## When to Use

On every document request before any drafting begins. The Brief Builder runs this skill to convert raw notes, data, and context into a structured brief that the Writer can execute.

---

## Scoping Protocol

### Step 1 — Input Triage

Classify the raw inputs before analyzing them:

**Input types (in order of reliability):**

1. **Structured data:** Spreadsheets, databases, reports with clear metrics. Highest reliability — use numbers directly.
2. **Meeting notes / transcripts:** Rich in context but messy. Extract key decisions, action items, and stakeholder positions. Watch for contradictions between what was said and what was decided.
3. **Prior documents:** Previous deliverables, proposals, or reports. Extract structure, terminology, and client preferences. Check if the new document should align with or depart from prior work.
4. **Verbal instructions:** Direct from the user. Often incomplete — the user knows more than they've said. This is where gap detection matters most.
5. **Email threads / messages:** Context-rich but scattered. Extract the core ask, the stakeholders, and any deadlines or constraints.

**For each input, note:**
- What it tells you (facts, data, context)
- What it assumes (unstated knowledge)
- What it's missing (gaps you'll need to flag)

### Step 2 — Audience Profiling

Build a reader profile before anything else. The entire brief depends on this.

**Primary reader assessment:**

| Factor | Question | Impact on Brief |
|---|---|---|
| Role | What is their title and decision authority? | Determines document scope and recommendation format |
| Expertise | How much do they know about this topic? | Determines how much background/context is needed |
| Time | How long will they spend reading? | Determines document length and summary requirements |
| Motivation | What do they want from this document? | Determines whether to lead with recommendations, data, or options |
| Skepticism | How much convincing do they need? | Determines evidence density and argument strength required |
| Action | What will they do after reading? | Determines what the document must make easy (decide, approve, delegate, share) |

**Audience archetypes for business consulting:**

1. **The Decision-Maker (C-suite, board member):** Wants recommendations, not analysis. Lead with the answer. Keep it under 5 pages. Every sentence must earn its place.
2. **The Evaluator (VP, director):** Wants options with trade-offs. Needs enough detail to defend their choice upward. 5-15 pages is acceptable if structured for scanning.
3. **The Implementer (manager, team lead):** Wants specifics — what to do, when, how. Tolerates length if it's actionable. Detail is a feature, not a bug.
4. **The Stakeholder (cross-functional peer):** Wants to understand impact on their area. Needs clear sections they can jump to. May only read 2-3 sections.
5. **The External Client:** Wants to feel confident in the consultant's expertise. Needs professional formatting, clear reasoning, and no jargon without definition.

### Step 3 — Template Matching

Match the task to a document template. This is a classification problem, not a creative choice.

**Matching criteria (in priority order):**

1. **Document purpose:** What is the document trying to accomplish?
   - Recommend a course of action → Strategic Recommendation
   - Persuade someone to engage / buy → Project Proposal
   - Report findings from an investigation → Assessment / Audit Report
   - Summarize a collaborative session → Workshop Summary
   - Update on progress → Status Update

2. **Audience expectation:** What format does the reader expect?
   - Board expects memos, not reports
   - Clients expect polished deliverables, not internal notes
   - Technical teams expect detail, not executive summaries only

3. **Content shape:** What does the material naturally look like?
   - Heavy on options and trade-offs → Recommendation template
   - Heavy on findings and evidence → Assessment template
   - Heavy on next steps and timelines → Status Update template

**When no template fits:**
- State what template comes closest and why it doesn't fully fit
- Describe what a custom template would need: sections, structure, tone
- Recommend creating the custom template before proceeding to draft

**Confidence levels:**
- **High:** Template purpose matches document purpose exactly. Sections map cleanly to available content.
- **Medium:** Template is close but may need a section added or removed. Proceed but note the modification.
- **Low:** Forcing it. Consider a different template or a custom build.

### Step 4 — Style Profile Matching

Select the writing style based on audience and purpose.

**Decision matrix:**

| Audience | Purpose | Recommended Profile |
|---|---|---|
| C-suite / Board | Recommend | strategic-consulting when the document needs consultant-style synthesis; otherwise executive-concise |
| C-suite / Board | Inform | strategic-consulting for board summaries, strategy syntheses, and executive one-pagers; otherwise executive-concise |
| Technical team | Analyze | analytical-detailed |
| Workshop group | Align | collaborative-warm |
| External client (persuade) | Propose | proposal-persuasive |
| External client (inform) | Report | analytical-detailed |
| Internal team | Update | collaborative-warm |

**Override rules:**
- If the user specifies a tone ("make it punchy," "keep it formal"), override the matrix
- If the client has established preferences from prior work, match those
- If the document will be read by mixed audiences, default to the most senior reader's preferences

### Step 5 — Gap Detection Protocol

Scan all inputs against the template requirements. Classify every gap.

**Hard gaps (BLOCKING — brief cannot proceed):**

- Template requires a section but zero input data exists for it
- Audience is unidentified or ambiguous
- Document purpose is unclear or contradictory
- Key data referenced in inputs is not actually provided ("see attached" with no attachment)

**Soft gaps (NON-BLOCKING — brief proceeds with a note):**

- A section could be stronger with additional data but can be written with what's available
- Competitor data would add context but isn't essential to the argument
- Historical context would help but the document works without it

**Assumption gaps (FLAG — the reader may not share these):**

- Inputs reference events, acronyms, or internal terms the reader may not know
- The argument assumes a shared understanding of a problem that hasn't been proven
- Prior decisions are referenced without explanation of why they were made

**Data gaps (QUANTIFY — specify what's missing):**

- "Strong growth" mentioned but no numbers provided
- "Customer satisfaction is high" without NPS, CSAT, or retention data
- Financial projections referenced but not included
- Benchmarks needed for comparison but not supplied

**For each gap, document:**
1. What's missing
2. Which template section it affects
3. Whether it's blocking or non-blocking
4. How to resolve it (who to ask, where to find it)

### Step 6 — Section Guidance Generation

For every section in the chosen template, produce a directive for the Writer:

**Section guidance format:**

```
Section: [Name]
Purpose: [What this section accomplishes for the reader]
Content direction: [What to write about — key points, arguments, narrative arc]
Data to include: [Specific data points, metrics, quotes from the inputs]
Data to avoid: [Anything from inputs that should NOT go here]
Tone note: [Section-specific tone guidance if different from overall profile]
Length: [Short (1-2 paragraphs) / Medium (3-5 paragraphs) / Long (1-2 pages)]
Dependencies: [Does this section depend on another section's content?]
```

**Rules for section guidance:**
- Every section must have at least a content direction — no blank guidance
- If a section has a gap, the guidance must name the gap and say what to do about it (placeholder, write around it, or skip pending data)
- Length estimates should total to a reasonable document length for the audience
- Dependencies matter — the Writer needs to know if Section 4 must reference Section 2's findings
- When a concrete template is selected, section guidance must use the template's section names in the same order rather than renaming them into synonyms

---

## References & Templates

| File | Content |
|---|---|
| `references/audience-archetypes.md` | Detailed profiles of common business consulting audiences with reading preferences and expectations |
| `references/gap-classification.md` | Extended examples of hard, soft, assumption, and data gaps with resolution strategies |
| `templates/writing-brief.md` | Standard output template for the structured writing brief |
