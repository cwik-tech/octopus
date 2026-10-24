# Multiple chat windows

## Summary

Octopus stays one app, but it can open more than one window. Each window is a
normal macOS window. You can drag it to another screen, resize it, or make it
full screen. Each window shows a chat. Two windows can show the same chat, and
both windows show its replies, including a reply that is still being written.

| Where | What the person does | What happens |
| --- | --- | --- |
| Chat header, new icon to the left of **Add folder** | Clicks **Open in new window** | A new window opens on the same chat. The first window keeps the chat. |
| Title bar, the **+** (**New chat**) button | Right-clicks it, then clicks **New chat in new window** | A new window opens on a new, empty chat. |
| Sessions list, the **...** menu of a session | Clicks **Open in new window** | A new window opens on that session. |

## Shared and window-local state

| What | Stays in step between windows that show the same session? | How |
| --- | --- | --- |
| Saved messages | Yes | Each window reloads on a session-changed message |
| A reply that one window sends | Yes, from its first `selection` or `delta` event | The reload finds all `activeTurnIds`; `useObservedTurns` subscribes independently beside the local send, then reloads the transcript at completion. |
| A reply from voice, a schedule or a Team | Yes | Voice refresh, TaskQueue invalidation and the task-history receiver |
| An agent dialogue started in one window | Yes, when it starts and when it ends | The dialogue hook announces session changes. The receiver uses the existing external-dialogue refresh (VC-36). |
| Session title and project in the left list | Within 5 seconds | The existing 5-second reload (`ui/src/hooks/use-sidebar-sessions.ts:24-33`) |
| Session title in the chat header | No, until the chat is opened again | Current limitation |
| Folder list in the header popover | No, until the chat is opened again. Agent turns always use the folders on the server. | Current limitation |
| Task list in the Run activity pane | Yes | TaskQueue invalidation refreshes selected-session history; existing task event streams supply activity. |
| Unsent text, files not yet sent, chat target, agent mode, project selection | No. Each window keeps its own. | By design |

While an Agent turn is known to be running, all views disable typing and show
the destructive Stop control. Reopening a chat restores these controls from
`activeTurnIds`, including before the first answer text. Stop calls
`POST /sessions/:sessionId/turns/:turnId/cancel` with a ten-second client timeout.
The server returns 202 only after signalling the matching live controller;
invalid turn IDs return 400 and unknown or foreign-session turns return 404.
Both owning and observing views use this endpoint, so the server can record
explicit Stop separately from a transport disconnect. The owning view keeps
its original POST open until the server finishes; aborting immediately after
the 202 would race the durable cancellation outcome. A 202 is cancellation
acceptance; the journal and completed stream establish that the turn ended. Controls remain busy until that terminal state arrives.
The registry is scoped to the server's SessionStore and released when the turn ends.
See [provider turn diagnostics](provider-turn-diagnostics.md) for cancellation
sources, retained CLI metadata and evidence limits.

The backend still admits independent turns from voice or racing callers. Each
retains its own ID; Stop targets one turn, and remains available for remaining
work. J5 covers shared input locking, completion, cancellation, failure and a
reopened silent turn. Transport-level concurrent observation remains covered
by `ui/src/components/run/chat/__tests__/observed-turns.test.tsx`.
See [the business flow](flows/multi-window.md) for expected outcomes and test mappings.
