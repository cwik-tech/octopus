import * as fs from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import * as path from 'node:path'
import { sessionActivityClaimsSchema, type SessionActivityClaim, type SessionActivityClaimInput, type SessionActivityClaimResult } from '../../contracts/session-activity.js'
import { resolveExistingPathInside } from '../../core/path-safety.js'
import { writeFileAtomic } from '../../core/file-mutation.js'
import { logProcessWarning } from '../runtime/logger.js'

export class SessionActivityConflictError extends Error {
  constructor(readonly code: Exclude<SessionActivityClaimResult, 'claimed' | 'not_found'>) {
    super(`Session is owned by ${code === 'dialogue_active' ? 'an Agent dialogue' : code === 'chat_active' ? 'a chat turn' : 'a task'}`)
    this.name = 'SessionActivityConflictError'
  }
}

export function sameSessionActivityClaim(left: SessionActivityClaimInput, right: SessionActivityClaimInput): boolean {
  return left.kind === right.kind && left.claimId === right.claimId && left.ownerLaunchId === right.ownerLaunchId
}

export function sessionActivityConflict(claims: readonly SessionActivityClaim[], requested: SessionActivityClaimInput): Exclude<SessionActivityClaimResult, 'claimed' | 'not_found'> | undefined {
  if (claims.some((claim) => claim.kind === 'dialogue')) return 'dialogue_active'
  if (requested.kind !== 'dialogue') return undefined
  if (claims.some((claim) => claim.kind === 'chat')) return 'chat_active'
  if (claims.some((claim) => claim.kind === 'task')) return 'tasks_active'
  return undefined
}

export async function releaseSessionActivityAfterFailure(input: {
  sessionId: string
  claimId: string
  cause: unknown
  release: () => Promise<void>
}): Promise<void> {
  try {
    await input.release()
  } catch (releaseFailure) {
    // Error names identify cleanup failure without logging user/provider text.
    logProcessWarning('session-activity', JSON.stringify({
      sessionId: input.sessionId,
      claimId: input.claimId,
      event: 'claim_release_failed',
      errorName: releaseFailure instanceof Error ? releaseFailure.name : typeof releaseFailure,
      causeName: input.cause instanceof Error ? input.cause.name : typeof input.cause,
    }))
  }
}

/** Reads and writes run only while the caller holds the session lifecycle lock. */
export class SessionActivityClaimsFile {
  private readonly filename: string
  constructor(private readonly sessionDirectory: string) {
    this.filename = path.join(sessionDirectory, 'activity-claims.json')
  }

  async read(): Promise<SessionActivityClaim[]> {
    if (existsSync(this.filename) && !resolveExistingPathInside(this.sessionDirectory, this.filename)) {
      throw new Error('Session activity claims must stay inside their session')
    }
    let contents: string
    try {
      const handle = await fs.open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { contents = await handle.readFile('utf8') } finally { await handle.close() }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const raw: unknown = JSON.parse(contents)
    return sessionActivityClaimsSchema.parse(raw)
  }

  async write(claims: readonly SessionActivityClaim[]): Promise<void> {
    const validated = sessionActivityClaimsSchema.parse(claims)
    await writeFileAtomic(this.filename, `${JSON.stringify(validated)}\n`)
  }
}
