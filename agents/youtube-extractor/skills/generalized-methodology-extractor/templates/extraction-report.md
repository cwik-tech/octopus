# Extraction Report Template

This template defines the **only** structure the `extraction-report.md` body may take. The report is a human-readable document, not a status log — counts, per-video tables, artifact path inventories, and "items requiring user action" sections belong in the run's `output/youtube-manifest.json` and the UI's delivery panel, not in this file.

Replace every `[bracketed]` placeholder with real content drawn from the captured transcript(s). Keep all section headings, in this order. Delete optional sections only when the run did not produce them.

## Single-video (transcript-only or single-video methodology)

```
# [Video title exactly as captured]

**URL:** [canonical YouTube URL]
**Published:** [video publish date in YYYY-MM-DD or "—" when unavailable]
**Captured:** [ISO 8601 capture timestamp]

## What this video is about

[2–4 short paragraphs, or a tight bullet list, summarising what the video actually covers. Drawn strictly from the captured transcript — no external knowledge, no speculation about the speaker's intent. Use plain prose; the reader should know what they would get from watching the video.]
```

## Single-video methodology run

Append the following section after "What this video is about", instead of stopping there:

```
## Method

The full source-linked method is in [`output/methods/<videoId>.md`](output/methods/<videoId>.md).

[One short paragraph — 3–5 sentences — naming the outcome the method produces and its intended use case. Do not duplicate the contents of the method file here.]
```

## Multi-video run (playlist or channel)

Use one `## [Video title]` section per captured video, in the order they were captured. Each section uses the single-video structure above (URL, Published, Captured, "What this video is about", and — for methodology runs — a "Method" pointer to the per-video method file).

After all per-video sections, for methodology runs only, append:

```
## Consolidated playbook

The cross-video playbook is in [`output/generalized-methodology/<file>.md`](output/generalized-methodology/<file>.md).

[One short paragraph naming the scope of consolidation and which videos contributed. Do not duplicate the playbook contents here.]
```

## Notes for the agent

- The report body is persisted as `extraction-report.md` by the workflow runner. Return only the body — no YAML frontmatter, no enclosing code fences, no metadata invented by you.
- The reader is a human who wants to know what the video is about. They are not a developer debugging the run.
- Never list: status counts, per-video status tables, artifact path inventories, "delivered artifacts" lists, "items requiring user action" sections, capture method names, language codes, or attempt counters. All of that lives in the manifest and the UI delivery panel.
- If a transcript capture failed for a specific video, mention it briefly inside that video's section in one sentence ("Transcript unavailable — captions were disabled."). Do not add a separate failures section.
- For runs where every capture failed (zero successful transcripts), the body is a single sentence: "No transcripts could be captured for [source URL]. See the run's manifest for per-video failure detail."
- Title, URL, and publish date must come from the `capture` / `capture_authenticated` tool result. Never guess them from the URL or browser text.
