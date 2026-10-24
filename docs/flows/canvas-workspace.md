# Business workflow: view chat documents in Canvas

## Scope and starting conditions

A saved chat has delivered files. Canvas supplies document tabs and window
modes, Markdown working copies, reviewed agent proposals, verified origin
snapshots and sandboxed HTML previews. See the
[Canvas guide](../feature-canvas.md) for the API, presentation lifecycle and limits.

## Flow

1. A new file delivered during the active chat visit opens automatically in the
   existing detached window, or reveals the existing application Context sidebar. Historical
   deliveries do not reopen closed tabs. Manually open a delivered file to reopen it; the same file selects the
   existing tab and a different run/path gets a distinct tab.
2. Switch tabs, close them or hide Canvas. Closing does not delete any file.
3. Return to the saved chat to restore its tab set in the docked pane.
4. Expand within the conversation workspace, keeping the app header usable, or detach the workspace into one Canvas-only window.
5. Close the detached window to return the tabs to the source pane if that
   chat is still selected. Otherwise preserve state for its next visit.
6. For Markdown, create a working copy only from bytes matching an authoritative
   publication digest or the exact accepted file-creation receipt's argument
   digest. Legacy files need not have a digest on their delivery when that
   original receipt verifies their filename and content. Edit and save against its current revision; preserve the
   original generated file and retain unsaved local text across incoming changes.
7. Select text and request an agent revision. Review the captured selection and
   proposed replacement, then accept or discard. A stale base or unsaved draft
   prevents acceptance; review the current text and request a fresh proposal.
8. Office files are preview/download only in Canvas. Request revisions in the main chat and receive a new file; older deliveries stay available. Internal source Markdown paired with Word/Excel is not a chat card or Canvas tab. Explicit final Markdown deliveries remain visible.
9. For HTML, switch between isolated interactive preview and source. A failed
   refresh retains the prior preview. Generated code cannot reach the app,
   local files, network, other windows or navigation outside its preview.

## Rules and test mapping

Execution results and current verification gaps are recorded only in Status.

| Rule | Outcome | Test |
| --- | --- | --- |
| CW-01 | File identity, tab selection, close/reopen and persisted restoration | `tests/electron/canvas-workspace.spec.ts`, J1; `tests/unit/canvas-workspace.test.ts` |
| CW-02 | State is scoped to its real saved chat; invalid/foreign input cannot mutate it; delayed old-chat actions cannot replace a new chat, including its lower revision | `tests/integration/canvas-workspace-api.test.ts`; `ui/src/components/canvas/__tests__/canvas-session-scope.test.tsx` |
| CW-03 | Concurrent tab actions preserve committed effects; corruption is never overwritten | Same integration file |
| CW-04 | Expansion stays below the app header with usable dock controls; expanded and detached views preserve tabs; native close reattaches; revisit is docked | `tests/electron/canvas-workspace.spec.ts`, J2; whole-process restart remains a verification gap |
| CW-05 | Duplicate detach preserves source and reuses one destination | J2; general open-failure coverage in existing app-window tests; Canvas-specific load-failure injection remains a gap |
| CW-06 | Markdown renders; the content API preserves HTML source for the isolated viewer; binary downloads preserve exact bytes | J1; HTML content integration test; `tests/integration/canvas-binary-download.test.ts` through real HTTP; dedicated binary desktop journey remains a gap |
| CW-08 | Canvas occupies the existing application Context sidebar; its title-bar control and divider work, and closing removes Canvas content and restores chat width | `tests/electron/canvas-workspace.spec.ts`, J3; `ui/src/hooks/__tests__/use-right-sidebar.test.tsx` |
| CW-07 | New deliveries automatically select tabs in the existing detached window or reveal a hidden Context sidebar; historical deliveries and re-renders respect closed tabs; portable ZIP downloads never open or restore preview tabs | `tests/electron/canvas-workspace.spec.ts`, J3; `ui/src/components/canvas/__tests__/canvas-deliveries.test.tsx` |
| CW-09 | Verified Markdown copies admit real file-tool deliveries and digestless legacy deliveries whose accepted creation receipt matches, save independently of the original, reopen with saved text, remain usable if the original disappears, and retain drafts across incoming saves | `tests/electron/canvas-editing.spec.ts`: `a Markdown working copy survives reopening while its original download stays unchanged`, `a second view receives saved revisions while keeping its unsaved local draft`, `the Original file pen edits an earlier Markdown output using its accepted creation receipt`; `ui/src/components/canvas/__tests__/canvas-markdown-origin.test.tsx`; `tests/integration/canvas-file-origin.test.ts`; `tests/integration/execution-journal-read-bounds.test.ts`; document store/API tests |
| CW-10 | Selected-text proposals require explicit acceptance against the captured current base; discard, conflict and replay cannot overwrite newer text | `tests/integration/canvas-documents.test.ts`, `canvas-documents-api.test.ts`; `tests/unit/canvas-documents.test.ts`; `tests/electron/canvas-editing.spec.ts`: `a selected-text revision stays unchanged until accepted and discarded proposals never apply`; editor race/action tests |
| CW-11 | HTML has an isolated interactive preview in Electron and source view; browser UI shows only source; failed refresh keeps the loaded document | `tests/electron/canvas-html-preview.spec.ts`, J4/J5; `ui/src/components/canvas/__tests__/canvas-html-preview.test.tsx` |
| CW-12 | Detached Canvas inherits the chosen theme and follows later changes in other app windows | `tests/electron/canvas-theme.spec.ts`: `detached Canvas follows theme changes and newly opened Canvas inherits light mode`; `ui/src/hooks/__tests__/use-theme.test.ts` |
| CW-13 | Delivered DOCX, XLSX and PPTX open an isolated offline Office preview in the existing Canvas; refresh failure retains the last preview and conversion never writes the origin | `tests/electron/canvas-office-preview.spec.ts`; Office admission/process integration tests mapped in `docs/work/2026-10-19-officecli/implementation.md` |
| CW-14 | Internal retained-copy admission (not exposed in Canvas) requires captured bytes matching every available delivery and exact-attempt publication digest; contradictory records refuse editing. Retained original/current downloads survive origin removal | `tests/integration/canvas-office-documents.test.ts`: `Office admission refuses disagreement between delivery and exact task publication digests`, `a verified binary working copy and retained original survive the live origin disappearing` |
| CW-15 | Internal Office candidates (not exposed in Canvas) require explicit Accept against their captured revision; Discard, replay, interruption and session deletion cannot publish a late result | `tests/unit/canvas-office-documents.test.ts`: `a ready Office candidate changes the saved binary only after acceptance and terminal replay never applies twice`; `tests/integration/canvas-office-proposals.test.ts`: `a late provider response after discard cannot replace a newer proposal on the same saved revision`; `office-session-lifecycle.test.ts`: `single, bulk and direct deletion cancel owned work before removing its session` |
| CW-16 | Word snapshots use saved Markdown and captured safe image bytes; later saves report stale, binary edits fork, and obsolete lookup responses cannot erase a generated snapshot | `tests/integration/canvas-word-snapshot.test.ts`: `Word snapshots use a saved Markdown revision and report later saves as out of date`; `ui/src/components/canvas/__tests__/canvas-word-snapshot.test.tsx`: `keeps a newly generated snapshot when an older state lookup finishes later`; `tests/electron/canvas-office-preview.spec.ts`: `a saved Markdown revision produces a Word snapshot and a later save marks it out of date` |

| CW-17 | Office Canvas exposes preview/download without source, copy-management or revision controls. Internal paired Markdown sources remain persisted for chat context but are hidden from cards and Canvas; explicit final Markdown stays visible. | `ui/src/components/canvas/__tests__/canvas-office-document.test.tsx`: `opens %s as a document preview without source or editing controls`; `delivery-message-card.test.tsx`: internal-source and explicit-Markdown cases; `canvas-deliveries.test.tsx`: restored source tab reconciliation; `tests/electron/office-chat-delivery.spec.ts`: Word/Excel revisions deliver new files and preserve older downloads; `canvas-office-preview.spec.ts`: preview-only Word/Excel |

Relative Markdown screenshots resolve through the current artifact directory and run.
Their portable bundle and delivery rules are specified in
[requested YouTube document delivery](youtube-requested-delivery.md).

## Limits and related flows

Document consumption is unchanged: viewing a file does not admit it into agent
context. Multiple chat windows remain independent chat views; Canvas windows
have their own explicit destination. Existing folder capabilities and tool
creation/publication rules remain unchanged.
