import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { SessionStore } from '../domains/sessions/session-store.js'
import { buildSessionRunAssignmentLocation } from '../domains/run/run-location.js'
import { resolveRunAssignmentAuthorityChain } from '../domains/run/run-assignment-authority-store.js'
import {
  hashRuntimeAssignmentGrantId,
  verifyRuntimeAssignmentCredential,
} from '../core/runtime-assignment-credential.js'
import type {
  RuntimeCapabilityAuthorityClaims,
  RuntimeCapabilityAuthorityPort,
  RuntimeCapabilityAuthorityResolution,
  RuntimeCapabilityAuthorityVerification,
} from '../contracts/runtime-capability-authority.js'

export type RuntimeCapabilityAuthorityErrorCode =
  | 'unauthorized'
  | 'inactive_task'

export class RuntimeCapabilityAuthorityError extends Error {
  constructor(readonly code: RuntimeCapabilityAuthorityErrorCode) {
    super('Runtime capability authority could not be established.')
    this.name = 'RuntimeCapabilityAuthorityError'
  }
}

export function statusForRuntimeCapabilityAuthorityError(
  error: unknown,
): 403 | 409 | undefined {
  if (!(error instanceof RuntimeCapabilityAuthorityError)) return undefined
  return error.code === 'inactive_task' ? 409 : 403
}

export interface RuntimeCapabilityAuthorityResolverOptions {
  readonly workspacePath: string
  readonly sessionStore: Pick<
    SessionStore,
    | 'getTaskRecord'
    | 'ownsTaskProcess'
    | 'isTaskProcessAlive'
    | 'hasValidTaskProcessIdentity'
  >
}

export class RuntimeCapabilityAuthorityResolver
  implements RuntimeCapabilityAuthorityPort {
  private readonly workspacePath: string
  private readonly initialEvidence = new WeakMap<
    object,
    {
      readonly claimsKey: string
      readonly resolution: RuntimeCapabilityAuthorityResolution
    }
  >()

  constructor(
    private readonly options: RuntimeCapabilityAuthorityResolverOptions,
  ) {
    this.workspacePath = path.resolve(options.workspacePath)
  }

  async authorize(
    claims: RuntimeCapabilityAuthorityClaims,
    verification?: RuntimeCapabilityAuthorityVerification,
  ): Promise<RuntimeCapabilityAuthorityResolution> {
    if (verification?.kind === 'reuse-evidence') {
      return this.consumeEvidence(claims, verification.evidence)
    }
    let task: Awaited<ReturnType<SessionStore['getTaskRecord']>>
    try {
      task = await this.options.sessionStore.getTaskRecord(
        claims.sessionId,
        claims.taskId,
      )
    } catch {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    if (
      !task ||
      task.id !== claims.taskId ||
      task.sessionId !== claims.sessionId ||
      task.runId !== claims.runId ||
      (claims.workflowId !== undefined && task.workflowId !== claims.workflowId)
    ) {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    if (task.status !== 'running') {
      throw new RuntimeCapabilityAuthorityError('inactive_task')
    }
    if (!this.hasLiveOwnedProcess(task)) {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    const rootAssignmentId = task.assignmentId
    const taskProcessIdentity = task.processIdentity
    if (!rootAssignmentId || !taskProcessIdentity) {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    const usesRootAuthority =
      claims.assignmentId === rootAssignmentId &&
      claims.processIdentity === taskProcessIdentity
    if (
      !usesRootAuthority &&
      !(await this.hasDelegatedAssignmentAuthority({
        claims,
        rootAssignmentId,
        taskProcessIdentity,
      }))
    ) {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    const location = buildSessionRunAssignmentLocation(this.workspacePath, claims)
    const rootLocation = buildSessionRunAssignmentLocation(this.workspacePath, {
      sessionId: task.sessionId,
      runId: task.runId,
      assignmentId: rootAssignmentId,
    })
    const taskRunPath = task.runPath
    if (
      !location ||
      !rootLocation ||
      !taskRunPath ||
      path.resolve(taskRunPath) !== location.runPath ||
      (task.assignmentPath !== undefined &&
        path.resolve(task.assignmentPath) !== rootLocation.assignmentPath)
    ) {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    try {
      const [runStat, assignmentStat, runRealPath, assignmentRealPath] =
        await Promise.all([
          fs.lstat(location.runPath),
          fs.lstat(location.assignmentPath),
          fs.realpath(location.runPath),
          fs.realpath(location.assignmentPath),
        ])
      if (
        !runStat.isDirectory() ||
        runStat.isSymbolicLink() ||
        !assignmentStat.isDirectory() ||
        assignmentStat.isSymbolicLink() ||
        assignmentRealPath !==
          path.join(runRealPath, 'assignments', claims.assignmentId)
      ) {
        throw new Error('Runtime assignment is not canonical.')
      }
      const resolution = Object.freeze<RuntimeCapabilityAuthorityResolution>({
        taskId: task.id,
        workflowId: task.workflowId,
        runPath: location.runPath,
        assignmentPath: assignmentRealPath,
        ...(task.mcpResolutionPath
          ? { mcpResolutionPath: task.mcpResolutionPath }
          : {}),
      })
      if (verification?.kind === 'issue-evidence') {
        this.initialEvidence.set(resolution, {
          claimsKey: runtimeAuthorityClaimsKey(claims),
          resolution,
        })
      }
      return resolution
    } catch {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
  }

  private consumeEvidence(
    claims: RuntimeCapabilityAuthorityClaims,
    evidence: unknown,
  ): RuntimeCapabilityAuthorityResolution {
    if (evidence === null || typeof evidence !== 'object') {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    const issued = this.initialEvidence.get(evidence)
    this.initialEvidence.delete(evidence)
    if (!issued || issued.claimsKey !== runtimeAuthorityClaimsKey(claims)) {
      throw new RuntimeCapabilityAuthorityError('unauthorized')
    }
    return issued.resolution
  }

  private hasLiveOwnedProcess(
    task: NonNullable<Awaited<ReturnType<SessionStore['getTaskRecord']>>>,
  ): boolean {
    try {
      return (
        this.options.sessionStore.ownsTaskProcess(task) &&
        (this.options.sessionStore.isTaskProcessAlive?.(task) ?? false) &&
        (this.options.sessionStore.hasValidTaskProcessIdentity?.(task) ?? false)
      )
    } catch {
      return false
    }
  }

  private async hasDelegatedAssignmentAuthority(input: {
    readonly claims: RuntimeCapabilityAuthorityClaims
    readonly rootAssignmentId: string
    readonly taskProcessIdentity: string
  }): Promise<boolean> {
    if (
      input.claims.assignmentId === input.rootAssignmentId ||
      input.claims.processIdentity === input.taskProcessIdentity
    ) {
      return false
    }
    try {
      const chain = await resolveRunAssignmentAuthorityChain(
        await fs.realpath(this.workspacePath),
        input.claims.assignmentId,
      )
      const rootGrant = chain?.at(0)
      const leafGrant = chain?.at(-1)
      if (
        !chain ||
        chain.length < 2 ||
        !rootGrant ||
        !leafGrant ||
        rootGrant.depth !== 0 ||
        rootGrant.parentAssignmentId !== null ||
        rootGrant.sessionId !== input.claims.sessionId ||
        rootGrant.runId !== input.claims.runId ||
        rootGrant.taskId !== input.claims.taskId ||
        rootGrant.assignmentId !== input.rootAssignmentId ||
        leafGrant.assignmentId !== input.claims.assignmentId
      ) {
        return false
      }
      const verified = verifyRuntimeAssignmentCredential({
        credential: input.claims.processIdentity,
        seed: {
          sessionId: input.claims.sessionId,
          runId: input.claims.runId,
          taskId: input.claims.taskId,
          rootAssignmentId: input.rootAssignmentId,
          taskProcessIdentity: input.taskProcessIdentity,
        },
        assignmentId: input.claims.assignmentId,
      })
      if (
        !verified ||
        verified.depth !== leafGrant.depth ||
        verified.lineageHashes.length !== chain.length
      ) {
        return false
      }
      return chain.every(
        (grant, index) =>
          verified.lineageHashes[index] ===
          hashRuntimeAssignmentGrantId(grant.assignmentId),
      )
    } catch {
      return false
    }
  }
}

function runtimeAuthorityClaimsKey(
  claims: RuntimeCapabilityAuthorityClaims,
): string {
  return JSON.stringify([
    claims.sessionId,
    claims.runId,
    claims.assignmentId,
    claims.taskId,
    claims.processIdentity,
    claims.workflowId ?? null,
  ])
}
