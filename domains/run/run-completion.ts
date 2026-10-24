import { logRuntimeEvent } from '../runtime/logger.js'

export interface RunCompletionRequest {
  assignmentPath: string
  sessionId: string
  rootSessionId?: string
  parentSessionId?: string
  team: string | null
  levelId: string
  stageType: string
}

export interface RunFailureRequest extends RunCompletionRequest {
  error: string
}

/**
 * Holds a successful terminal event until the host has no more work to log.
 * A stage can satisfy its completion gate while the Pi agent loop is still
 * finishing its response, so writing `run.completed` at the gate boundary
 * would falsely make later child activity appear post-terminal.
 */
export class DeferredRunCompletion {
  private pending: RunCompletionRequest | null = null
  private emitted = false

  request(completion: RunCompletionRequest): void {
    if (this.emitted || this.pending) return
    this.pending = completion
  }

  fail(failure: RunFailureRequest): boolean {
    if (this.emitted) return false

    this.pending = null
    this.emitted = true

    logRuntimeEvent(failure.assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'run.failed',
      session_id: failure.sessionId,
      root_session_id: failure.rootSessionId,
      parent_session_id: failure.parentSessionId,
      assignment_path: failure.assignmentPath,
      team: failure.team,
      level_id: failure.levelId,
      stage_type: failure.stageType,
      error: failure.error,
    })

    return true
  }

  emitWhenIdle(isIdle: boolean): boolean {
    return isIdle ? this.emit() : false
  }

  emitOnShutdown(): boolean {
    return this.emit()
  }

  private emit(): boolean {
    if (!this.pending || this.emitted) return false

    const completion = this.pending
    this.pending = null
    this.emitted = true

    logRuntimeEvent(completion.assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'run.completed',
      session_id: completion.sessionId,
      root_session_id: completion.rootSessionId,
      parent_session_id: completion.parentSessionId,
      assignment_path: completion.assignmentPath,
      team: completion.team,
      level_id: completion.levelId,
      stage_type: completion.stageType,
    })

    return true
  }
}
