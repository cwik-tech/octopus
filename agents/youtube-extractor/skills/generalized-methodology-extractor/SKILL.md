---
name: generalized-methodology-extractor
description: Extract an actionable, source-linked method from one or more captured YouTube transcripts and optionally consolidate the methods into a reusable playbook. Use only when the user explicitly asks for a methodology, process, framework, playbook, operating system, or cross-video synthesis; do not activate for transcript-only requests.
---

# Generalized Methodology Extractor

Transform conversational transcripts into faithful operating guidance. Keep extraction and synthesis separate so the result remains traceable to each source.

## Templates

Author every artifact by copying and filling the matching template. Do not improvise structure.

- `templates/extraction-report.md` — the run's final report. Always produced. A short human-readable document with the video title, URL, publish date, and a plain-language summary of what the video is about. The report is for a human reader, not a developer debugging the run — it must not contain status tables, artifact path inventories, capture-method names, or user-action sections. That information lives in the run's `output/youtube-manifest.json` and the UI delivery panel.
- `templates/source-method.md` — one per video, persisted via `write_methodology` as `output/methods/<videoId>.md`.
- `templates/consolidated-playbook.md` — one per multi-video run, persisted via `write_consolidation` under `output/generalized-methodology/`.

The reference contracts (`references/extraction-contract.md` and `references/consolidation-contract.md`) are the maintainer-facing spec the templates implement. When templates and contracts disagree, the contract is authoritative.

## Workflow

1. Confirm that the user requested methodology extraction. For transcript-only requests, stop after transcript capture and still write `extraction-report.md` from the template.
2. Capture transcripts with `youtube_extract`. Never infer a method from titles, descriptions, or partial browser text when a transcript is available.
3. For each successful video, read every transcript chunk in order with `read_transcript`.
4. Extract one source method per video by filling `templates/source-method.md`. Preserve the speaker's terminology, prerequisites, sequence, decisions, examples, failure conditions, and caveats. Mark interpretation explicitly.
5. Save each method with `write_methodology` using the source video ID.
6. For multiple videos, consolidate only after all available source methods are saved. Fill `templates/consolidated-playbook.md`, merging equivalent concepts, retaining meaningful disagreements, and distinguishing source-backed rules from synthesis.
7. Save the final playbook with `write_consolidation`.
8. Always finish by composing `extraction-report.md` from `templates/extraction-report.md`.

## Source Method Contract

Each source method must be independently usable and auditable. The template's section order is mandatory. Include source metadata, intended outcome, prerequisites, ordered steps, decision points, named tools, examples, metrics, failure modes, caveats, ambiguities, and timestamped provenance.

Use these evidence labels where interpretation matters:

- `Source states` for a claim directly supported by the transcript.
- `Source demonstrates` for an example shown or narrated.
- `Interpretation` for a reasonable implication not explicitly stated.
- `Unresolved` when the transcript does not support a reliable conclusion.

Never fill a gap with general knowledge without marking it as interpretation. See `references/extraction-contract.md`.

## Consolidation Contract

Consolidation combines completed per-video methods, not raw transcript fragments. De-duplicate equivalent steps while preserving differing prerequisites, sequencing, and scope.

Every generalized rule must map to one or more video IDs and timestamps in the provenance mapping table. Represent material disagreement directly as conditional branches. The result must separate source consensus, source-specific variants, agent synthesis, and unresolved questions. See `references/consolidation-contract.md`.

## Quality Gate

Before saving, verify that every transcript chunk was read, every key step is traceable via the provenance mapping, ordering is preserved where it matters, caveats survived compression, and no missing transcript was treated as evidence.
