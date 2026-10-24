# Business workflow: confirm an inferred Team target

## Scope and starting conditions

The user asks Agent Architect to add Agents to an existing Team. The proposed
update targets a registered Team that the user has not named by exact ID or its
exact spaced name. This describes the implemented confirmation requirement;
creating new Teams and build recovery use their existing flows.

## Flow

1. The Architect proposes an update for an existing Team.
2. If the user already named that Team exactly, normal proposal validation applies.
3. Otherwise the server returns a discussion question naming the exact inferred
   Team ID: "Did you mean Team `software-architecture-board`? Reply yes to
   confirm, or give the exact Team ID you meant."
4. No update proposal is saved by this turn. Team rosters and Agent folders remain
   untouched.
5. A plain affirmative reply to that question, or its exact single Team ID as the
   reply, permits a proposal for the displayed ID. Similar names give no authority
   for another ID. If several inferred Teams are proposed, the question lists
   their exact IDs and the affirmative reply must confirm that same set.
6. The proposal is saved for review. The existing Create action remains the build
   authorization.

## Alternative flows

- A negative or qualified answer does not confirm the suggested ID, including
  "no, not software-architecture-board". A proposal that still targets it asks
  again rather than saving.
- The user gives a different exact Team ID. Normal proposal validation applies to
  that requested ID; confirmation of one Team cannot authorize another.
- A model mentions an ID without the server's exact confirmation question. A
  subsequent generic "yes" does not confirm it.
- Displayed document warnings may follow the question. They do not change the
  IDs it confirms.

## Business rules and test mapping

| ID | Required outcome | Test boundary and reason | Test file and exact name |
| --- | --- | --- | --- |
| TC-01 | An inferred Team requires an exact-ID question before any proposal is saved. | Service integration with a real filesystem and proposal store. | [resource-architect-turn-operations.test.ts](../../tests/integration/resource-architect-turn-operations.test.ts), "an inferred Team is confirmed by its exact ID before its update proposal is saved" |
| TC-02 | Affirmation authorizes only the IDs in the preceding question. | Unit policy and real filesystem materialization. | [resource-update-policy.test.ts](../../tests/unit/resource-update-policy.test.ts), "yes to a question about a similar Team cannot confirm the Board"; [resource-update-team-name.test.ts](../../tests/integration/resource-update-team-name.test.ts), "confirming the exact Board ID prepares its update without writing the roster or Agents" |
| TC-03 | Rejection or qualification cannot confirm the suggested Team. | Unit policy: explicit answer matrix. | [resource-update-policy.test.ts](../../tests/unit/resource-update-policy.test.ts), "the answer 'no, not software-architecture-board' does not confirm the suggested Team" and the other negative answer cases |
| TC-04 | Exact user naming retains normal proposal behavior. | Unit policy, independent of display-name similarity. | [resource-update-policy.test.ts](../../tests/unit/resource-update-policy.test.ts), "an explicitly named Board prepares a proposal even when another Team has a similar name" |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.
