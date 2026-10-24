---
name: style-execution
description: >
  Protocols for executing different writing registers based on style profiles. Covers tone
  calibration, formality shifting, sentence construction, hedging control, and vocabulary
  management. Core skill for the Writer agent.
  Use when applying the requested voice, tone, and style to a draft.
---

# Style Execution Skill

## When to Use

On every document draft. The Writer reads the active style profile (YAML) and uses this skill to translate those settings into actual prose. This skill is the bridge between "authoritative, direct" as a profile setting and sentences that actually sound authoritative and direct.

---

## Style Profile Interpretation

### Reading a Style Profile

Every style profile contains these fields. Here's how to translate each into writing decisions:

**`tone`** — The overall emotional register of the writing.

| Tone value | What it sounds like | Example |
|---|---|---|
| authoritative | Confident, decisive, no hedging. The writer knows and states. | "The data confirms product-market fit. The company should expand into enterprise." |
| collaborative | Inclusive, shared ownership, "we" language. | "Together, we identified three areas where the team can accelerate delivery." |
| analytical | Measured, evidence-first, careful. Conclusions follow data. | "The retention data, while encouraging at 78%, falls below the 85% benchmark for this segment, suggesting further investigation." |
| persuasive | Compelling, builds momentum, emphasizes benefits and urgency. | "This is the strongest pipeline the company has seen in three years — and the window to act is narrowing." |
| neutral | Factual, observational, no advocacy. Presents without pushing. | "The report covers three scenarios. Each carries different risk-return profiles." |

**`formality`** — Controls vocabulary, contractions, and sentence structure.

| Level | Contractions | Vocabulary | Sentence structure |
|---|---|---|---|
| high | Never | Formal business language. "Consequently," "Furthermore," "It is recommended that" | Longer, more complex. Subordinate clauses permitted. |
| medium | Sparingly | Professional but accessible. "So," "This means," "We recommend" | Mixed length. Clear and direct with occasional complexity. |
| low | Freely | Conversational. "Here's the thing," "Let's look at," "Bottom line" | Short. Punchy. Direct. |

**`sentence_length`** — Controls prose rhythm.

| Setting | Average sentence length | Rhythm |
|---|---|---|
| short | 8-12 words | Staccato. Punchy. Each sentence one idea. |
| short-to-medium | 10-18 words | Mostly crisp. Occasional longer sentence for flow. |
| medium | 15-22 words | Balanced. Natural reading cadence. Mix of simple and compound. |
| medium-to-long | 18-28 words | More developed thoughts. Subordinate clauses, qualifications, and nuance. |
| long | 25-35 words | Dense. Academic feel. Multiple ideas per sentence. Use sparingly. |

**`voice`** — Active vs. passive preference.

| Setting | Rule | Example |
|---|---|---|
| active preferred | Default to active. Use passive only when the actor is genuinely unknown or irrelevant. | "The team completed the migration in 6 weeks" not "The migration was completed in 6 weeks" |
| passive acceptable | Active when the actor matters. Passive when the focus should be on the action or result. | "The system was redesigned to handle 3x throughput" (focus on the system, not who redesigned it) |

**`person`** — Narrative perspective.

| Setting | Usage | When |
|---|---|---|
| first person plural ("we") | "We recommend," "Our analysis shows" | Client deliverables where the consulting firm is the author |
| third person | "The analysis shows," "The data indicates," "The company should" | Independent reports, assessments, documents that need objectivity |
| second person ("you") | "You should consider," "Your team can" | Workshop outputs, coaching documents, advisory notes |

**`hedging`** — How confidently to state conclusions.

| Setting | Permitted phrases | Forbidden phrases |
|---|---|---|
| minimal | "The data shows," "This confirms," "We recommend" | "It might be worth considering," "Perhaps," "It could be argued that," "One possibility is" |
| moderate | "The evidence suggests," "This likely indicates," "We believe" | "It could be argued that," "One might say" |
| heavy | "The evidence suggests," "It appears that," "This may indicate" | Nothing forbidden — but every hedge should be earned with genuine uncertainty, not habit |

---

## Register Shifting Protocol

When the style profile changes between documents (or between sections within a document), follow this protocol:

### Step 1 — Identify the target register

Read the profile. Map tone + formality + sentence_length to a "voice" in your head. Write a mental sample sentence before drafting.

### Step 2 — Calibrate with a test paragraph

Write the first paragraph of the document. Read it back. Ask:
- Does it match the tone? (Would the target reader feel the right thing?)
- Does it match the formality? (Any contractions that shouldn't be there? Any stiffness that shouldn't be there?)
- Does it match the sentence length? (Count the words per sentence in the first paragraph.)

### Step 3 — Maintain consistency

Once calibrated, maintain the register throughout. Common drift patterns to watch:

- **Formality drift:** Starting formal and becoming casual as you write more (fatigue-driven). Check the last page against the first page.
- **Hedging creep:** Starting with confident statements and gradually adding more qualifiers as uncertainty increases. If uncertainty is real, acknowledge it explicitly — don't let it leak into every sentence.
- **Sentence length inflation:** Starting with crisp sentences and writing progressively longer ones. Reset after every section break.

---

## Vocabulary Management

### Forbidden phrases (all profiles)

These phrases are banned across all style profiles because they consistently weaken business writing:

| Phrase | Problem | Replace with |
|---|---|---|
| "leverage synergies" | Meaningless jargon | Name the specific synergy and how it's used |
| "holistic approach" | Vague | Name the specific components of the approach |
| "best-in-class" | Unsubstantiated superlative | Cite the benchmark or remove |
| "move the needle" | Vague | State the specific metric and expected change |
| "drive value" | Meaningless | State what value, for whom, measured how |
| "strategic alignment" | Filler | State what is aligned with what and why it matters |
| "going forward" | Unnecessary | Delete — the reader knows you mean the future |
| "at the end of the day" | Filler | Delete entirely |
| "in terms of" | Wordy | Replace with "for" or restructure the sentence |
| "it should be noted that" | Empty intro | Delete — just state the thing |
| "it is important to" | Weak | State the thing directly. If it's in the document, you've already decided it's important |
| "key takeaway" | Overused | "The central finding is" or just state it |

### Abbreviation policy

Per style guide: always define abbreviations on first use. Write the full term first, followed by the abbreviation in parentheses. After the first definition, the abbreviation can be used freely.

**Example:** "The project achieved a Net Promoter Score (NPS) of 72. This NPS exceeds the industry benchmark by 15 points."

**Exception:** Universally known abbreviations (CEO, CFO, ROI, KPI, Q1-Q4) can be used without definition in documents for business-literate audiences.

---

## Paragraph Construction

### Structure

Every paragraph should follow one of these patterns:

1. **Claim → Evidence → Implication:** "Revenue grew 23% [claim]. This was driven by a 40% increase in enterprise contracts [evidence]. If enterprise growth continues at this rate, the company will reach profitability 6 months ahead of plan [implication]."

2. **Context → Point → Significance:** "The mid-market segment has been the company's primary revenue source for five years [context]. This segment is now showing signs of saturation, with new customer acquisition declining for three consecutive quarters [point]. Without a new growth vector, the company's top-line growth will flatten within 12 months [significance]."

3. **Problem → Cause → Consequence:** "Customer churn increased to 8% in Q3 [problem]. Exit surveys cite pricing as the primary driver, with 67% of churned customers switching to lower-cost alternatives [cause]. At this churn rate, the company will need to acquire 1,200 new customers per quarter just to maintain current revenue [consequence]."

### Length rules

- **Maximum:** 6 sentences per paragraph. If longer, split.
- **Minimum:** 2 sentences. A one-sentence paragraph is a heading, not a paragraph (exception: for deliberate emphasis in low-formality profiles).
- **Variety:** Alternate between 3-sentence and 5-sentence paragraphs. Monotonous length creates monotonous reading.

---

## References & Templates

| File | Content |
|---|---|
| `references/register-examples.md` | Before/after examples of the same content written in different style profiles |
| `references/banned-phrases.md` | Extended list of corporate filler with replacements, organized by severity |
| `templates/style-calibration.md` | Calibration checklist for confirming a draft matches its target profile |
