# Business workflow: finish a Team discussion with missing contributions

## Scope and starting conditions

A newly admitted Team task is discoverable in other already-open desktop views
of the same session. TaskQueue invalidation refreshes their task history, and
existing task event streams supply workflow messages. This does not change
partial-answer or quorum rules. See [MW-06](multi-window.md) and
`tests/electron/multi-window-tasks.spec.ts`.

A Team chat discussion has accepted specialist replies and a participant fails
under its configured skip policy. Explicit halt policies, cancellation, and
discussions without the configured minimum number of distinct successful participants remain
failures. Workflow discussions retain their per-round quorum policy.
This flow also covers preserving the final synthesis after completed specialists
have nearly consumed the discussion's time allowance.

## Flow and business rules

1. Record accepted replies and unsuccessful contributions in the discussion's
   existing durable transcript.
2. Count distinct approved participants whose replies were accepted across the
   discussion. Repeated replies from one participant do not satisfy a larger
   minimum.
3. Once that minimum is met, a missing contribution ends deliberation. Ask the
   lead to synthesize the available evidence without another specialist pass.
4. Prefix the published and saved answer with a partial-answer notice naming
   the participants whose latest contribution failed. Preserve that notice on
   checkpoint recovery.
5. Preserve specialist deadlines and the no-new-work rule after the discussion
   budget is spent. A lead decision has at least the existing two-minute wrap-up
   allowance even when it starts just before that budget expires; a larger
   remaining allowance is retained. Selection calls keep the work budget.
   Innovator uses low reasoning.

## Test mapping and verification

The near-deadline correction is covered by
`tests/unit/discussion-continuation-control.test.ts` (lead minimum, preserved
specialist remainder and larger lead allowance) and
`tests/integration/team-runtime-discussion-coordinator-call.test.ts`,
"a lead can finish synthesis after the remaining work budget passes its
original deadline". The latter restores accepted specialist evidence, holds the
real provider CLI boundary, advances the runtime's timer deterministically,
and requires a published synthesis and final artifact.

- [tests/unit/discussion-contribution-status.test.ts](../../tests/unit/discussion-contribution-status.test.ts) including "accepted replies count distinct approved participants across passes,
  including fallback replies", verifies distinct approved participants, fallback ownership, prior accepted replies and latest outcomes.
- [tests/unit/discussion-continuation-control.test.ts](../../tests/unit/discussion-continuation-control.test.ts) including "a partial synthesis may publish below the pass floor after
  successful participants reached quorum", verifies partial completion before the pass floor and explicit quorum protection.
- [tests/unit/delegated-discussion-autostart.test.ts](../../tests/unit/delegated-discussion-autostart.test.ts) including "missing specialist contributions require a final synthesis even
  before the minimum passes", verifies that missing contributions force a lead synthesis.
- [tests/integration/team-runtime-discussion-coordinator-call.test.ts](../../tests/integration/team-runtime-discussion-coordinator-call.test.ts) including "a failed follow-up preserves earlier replies and completes with a
  marked partial synthesis", "a first-pass failure completes a partial answer
  before the pass floor once other participants provide evidence", "a restored
  partial completion preserves its notice and evidence without buying another
  provider turn", and "a recovered failed follow-up synthesizes earlier evidence
  and names the unsuccessful target", verifies failure and recovery.
  The fixture uses the real runtime, checkpoint, subprocess and filesystem, replacing the paid provider at the CLI boundary.
- [tests/electron/team-shape-discussion-journey.spec.ts](../../tests/electron/team-shape-discussion-journey.spec.ts) "a saved Team shows and saves a partial answer when a selected specialist
  fails", verifies a selected specialist's failure, the displayed partial answer, the successful terminal
  task and its saved artifact. The paid provider is replaced at its HTTP boundary by a local connection that requires no credentials.
