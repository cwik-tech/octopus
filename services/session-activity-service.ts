import { randomUUID } from 'node:crypto'
import type { SessionStore } from '../domains/sessions/session-store.js'
import { ServiceError } from './service-errors.js'
import { releaseSessionActivityAfterFailure } from '../domains/sessions/session-activity-claims.js'
import type { SessionActivityClaimInput } from '../contracts/session-activity.js'
import { logProcessWarning } from '../domains/runtime/logger.js'

/** Trusted ownership shared only by nested entry points for this chat turn. */
export interface SessionChatActivity {
  readonly claim: SessionActivityClaimInput
  readonly completion: Promise<boolean>
}

export async function assertSessionDialogueInactive(store: SessionStore, sessionId: string): Promise<void> {
  if ((await store.listSessionActivityClaims(sessionId)).some((claim) => claim.kind === 'dialogue')) {
    throw new ServiceError('conflict', 'An Agent dialogue owns this chat', { code: 'dialogue_active' })
  }
}

export async function withSessionChatActivity<T>(
  store: SessionStore,
  sessionId: string,
  run: (activity: SessionChatActivity) => Promise<T>,
  inherited?: SessionChatActivity,
): Promise<T> {
  if (inherited) return run(inherited)
  const claim = { kind: 'chat' as const, claimId: randomUUID(), ownerLaunchId: store.getInstanceId() }
  const outcome = await store.claimSessionActivity(sessionId, claim)
  if (outcome === 'not_found') throw new ServiceError('not_found', 'Session not found')
  if (outcome !== 'claimed') throw new ServiceError('conflict', 'An Agent dialogue owns this chat', { code: outcome })
  let complete = (_published: boolean) => {}
  const completion = new Promise<boolean>((resolve) => { complete = resolve })
  let failure: { cause: unknown } | undefined
  let published = false
  try {
    const result = await run({ claim, completion })
    published = true
    return result
  } catch (cause) {
    failure = { cause }
    throw cause
  } finally {
    try {
      if (failure) await releaseSessionActivityAfterFailure({ sessionId, claimId: claim.claimId, cause: failure.cause, release: () => store.releaseSessionActivity(sessionId, claim) })
      else await store.releaseSessionActivity(sessionId, claim)
    } catch (cause) {
      // Keep the published result and the exact unreleased claim, while
      // refusing any deferred dialogue that depends on successful cleanup.
      published = false
      logProcessWarning('session-activity', JSON.stringify({
        sessionId,
        claimId: claim.claimId,
        event: 'claim_release_failed',
        errorName: cause instanceof Error ? cause.name : typeof cause,
      }))
    } finally {
      // The reserved dialogue cannot generate until publication and cleanup settle.
      complete(published)
    }
  }
}
