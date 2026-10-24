# Business workflow: requested YouTube document delivery

## Scope and starting conditions

The user requests a YouTube document with a purpose and output format. These
requirements remain authoritative during analysis, generation and delivery.
Existing saved plans without a document request retain their historical formats.
This flow complements [chat launch](chat-workflow-launch.md) and
[Canvas](canvas-workspace.md), whose other rules remain unchanged.

## Flow

1. Capture the source transcript and prepare each video with the user's document
   request: requested formats, takeaway or instructional purpose, and instructions.
2. Persist that request in the generation record and plan. Analyze for that
   purpose; reuse analysis only for an identical request and source revision.
3. Capture required screenshots. When Gemini is configured, review their actual
   pixels in bounded image-only batches; retain caption-to-image hashes. Without
   visual review, use neutral timestamp captions that disclose the limitation.
4. Publish only the requested formats. Markdown uses relative screenshot paths
   and includes a portable ZIP containing the same Markdown and image assets.
5. Seal and deliver the generated documents as primary artifacts. The internal
   extraction report cannot substitute for a missing document. ZIP is downloadable.
6. Open Markdown in Canvas; load images through its run's artifact endpoint and
   display local blob images under the existing desktop content policy. Image
   loads have a 30-second timeout, a 10 MiB limit and concurrency capped at four.
   Closing or changing the document cancels loads and releases image URLs.
   ZIP downloads never open or restore a Canvas preview tab.

## Alternative flows

- Transcript fallback preserves the same document request in `write_manual_plan`.
  A plan that changes that request is rejected before writing.
- Completed runs remain immutable when replayed. Replay verifies the requested
  output records and hashes; a missing or changed output refuses reuse.
- Provider review failure records a failed screenshot-review stage and propagates
  the error; it cannot publish captions as though review succeeded.
- Existing plans without a document request remain readable and retain both
  historical outputs. New `prepare_manual` tool calls require an explicit request.

## Business rules and test mapping

| ID | Required outcome | Boundary and test |
| --- | --- | --- |
| YD-01 | Validate explicit formats, purpose and instructions | Tool parser: `tests/unit/youtube-extraction.test.ts`, `new manual requests require explicit formats, purpose and user instructions` |
| YD-02 | MD-only writes no Word and includes portable images | Real filesystem/publisher: `tests/integration/youtube-requested-publication.test.ts`, `an MD-only takeaway request publishes a portable illustrated Markdown document without Word` |
| YD-03 | Preserve request across planning, build and replay | Same integration file: `a transcript plan cannot replace the format or purpose saved during preparation`, `a saved MD-only request completes and replays without a Word output or a missing-Word error`, `replay refuses a completed manifest that omits its requested document record` |
| YD-04 | Different purposes cannot share cached analysis | Same integration file: `analysis cached for takeaways cannot be reused as procedural instructions` |
| YD-05 | Ground captions in captured pixels and persist their hashes | `tests/integration/youtube-gemini-analysis.test.ts`, `screenshot review grounds captions in the captured pixels rather than the proposed video caption`; publication integration, `publication uses pixel-reviewed captions and records their image hashes` |
| YD-06 | A successful MD/ZIP result survives transport; deliver actual documents; fail report-only completion | Real workflow sealing: `tests/integration/youtube-requested-publication.test.ts`, `a completed MD-only manual and its portable ZIP cross the real tool gateway as success`; `tests/integration/workflow-publication.test.ts`, `requested Markdown is the primary delivery and an internal report cannot replace a missing document` |
| YD-07 | Canvas uses the correct artifact directory and run, and displays images under the desktop content policy | `ui/src/components/__tests__/markdown-viewer.test.tsx`, `resolves nested relative images through the run artifact endpoint`, `resolves identical Markdown in a different run against that run`; real image HTTP: `ui/src/components/__tests__/artifact-markdown-image.test.tsx`; bounded and validated loads: `ui/src/lib/clients/__tests__/artifact-image-loader.test.ts` |
| YD-08 | Download portable ZIP without a document preview | `ui/src/components/run/chat/__tests__/delivery-message-card.test.tsx`, `downloads a portable Markdown ZIP without attempting a document preview`; Canvas reconciliation: `ui/src/components/canvas/__tests__/canvas-deliveries.test.tsx`, `keeps portable ZIP downloads out of Canvas, including restored tabs` |
| YD-09 | Real video produces visible screenshots in the requested primary MD | `tests/electron/youtube-manual-workflow.live.spec.ts`, `an MD-only takeaway request delivers the real illustrated Gemini document in Canvas without Word` |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.
