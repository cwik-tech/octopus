# Evidence model

Classify claims by what the record can establish. Confidence is not a vote count, and a polished explanation is not stronger evidence.

## Claim classes

### Current mechanics

Directly observed in the current code, configuration, tests, or runtime behavior.

Use this class for statements about what the system now does. Current mechanics may constrain possible explanations, but code shape alone does not establish historical intent.

### Stated rationale

An identifiable source explicitly gives a reason for the decision. Examples include a contemporary review comment, decision record, issue, commit message, code comment, or incident action item.

Phrase the claim as attribution when one source is involved:

> The pull-request author said the limit was added to match the upstream API maximum.

Use an unqualified causal statement only when the cited record is explicit, relevant to the exact code, and not materially contradicted. Even then, distinguish the stated reason from objective truth.

### Supported interpretation

No source states the full conclusion, but several relevant facts support it. Explain the reasoning step and cite each fact.

Check independence before treating several records as corroboration. A ticket, document, and chat message that repeat the same copied sentence are one lineage, not three independent sources.

### Hypothesis

A plausible explanation with limited or ambiguous support. State what supports it, what weighs against it, and what evidence would distinguish it from alternatives.

Do not promote a hypothesis because it makes the current design look sensible.

### Unknown

The available record does not answer the question. Name what was searched, what was unavailable, and who or what might resolve it.

Unknown is a valid result. Do not fill it with a likely-sounding story.

## Evidence dimensions

Assess each important item on these dimensions:

- **Explicitness:** Does it state a reason, describe an event, or merely correlate with one?
- **Proximity:** Was it created by a decision participant, an observer, a later summarizer, or an automated system?
- **Timing:** Is it contemporary with the decision or retrospective?
- **Specificity:** Does it refer to the exact code or only a related feature?
- **Independence:** Does it add new evidence or repeat another record?
- **Authority:** Could the author make or accurately report the decision?
- **Consistency:** Does shipped behavior match the documented plan?
- **Completeness:** Is the source intact, searchable, and within retention and permission limits?

Do not collapse these dimensions into a numeric score. Explain the ones that materially affect the conclusion.

## Search results are not historical facts

Record an empty search as:

> No relevant result was found for these queries in this source, within the searched date range and current access.

Do not rewrite that as:

> The decision was never discussed here.

Evidence of absence requires a source expected to be complete for the exact event, a query that would reliably match it, suitable access, and applicable retention. That standard is rarely met for chat, documents, issue trackers, telemetry, or rewritten repository history.

## Contradictions and supersession

When sources disagree, preserve the chronology and attribution:

- the original proposal may explain the initial motivation;
- review discussion may explain why the implementation changed;
- the shipped code establishes what happened;
- a later document may explain why the behavior was retained or replaced.

Do not choose the neatest account. State whether the disagreement is unresolved, reflects a change of mind, or concerns different stages of the decision.

## Citation standard

A citation should let the reader verify the claim without repeating the investigation. Prefer stable links or identifiers and include a file and line, commit, review, issue, document section, incident, query, dashboard, or message permalink as appropriate.

Use short excerpts only when exact wording matters. Paraphrase routine material. Remove secrets, tokens, personal data, customer identifiers, and unrelated content.
