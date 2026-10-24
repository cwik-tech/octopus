# Canvas document workspace

Canvas keeps files from a saved chat open in tabs in the existing application
Context sidebar.
Canvas supports tabbed viewing, window management, Markdown working copies
with reviewed agent revisions, isolated interactive HTML previews, Office previews
and reviewed binary edits, and saved-Markdown Word snapshots.

## Open and manage files

New files delivered while a chat is open automatically open and select a tab.
If Canvas is detached, they appear in that same window; otherwise the right-hand
sidebar opens, including when it was hidden. Historical deliveries loaded on a
later visit do not reopen closed tabs.

Use **Open full view** to reopen a delivered Markdown or text file. Canvas selects an
existing tab when that exact run/path is already open; different files can
have the same display name. Binary delivery cards also offer **Open in Canvas**.

Select a tab to switch documents. Its close button removes only the tab;
the saved file remains available from the chat. **Hide Canvas** hides the pane;
the existing title-bar **Show inspector** control restores it. Returning to a chat or restarting
the app restores the saved tab list and selection in the docked pane.

Markdown renders with document links. HTML offers **Preview** and **Source**.
SVG and other text appear as source. DOCX, XLSX and PPTX use a local Office
preview; PDF, video and unsupported files keep download fallback.
Existing standalone spreadsheet previews outside Canvas remain unchanged.

## Change the view

- Drag the application’s existing right-sidebar divider to resize it. The
  sidebar retains the same shell, background, spacing and title-bar controls as
  the main branch. The chat resizes alongside it.
- **Expand Canvas** fills the conversation workspace below the app header;
  **Dock Canvas** returns to the previous sidebar width. The app header remains
  visible and usable in both modes.
- **Open Canvas in new window** detaches the entire workspace. Its window has
  document tabs, not a second chat. Opening it again reuses the same window.
- Close that window, or choose **Return to chat pane**, to reattach. If the
  source now shows another chat, it stays there; the saved workspace reappears
  docked when its original chat is selected again.
- Closing the source chat window does not close the detached Canvas. Detached
  placement is transient and is never automatically restored after restart.
- New document windows inherit the chosen application theme, and open windows
  follow subsequent light/dark changes.

## Edit Markdown and review agent revisions

Choose the pen icon (**Edit Markdown**) beside the original-file controls to
create a saved working copy from a verified original. The original chat download
stays unchanged. Older file-tool deliveries can recover verification from the
accepted creation receipt when its recorded argument digest matches the exact
filename and content. If no trusted proof can be recovered for that exact delivery,
trusted records disagree, or current bytes do not match, the file stays read-only
with an explanation.

Edit the Markdown source and choose **Save changes**. **Preview Markdown** shows
the current draft. Closing a tab and reopening it restores the working copy.
Unsaved drafts are retained locally for that window; another window can explicitly
recover a retained draft. A close with unsaved changes is protected. When another
view saves, a clean editor follows the saved revision. An editor with local changes
keeps them and offers the saved revision for comparison rather than overwriting.

Save any local changes, select text (or place the cursor for an insertion), enter
a **Revision instruction**, then choose **Request revision**. The application
default model receives the captured selection and bounded surrounding context;
the server binds the proposal to that document revision. Review the
captured selection and proposed replacement before **Accept revision**, or choose
**Discard revision**. Acceptance changes only the captured range and creates one
saved revision. Local unsaved edits or a newer saved revision prevent acceptance.
For a conflict, compare the original base, proposed replacement and current text;
select the intended range in the current version and request a fresh revision.

Working documents and retained origin snapshots live in the owning session's
`canvas-documents` directory. Document writes and proposal dispositions share one
atomic aggregate under the existing session lock. The latest proposal and at most
64 prior terminal proposal records are retained. There is no general revision-history
browser or automatic merge of conflicting drafts.

Legacy creation-proof lookup reads at most 16 MiB and 20,000 journal events,
checks at most 256 creation receipts, and bounds each retained result at 64 KiB.
These are read-only inspection limits; they do not alter existing journal defaults.

## Preview and revise Office files

Open a delivered DOCX, XLSX or PPTX in Canvas. DOCX cards offer **Open in Canvas**;
workbook and slide cards use **Open full view**. The packaged OfficeCLI converts
captured bytes locally. Sheets and slides retain their own navigation; arrow
keys navigate slides. Refresh failure preserves the last loaded preview.
Previews use local fonts and can differ from Microsoft Office in pagination,
equations, charts and unsupported media. No native Office installation or
runtime download is used. Missing native payloads leave the original download
available. The original delivery remains unchanged.

Canvas is a read-only Office viewer. It has no working-copy, retained-original,
revision-instruction, acceptance or Preview/Source controls. Request changes in
the main chat, for example “Revise the Word report and return a new Word file.”
The new file is delivered in chat; the earlier delivery remains available.

Word and Excel generation can retain Markdown internally for chat context and
regeneration. A secondary `.md` file is hidden from delivery cards and automatic
Canvas tabs when it belongs to the same run as a Word/Excel output and either
its title identifies it as Markdown source or its filename stem matches that
Office file.
Previously restored source tabs are closed without deleting their files.
Explicit final Markdown deliveries and unrelated supporting files remain visible.

Downloaded files edited in Word or Excel do not currently save back into chat.
Future save-back must identify the exact document version and keep its source
provenance current, or mark the old Markdown source stale rather than using it
as the edited file's authoritative content. Automatic save-back is not part of
this viewer.

## Generate Word from saved Markdown

With a verified Markdown working copy, save local changes and choose
**Generate Word snapshot**. The built-in business-report profile converts the
saved revision; it never uses unsaved text. Safe relative image bytes are copied
into private staging and retained by digest. External images remain links and
Mermaid diagrams remain code with a notice. No arbitrary profile, browser or
source-directory option is exposed.

Download the generated `.docx` or choose **Preview Word snapshot**. A later
Markdown save marks it out of date, including a save during generation. Regenerate
to publish a new binary revision. Accepted binary edits mark the snapshot as a
fork; they never merge into Markdown. Its retained provenance records source
revision, digest, assets and generation options.

## Preview generated HTML

**Preview** supports local JavaScript interactions and embedded styles and media.
**Source** displays the fetched HTML exactly. Switching views keeps the running
preview. A pending or failed refresh retains the last loaded document.
Outside Electron, the browser UI displays source only because it lacks the native
navigation guard.

Two sandboxed frames isolate generated code from the application. The packaged
preview wrapper has its own restrictive Content Security Policy. Generated code
cannot read application state, local files or storage, fetch network resources,
submit forms, create popups, or navigate to external or application pages.
Non-fragment links and form submissions are cancelled. Generated scripts can
still replace their own preview with a blank document. Remote scripts, styles,
images and nested documents are unavailable. This is a document preview;
it does not provide a general browser session.

## Content and errors

The original-file preview is read-only; its status tooltip identifies its origin as unverified.
A file path is not proof of an immutable published revision. Viewing a
file does not select it as agent context or create an editable working copy.
The explicit editing and selected-text revision actions above establish their own
verified input boundary.

**Refresh** reloads the current file inside its existing tab. Previous content
stays visible while refreshing or after a failed refresh; the error offers
download/retry rather than closing the window. Refresh does not automatically
follow arbitrary external file edits. New generated files are available from
their delivery cards and automatically open during the active chat visit.

Text previews are limited to 2 MiB; larger or unsupported files remain
downloadable. A workspace supports up to 32 tabs and at most 64 KiB of encoded
tab metadata. Close a tab if either limit is reached.

The local API saves references under the owning session's `canvas.json`, using
the same session lock as deletion. Actions are serialized rather than replacing
the whole workspace from a renderer. Corrupt or symlinked state is refused and
not overwritten. A missing file stays an unavailable tab; another file with the
same name is never silently substituted. Missing/deleted chats cannot receive
new Canvas state.

Implementation entry points: `contracts/canvas-workspace.ts`,
`contracts/canvas-documents.ts`, `core/canvas-workspace.ts`,
`core/canvas-documents.ts`, `services/canvas-workspace-store.ts`,
`services/canvas-document-store.ts`, `services/canvas-document-service.ts`,
`services/canvas-origin-verification.ts`, `services/create-file-tool-service.ts`,
`server/routes/canvas.ts`, `server/routes/canvas-documents.ts`,
`ui/src/components/canvas/`, `ui/public/canvas-preview.html`, and
`electron/main.ts`. The business rules and test mapping are in
[the Canvas flow](flows/canvas-workspace.md).

## Local API

`GET /sessions/:id/canvas` returns `{schemaVersion, revision, tabs, activeKey}`.
`POST` at the same path accepts one strict action: `open` with
`target: {runId, artifactPath}`, or `select`/`close` with `key`. Tab keys are
the JSON serialization of `[runId, artifactPath]`; display titles are not keys.
Every mutation returns authoritative state. Missing/foreign sessions or runs
return 404, malformed actions return 400, and corrupt/unsafe state or workspace
limits return 409 without replacing the saved file.

`GET /sessions/:id/canvas/content?runId=...&artifactPath=...` returns
`{content}` for bounded, contained text belonging to a run delivered or owned
by that chat. Unsupported formats return 415; unavailable/oversized previews
return 404. Requests have caller cancellation and a 20-second deadline.
Artifact downloads continue through the existing run-artifact route.
Downloads preserve raw bytes for binary and unknown formats; only explicitly
recognized text extensions are decoded. PDF downloads use `application/pdf`.

`GET /sessions/:id/canvas/document?runId=...&artifactPath=...` reads an existing
working document; `document_not_found` means no working copy exists yet.
`POST` at that path accepts a strict `create`, `save`, `propose`, `discard` or
`accept` action with its exact `target`. Saves require `expectedRevision`;
proposals also capture UTF-16 `selectionStart`, `selectionEnd`, `selectedText`
and `instruction`. Acceptance requires `proposalId` and `hasUnsavedDraft`.
Responses validate against `canvasDocumentSchema` in `contracts/canvas-documents.ts`.
Conflict, unverifiable origin and unsafe storage errors refuse the mutation.
Requests have cancellation and a 120-second proposal deadline. Generated HTML
uses the existing bounded content route and adds no executable API endpoint.

Office routes live beneath `/sessions/:id/canvas/office`:

| Route | Operation |
| --- | --- |
| `POST /preview` | Exact delivered target, retained document/revision or ready proposal preview |
| `POST /documents/lookup` | Exact target lookup; returns metadata or null |
| `POST /documents` / `GET /documents/:id` | Create verified copy / read authoritative metadata |
| `POST /documents/:id/proposals` | Captured base, instruction and next request sequence/ID |
| `POST /documents/:id/disposition` | Explicit accept/discard, proposal ID and expected revision |
| `GET /documents/:id/original/download` | Immutable retained original |
| `GET /documents/:id/revisions/:revision/download` | Immutable binary revision |
| `POST /word-snapshot` / `/word-snapshot/state` | Generate from expected saved Markdown revision / read stale state |

`contracts/office-documents.ts` defines request/result schemas and limits. Preview
requests use the existing 20-second budget; proposals share the existing
120-second budget across provider, native operations and publication. The native
runner allows two active jobs, eight waiting jobs, a two-second queue wait and a
15-second deadline per native command. A global 32 MiB preview cache is disposable.
The private environment and bounded package preflight do not constitute an
operating-system network/filesystem sandbox or a hard native-memory limit.
