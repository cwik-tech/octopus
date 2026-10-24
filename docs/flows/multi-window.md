# Business workflow: open and use another chat window

## Scope and starting conditions

Desktop behavior. Each sandboxed app window shares one API
server and workspace. Each window keeps its own navigation and unsent input.
See [the feature plan](../feature-multi-window.md) for design and Status.

## Flow

1. On Run, right-click New chat and choose New chat in new window.
2. The app creates a registered window with a fresh, unsaved draft. It cascades
   on the asking window's display and keeps the original window unchanged.
3. A saved chat can also be opened from its header or session actions menu.
   Every request opens a new view; no chat is moved or claimed exclusively.
4. Replies, dialogue and task activity reach all views of the same session.
   A running Agent turn locks typing in every view. Each view shows Stop,
   including after reopening; Stop cancels the selected live turn by session
   and turn ID. Acceptance alone does not unlock typing: the view waits for
   the completed turn. Cancellation diagnostics distinguish an explicit Stop
   from a disconnected request or a provider deadline. Concurrent turns
   admitted by other callers retain separate IDs.
   Ordinary Agent [progress](agent-progress.md) follows the same turn and speaker
   in observing views, including after reloading an observing window.
5. A closed window leaves the other windows usable. Dock/second launch restores
   the most recently focused live window. Voice show prefers a matching chat
   view and excludes Canvas-only windows.

## Alternative flows

- Draft header actions are disabled with Send a message first.
- A failed, timed-out or closed loading window rejects the open request,
  destroys any remaining destination, and leaves the source unchanged.
- Unknown windows and subframes have no window-opening or folder capability.
- An invalid or deleted initial session never silently selects another session.

## Business rules and test mapping

| Rule | Expected outcome | Verification mapping |
| --- | --- | --- |
| MW-01 | A new window starts on an empty draft | `multi-window-new-chat.spec.ts`, J1 |
| MW-02 | Session menu opens a new view and preserves source navigation | `multi-window-session-menu.spec.ts`, J3 |
| MW-03 | Header opens the same saved chat in a second view | `multi-window-header.spec.ts`, J4 |
| MW-04 | Draft header action is unavailable | J4 and button UI test |
| MW-05 | All registered app windows can use folder dialogs; foreign frames cannot | `multi-window-folders.spec.ts`, J2; existing Batch negative journey |
| MW-06 | All views receive live and saved work; a running Agent turn locks input and remains stoppable after reopening | `multi-window-sync.spec.ts`, J5 (shared lock, Stop, failure and reopened silent turn); Team and dialogue journeys J6/J7 |
| MW-07 | A failed open leaves source state unchanged with a visible error | App-window unit tests and action UI test |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.
