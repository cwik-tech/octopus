# Agent chat progress

Ordinary Agent chat shows a compact expandable progress row while a reply runs.
It separates observed provider activity from statements reported by the Agent.

## Read the progress row

- Starting, thinking, tool execution, waiting, answer generation and provider
  retry states come from provider events or the host's actual tool dispatch.
  Arriving answer text shows answer generation for every provider, including
  those that report no activity events.
- Thinking indicates activity only. Internal reasoning text is never included.
- A retry countdown uses the provider's stated delay. After that delay it says
  it is waiting for the retry; the clock does not prove another attempt began.
- Informational allowed/warning quota events do not mean work was blocked.
  A rejected quota event and a genuine API retry are distinct statuses.
- The row has no elapsed counter; the response time stays in the message
  header. After thirty seconds without activity, the row shows the age of the
  last update. Timers never manufacture activity.
- While the row is open, it is the only running indicator. The research
  activity stays above it, but the research status line and the pending
  placeholder are hidden.
- Expand the row to see recent activity and any Agent-reported checklist.

## Agent-reported work

Chat offers `report_progress` through the existing MCP/native tool paths. The
Agent can report a short milestone and a checklist with pending, active and
completed items. The UI labels these as **Agent-reported**: they are not proof
that a file was changed, a test passed, or a workflow finished.

Reports contain at most 160 characters per summary or task label and twelve
tasks with unique, stable IDs. The tool states these limits in its description
and checks them when it runs, so a report that breaks them fails only that tool
call, never the reply. A report replaces the checklist when supplied;
omitting tasks retains it, and an empty list clears it. The Agent is instructed
to report meaningful milestones rather than repeatedly announcing that it is
still working. Reporting uses the normal tool-loop budget, with no separate
model call to summarize progress.

Claude's native tools remain disabled. The new display tool grants no file,
execution or task-state authority. Known CLI bridge credentials are redacted
from report text and cannot be exposed through task IDs.

## Recovery and limits

Progress is tied to a channel/turn and a speaker, separate from answer text.
The live backend retains a latest snapshot for reopening another view, including
when heavy text output has evicted older stream frames. Snapshots have revisions
so replay cannot replace newer progress with an old update. Their replay control
has no SSE cursor and does not conceal missing answer text. A reader that falls
behind and receives a reset drops its progress rows, then receives snapshots for
the replies still running, so a reply whose terminal was evicted does not stay open.

History is limited to sixteen changes; repeated observed activity is published
at most once every two seconds. The hub retains at most sixty-four progress
reply identities per channel, including compact terminal markers. Further reply
identities can still deliver answers without progress. Completion, failure and Stop settle the row;
late events cannot revive a settled reply. Progress is ephemeral, not saved as
an assistant message, and does not restart a provider after the app exits.

The explicit reporting opt-in belongs to ordinary Agent chat. Shared dialogue,
voice, Team and Workflow callers retain their existing tool behavior. Deep
Research retains its own activity display and execution budget. The
[ordinary reply deadline](feature-b2-timeout-and-shutdown.md#ordinary-agent-chat-replies)
is independent of progress reporting.

## Manual use

The [progress flow](flows/agent-progress.md) maps rules to tests.

In a development build, send an Agent a substantial multi-step request. Expect
observed activity immediately and, when the Agent reports milestones, a labeled
summary and checklist. Expand the row, open the same chat in another window,
and reload that observing window: the latest active progress should return.
Stop should remove progress and leave no held final answer. A finished request
should replace the active row with its saved answer.
