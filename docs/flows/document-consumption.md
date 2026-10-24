# Business workflow: consume a document in chat or a run

## Scope and starting conditions

A user uploads a document or explicitly selects project references, then asks an
Agent, managed Team/Workflow, or the combined Agent/Team Architect to use them.
Run image delivery and limits are described in [image inputs](../reference/image-inputs.md).

## Flow

1. Validate the selected scope and capture the source revision.
2. Advertise opaque document IDs and bounded excerpts.
3. Offer scoped list/search/read tools. Tool-free routes prepare cited evidence
   before their structured call.
4. An explicit entire-document request processes canonical pages or text ranges,
   preserving question/model/revision-bound receipts and partial coverage.
5. Publish bounded evidence and accurate processing coverage. Refresh the file
   cards after a turn or Team finishes; restore coverage on reload.

## Business rules and test mapping

| ID | Required outcome | Verified regression boundary |
| --- | --- | --- |
| DC-01 | Selected project content reaches the worker from its sealed revision; nonselected files stay excluded | `tests/integration/session-task-api-contract.test.ts`; `tests/unit/session-run-storage.test.ts` |
| DC-02 | Final-range upload, project, and delivered evidence remains accessible under the admitted scope | `tests/integration/chat-document-access.test.ts`; `tests/integration/reference-document-access.test.ts`; `tests/unit/document-tool-adapters.test.ts` |
| DC-03 | Team contributors share frozen document IDs and evidence | `tests/integration/worker-document-access.test.ts`; discussion and chain journeys in `tests/electron/team-chat.spec.ts` |
| DC-04 | Complete review covers every indexed readable range of the same revision; unresolved pages remain partial | `tests/integration/document-review.test.ts`; `tests/unit/document-coverage-validation.test.ts`; `tests/unit/document-reader.test.ts`; `file-parser/tests/parsers.test.ts` |
| DC-05 | Cancellation, recovery, source replacement, tool-free routes, and work/request limits remain explicit | `tests/integration/document-review.test.ts`; `tests/integration/direct-document-access.test.ts`; `tests/integration/document-snapshots.test.ts`; `tests/integration/mcp-agent-tool-provider-options.test.ts` |
| DC-06 | Visible state distinguishes revision locking from processing coverage and survives reload | `tests/integration/document-review-projection.test.ts`; `ui/src/components/shared/chat-files/__tests__/file-message-card.test.tsx`; `tests/electron/chat-file-upload.spec.ts` |
| DC-07 | Planning and Create receive full-source evidence without changing their structured output contract; package generation retains it | `tests/integration/planning-document-access.test.ts`; `tests/integration/create-document-access.test.ts`; `tests/integration/agent-generation-document-access.test.ts` |
| DC-08 | Successful image preparation does not require extracted text. Run uploads expose captured visual previews through scoped `document_read`; Workflow planning carries them as visual user input. Sending an image does not establish review coverage. | `tests/integration/session-image-chat.test.ts`; `tests/integration/copied-document-parser.test.ts`; `tests/unit/document-tool-adapters.test.ts`; `tests/unit/model-client.test.ts`; `tests/integration/cli-text-providers.test.ts`; `tests/electron/chat-image-upload.spec.ts` |
| DC-09 | CLI Agent tool routes preserve image blocks through the host MCP bridge, validate their payloads and include encoded image bytes in the response limit. A live Claude desktop journey must identify both neutral-named pictures. | `tests/integration/mcp-cli-host-bridge.test.ts`, "CLI providers receive image content returned by an admitted tool over MCP", "CLI tool image payloads obey the response byte limit", "CLI tool results reject malformed image payloads without exposing them"; `tests/electron/chat-image-claude.live.spec.ts` |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.

Local model fixtures prove transport and source access, not interpretation by a paid model. Coverage checkpoints persist every ten pages and on failure or completion. File cards refresh on settlement or reload rather than showing a live page-by-page counter. Legacy text without a verified index reports unknown coverage. Private attachments are not exposed through shared-folder readers.
