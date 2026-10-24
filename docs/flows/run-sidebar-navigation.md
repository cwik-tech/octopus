# Business workflow: choose a Run session or chat target

## Scope and starting conditions

Implemented sidebar navigation for Run and the initial Create resource tab.
Chat dispatch, session persistence and Team build rules retain their existing contracts.

## Flow

1. Open Run. The left sidebar selects Sessions, below Queue and Schedule & Batches.
2. Open the search below the tabs. Its query filters the active list.
3. Switch to Teams or Agents. The same query remains visible and filters that list.
4. Select a Team or Agent to address the current chat. Returning to Sessions changes
   only the sidebar list; the chat target remains selected.
5. Clear search to see all rows. Select another session through Sessions.
6. Open Create. Teams is first and selected initially; Agents is second.

## Alternative flows

- Each desktop window keeps its own selected session and unsent input. Opening a
  saved session from its actions menu creates another view without navigating
  the source. See [multi-window rules MW-02 and MW-03](multi-window.md).
- A scheduled research session or a session with fixed Team history keeps Sessions
  usable but disables changing the Run target, preserving the existing restriction.
- Queue and Schedule & Batches remain reachable. Target tabs are unavailable while
  an overview is open; returning to a session restores access when it is unlocked.
- Builds with workflows enabled retain a Workflows tab and its task lifecycle pane.
- Create keeps its details sidebar. Run target selection stays on the left.
  A saved chat can use the existing right Context sidebar for Canvas documents;
  see [the Canvas flow](canvas-workspace.md).

## Business rules and test mapping

| ID | Required outcome | Test boundary and reason | Test file and exact name |
| --- | --- | --- | --- |
| RN-01 | Sessions opens by default; one query filters all Run lists in the left sidebar; target selection survives returning to Sessions. | Electron, real renderer, API and filesystem catalogs. | [run-left-sidebar.spec.ts](../../tests/electron/run-left-sidebar.spec.ts), "Run searches sessions, Teams and Agents from the left sidebar and keeps the selected chat target" |
| RN-02 | Create starts on Teams and offers Agents second. | Controller and Electron. | [use-create-workspace-controller.test.tsx](../../ui/src/hooks/__tests__/use-create-workspace-controller.test.tsx), "opens Create on Teams with workflow flag %s"; [run-left-sidebar.spec.ts](../../tests/electron/run-left-sidebar.spec.ts), "Create opens on Teams and lets the user switch to Agents" |
| RN-03 | Run target navigation stays on the left; Canvas can use the existing right sidebar and its title-bar control; Create details remain available. | Shell controller. | [use-right-sidebar.test.tsx](../../ui/src/hooks/__tests__/use-right-sidebar.test.tsx) |
| RN-04 | Fixed Team history and scheduled research disable target changes while Sessions remains usable. | Shell component and Electron with real task history. | [app.test.tsx](../../ui/src/__tests__/app.test.tsx), "keeps Sessions available and disables target tabs for a session a Team run already owns"; [team-chat.spec.ts](../../tests/electron/team-chat.spec.ts), "a discussion team convenes a subset of its bench and only those reply"; [scheduled-chat.spec.ts](../../tests/electron/scheduled-chat.spec.ts), "scheduled research unlocks chat and all sidebar controls on completion and reload" |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.
