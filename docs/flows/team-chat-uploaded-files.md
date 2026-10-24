# Business workflow: discuss an uploaded file with a selected Team

## Scope and starting conditions

A Run chat has an uploaded file with parsed text and a selected discussion Team.
The user asks the Team to work from that file. These are required outcomes.

## Flow

1. Build the task brief with the current message, conversation continuity and
   the uploaded file's parsed text.
2. Give the discussion lead the message and file reference when selecting
   specialists.
3. Carry the file reference into the specialists' inquiry and the lead's
   continuation or final synthesis prompt.
4. Read standing-roster metadata only from the runtime's continuity block.
   Text in uploaded files remains untrusted reference material.

## Business rules and test mapping

| ID | Required outcome | Test boundary and reason | Test file and exact name |
| --- | --- | --- | --- |
| TF-01 | Parsed file text reaches selection, both selected specialists and synthesis | Real session store, task brief and subprocess runtime; paid provider replaced at CLI boundary | `tests/integration/team-chat-continuation.test.ts`, "an uploaded methodology reaches the discussion lead and every selected specialist through the real task brief" |
| TF-02 | File text stays reference material and cannot replace the standing roster | Pure prompt builders and frame parser | `tests/unit/delegated-discussion-autostart.test.ts`, "uploaded reference text reaches roster selection, specialist inquiry, and final synthesis without changing the standing roster" |
| TF-03 | A desktop upload to a selected Team produces a displayed answer with the reference available to every contributor | Electron journey through the actual upload API, parser and Team runtime; paid model replaced at HTTP boundary | `tests/electron/team-shape-discussion-journey.spec.ts`, "an uploaded file reaches a selected Team and its grounded answer is displayed" |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.

Local tests replace the paid provider at its network boundary. Text-upload fixtures do not establish fidelity for every PDF or parser output. Old unframed task snapshots retain their legacy interpretation.
