# Business workflow: follow an Agent's work

## Scope and starting conditions

Implemented behavior for ordinary Agent chat. Progress is display-only evidence
about one turn and speaker, separate from its saved answer. It never changes
admission, deadlines, Stop, tool authority, or the outcome of a task.

## Flow

1. Send a request. A compact progress row shows observed provider activity.
2. Thinking activity changes the phase without exposing internal reasoning.
3. Tool execution and genuine provider retries update the status. Informational
   quota events do not imply blocked work. Elapsed time is not evidence of work.
4. Expand the row to see recent activity and agent-reported tasks. Agent-authored
   summaries and task states are labeled as reported, not independently verified.
5. Leave and reopen the chat. The latest status follows the exact active turn
   and speaker, including when answer text has evicted older stream frames.
6. Completion, failure or Stop ends the active progress display. Late activity
   cannot revive a terminal turn or appear in another session.

## Business rules and test mapping

| ID | Required outcome | Test boundary | Coverage |
| --- | --- | --- | --- |
| AP-01 | Observed thinking/retry status reaches the desktop without reasoning text; a retry count beyond the display bound is omitted rather than invalidating the snapshot | Electron with real API, stores and CLI subprocess | `tests/electron/agent-progress.spec.ts`, “CLI activity and retries survive reopening the chat and disappear after the saved answer”; `tests/unit/claude-progress.test.ts`, including “a retry attempt beyond the progress contract still shows a valid retry status” |
| AP-07 | Arriving answer text shows the reply as being written for every provider, including those without activity events | Chat service, real provider and hub; network boundary replaced | `tests/integration/agent-chat-answer-progress.test.ts`, “a streamed answer from a provider without activity events shows the reply as being written” |
| AP-08 | While a progress row is open, it is the only running indicator; research activity stays above it | Chat panel with real SSE bytes at the HTTP boundary | `ui/src/components/run/chat/__tests__/research-streaming-status.test.tsx`, “shows the progress row instead of a second research status while research runs” |
| AP-02 | Allowed quota metadata is not a rate-limit error | CLI parser unit | `tests/unit/cli-diagnostics.test.ts`, “allowed quota information and warnings are not classified as rate-limit failures” |
| AP-03 | Progress stays with its reply, survives text eviction and ignores late events; after a mid-stream reset only replies still running regain a row | Hub, stream pump, UI reducer and observer hook | `tests/unit/agent-progress-replay.test.ts`, including “a mid-stream reset restores running progress and omits a reply that finished in the evicted window”; `ui/src/lib/chat/__tests__/apply-stream-delivery.test.ts`, including “a reset drops progress rows, because the stream resends progress only for replies still running”; `ui/src/components/run/chat/__tests__/observed-turns.test.tsx` |
| AP-04 | A bounded `report_progress` tool supplies explicitly labeled summaries and tasks; an invalid report fails only its own call, never the reply | Native tool loop, MCP tool integration and Electron | `tests/unit/agent-progress-tool-adapter.test.ts`, including “an invalid progress report fails only its own call, not the native tool loop reply”; `tests/integration/agent-progress-mcp.test.ts`; `tests/electron/agent-reported-progress.spec.ts`, “agent-reported milestones update a labeled checklist before the final answer” |
| AP-05 | Stop and failure settle progress without publishing a held answer | Cancellation transport, stream terminal tests and Electron | `tests/electron/agent-reported-progress.spec.ts`, “Stop removes agent-reported work without publishing the held answer”; `tests/integration/agent-chat-interrupted-turn.test.ts`; stream reducer terminal cases |
| AP-06 | Tool status reflects a real call, including while its result is pending and after the call throws | Real MCP HTTP and temporary-file tool | `tests/integration/agent-progress-tools.test.ts`, “observed tool progress brackets a real tool call while its result is pending” and “a tool call that throws does not leave the row showing the tool as running” |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.
