import type {
  CapabilityAssignmentScope,
  CapabilityDispatchResult,
  CapabilityInvocationBindingAcquireInput,
  CapabilityInvocationBindingAcquisition,
  CapabilityInvocationBindingPort,
} from '../contracts/capability-dispatch.js'

export interface CapabilityInvocationBindingsOptions {
  readonly maxActivePerScope: number
  readonly maxRetainedPerScope: number
}

interface BindingScope {
  readonly records: Map<string, BindingRecord>
  activeLeaders: number
  releaseRequested: boolean
}

class BindingRecord {
  readonly result: Promise<CapabilityDispatchResult>
  terminalResult: CapabilityDispatchResult | undefined
  private resolveResult: ((result: CapabilityDispatchResult) => void) | undefined

  constructor(
    readonly argumentDigest: string,
    readonly sequence: number,
    private readonly onComplete: () => void,
    private readonly onAbandon: () => void,
  ) {
    this.result = new Promise<CapabilityDispatchResult>((resolve) => {
      this.resolveResult = resolve
    })
  }

  complete(result: CapabilityDispatchResult): void {
    if (this.terminalResult) return
    this.terminalResult = result
    const resolve = this.resolveResult
    this.resolveResult = undefined
    resolve?.(result)
    this.onComplete()
  }

  /**
   * Settle waiting followers without recording a terminal result, so the
   * record is not retained and the next attempt leads again.
   */
  abandon(result: CapabilityDispatchResult): void {
    if (this.terminalResult) return
    const resolve = this.resolveResult
    this.resolveResult = undefined
    resolve?.(result)
    this.onAbandon()
  }
}

export class CapabilityInvocationBindings implements CapabilityInvocationBindingPort {
  readonly marker = 'capability-invocation-binding-port' as const
  private readonly scopes = new Map<string, BindingScope>()
  private nextSequence = 1

  constructor(readonly options: CapabilityInvocationBindingsOptions) {
    if (!isPositiveInteger(options.maxActivePerScope)) {
      throw new Error('maxActivePerScope must be a positive integer')
    }
    if (!isNonNegativeInteger(options.maxRetainedPerScope)) {
      throw new Error('maxRetainedPerScope must be a non-negative integer')
    }
  }

  acquire(
    input: CapabilityInvocationBindingAcquireInput,
  ): CapabilityInvocationBindingAcquisition {
    const scope = this.scope(input.scopeKey)
    const existing = scope.records.get(input.dispatchId)
    if (existing) {
      if (existing.argumentDigest !== input.argumentDigest) {
        return {
          kind: 'conflict',
          code: 'invocation_identity_conflict',
        }
      }
      if (existing.terminalResult) {
        return { kind: 'retained', result: existing.terminalResult }
      }
      return {
        kind: 'follower',
        wait: (signal) => waitForResult(existing.result, signal),
      }
    }

    if (scope.releaseRequested || scope.activeLeaders >= this.options.maxActivePerScope) {
      return { kind: 'capacity-exceeded', code: 'capacity_exceeded' }
    }

    scope.activeLeaders += 1
    const record = new BindingRecord(
      input.argumentDigest,
      this.nextSequence,
      () => this.completeLeader(input.scopeKey, input.dispatchId, scope),
      () => this.abandonLeader(input.scopeKey, input.dispatchId, scope),
    )
    this.nextSequence += 1
    scope.records.set(input.dispatchId, record)
    return {
      kind: 'leader',
      complete: (result) => record.complete(result),
      abandon: (result) => record.abandon(result),
    }
  }

  releaseScope(scopeKey: string): void {
    const scope = this.scopes.get(scopeKey)
    if (!scope) return
    scope.releaseRequested = true
    if (scope.activeLeaders === 0) this.scopes.delete(scopeKey)
  }

  releaseAssignment(scope: CapabilityAssignmentScope): void {
    if (!isAssignmentScope(scope)) {
      throw new Error('Capability binding assignment identity is invalid.')
    }
    for (const scopeKey of this.scopes.keys()) {
      if (belongsToAssignment(scopeKey, scope)) this.releaseScope(scopeKey)
    }
  }

  private scope(scopeKey: string): BindingScope {
    const existing = this.scopes.get(scopeKey)
    if (existing) return existing
    const created: BindingScope = {
      records: new Map<string, BindingRecord>(),
      activeLeaders: 0,
      releaseRequested: false,
    }
    this.scopes.set(scopeKey, created)
    return created
  }

  private completeLeader(
    scopeKey: string,
    dispatchId: string,
    scope: BindingScope,
  ): void {
    scope.activeLeaders = Math.max(0, scope.activeLeaders - 1)
    if (scope.releaseRequested) {
      if (scope.activeLeaders === 0) this.scopes.delete(scopeKey)
      return
    }
    this.trimRetained(scope, dispatchId)
  }

  /**
   * Drop the record instead of retaining it. The dispatch never reached a
   * terminal state of its own, so a later attempt must start clean.
   */
  private abandonLeader(
    scopeKey: string,
    dispatchId: string,
    scope: BindingScope,
  ): void {
    scope.activeLeaders = Math.max(0, scope.activeLeaders - 1)
    scope.records.delete(dispatchId)
    if (scope.releaseRequested && scope.activeLeaders === 0) {
      this.scopes.delete(scopeKey)
    }
  }

  private trimRetained(scope: BindingScope, newestDispatchId: string): void {
    const retained = [...scope.records.entries()]
      .filter((entry) => entry[1].terminalResult !== undefined)
      .sort((left, right) => left[1].sequence - right[1].sequence)
    const excess = retained.length - this.options.maxRetainedPerScope
    if (excess <= 0) return
    for (const [dispatchId] of retained.slice(0, excess)) {
      scope.records.delete(dispatchId)
    }
    if (this.options.maxRetainedPerScope === 0) {
      scope.records.delete(newestDispatchId)
    }
  }
}

function waitForResult(
  result: Promise<CapabilityDispatchResult>,
  signal: AbortSignal,
): Promise<CapabilityDispatchResult> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<CapabilityDispatchResult>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void result.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('Capability wait was cancelled.', 'AbortError')
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function belongsToAssignment(
  scopeKey: string,
  assignment: CapabilityAssignmentScope,
): boolean {
  const parts = scopeKey.split('\0', 4)
  return parts[0] === assignment.sessionId &&
    parts[1] === assignment.runId &&
    parts[2] === assignment.assignmentId
}

function isAssignmentScope(value: CapabilityAssignmentScope): boolean {
  return isIdentityPart(value.sessionId) &&
    isIdentityPart(value.runId) &&
    isIdentityPart(value.assignmentId)
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/.test(value)
}
