# Consolidated Playbook Template

Use this template for the single `write_consolidation` artifact produced when
multiple per-video methods have been written. The result is a standalone,
reusable operating playbook, not a summary of the source videos. Persist it
through `write_consolidation` with a descriptive `fileName` (defaults to
`generalized-methodology.md`).

```
---
source_videos: [<videoId1>, <videoId2>, ...]
generated_at: [ISO 8601 timestamp]
base_artifacts:
  - output/methods/<videoId1>.md
  - output/methods/<videoId2>.md
---

# [Playbook title — name the operating method, not the source videos]

## Outcome, scope, and non-goals

**Outcome:** [What a reader can do after following this playbook.]

**In scope:** [Situations, roles, and conditions the playbook covers.]

**Non-goals:** [Adjacent problems the playbook deliberately does not address.]

## Shared principles and vocabulary

- [Term]: [definition, with source-video ID where it is introduced.]
- [Principle]: [one-line statement, with source-video ID(s) backing it.]

## Prerequisites and readiness checks

- [ ] [Required prior condition, tool, or skill — cite source-video ID.]
- [ ] [Readiness check the operator should confirm before proceeding.]

## Ordered operating procedure

1. [Step — with provenance, e.g. `(v1: 02:14, v3: 05:30)` meaning video 1 at 2:14 and video 3 at 5:30.]
2. [Step.]
3. [Step.]

## Decision rules and branches

- **If [condition]:** take [branch A]. *Sources: v1, v2.*
- **Else if [condition]:** take [branch B]. *Sources: v3.*
- **Otherwise:** [default action]. *Synthesis — no source states this directly.*

## Measurements and feedback loops

- [Metric]: [how to measure it, target range, and source-video ID.]
- [Feedback loop]: [what to adjust when the metric moves out of range.]

## Failure modes and recovery

- **Failure:** [symptom]. **Likely cause:** [cause]. **Recovery:** [step]. *Sources: [video IDs].*
- **Failure:** [symptom]. **Likely cause:** [cause]. **Recovery:** [step]. *Sources: [video IDs].*

## Source disagreements and unresolved questions

- **Disagreement on [topic]:** [video A] says [X]; [video B] says [Y]. The playbook preserves both as conditional branches above rather than merging them.
- **Unresolved:** [question no source answers]. Marked as a research item; do not fill with synthesis.

## Provenance mapping

| Playbook section | Source video | Timestamp(s) |
|---|---|---|
| [Section name] | [videoId] | [HH:MM:SS] |
| [Section name] | [videoId1, videoId2] | [HH:MM:SS, HH:MM:SS] |

(Every generalized rule must map to at least one source row. Rules with no mapping must be removed or moved to "Synthesis" with explicit labeling.)

## Synthesis

[Any agent-authored generalization that goes beyond what the sources state verbatim. Each item must be marked as synthesis and reference the closest supporting source.]
```

## Notes for the agent

- Only call `write_consolidation` after every available per-video method has been written via `write_methodology`. Do not consolidate from raw transcript fragments.
- The provenance mapping table is mandatory. Any rule without provenance must be cut or moved to the Synthesis section with an explicit label.
- Preserve meaningful disagreements as conditional branches in the procedure; do not flatten them into a single rule.
- File name should describe the method (e.g. `youtube-vc-deal-screening.md`), not the source videos.
