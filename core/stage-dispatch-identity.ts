/**
 * The durable identity of one stage dispatch.
 *
 * A durable Team message is keyed by `runId#dispatchId`, and `dispatchId` is
 * derived from the dispatch's logical invocation id. When an engine supplies
 * none, `failure-policy.ts` mints a fresh `randomUUID()` per execution — which
 * means a re-executed step is a brand-new identity and the message publisher's
 * dedupe cannot recognise it. A recovery then republishes work the reader has
 * already seen.
 *
 * The identity therefore has to be a function of *where in the run the dispatch
 * sits*, not of when it ran: the session, the level, which visit to that level,
 * the slot inside the stage, and the agent addressed. Re-running the same slot
 * reproduces the same string; a different slot, a later loopback, or a
 * different agent does not.
 */

function requireIdentityText(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`Stage dispatch identity requires a ${label}.`)
  }
  return value
}

export function buildStageDispatchInvocationId(input: {
  sessionId: string
  levelId: string
  visitCount: number
  stageType: string
  /** Where inside the stage this dispatch sits, e.g. `step:2` or `task:write`. */
  slot: string
  /** The agent being addressed. */
  target: string
}): string {
  requireIdentityText(input.sessionId, 'session')
  requireIdentityText(input.levelId, 'level')
  requireIdentityText(input.stageType, 'stage type')
  requireIdentityText(input.slot, 'slot')
  requireIdentityText(input.target, 'target')
  if (
    !Number.isInteger(input.visitCount) ||
    input.visitCount < 0
  ) {
    throw new Error('Stage dispatch identity requires a visit count.')
  }
  return (
    `${input.sessionId}:${input.stageType}:` +
    `${input.levelId}:visit:${input.visitCount}:` +
    `${input.slot}:${input.target}`
  )
}
