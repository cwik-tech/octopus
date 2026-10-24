import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  CapabilityAssignmentScope,
  CapabilityDispatchEvent,
  CapabilityEvidencePort,
} from '../contracts/capability-dispatch.js'
import { buildSessionRunAssignmentLocation } from '../domains/run/run-location.js'
import { AssignmentCapabilityEvidenceWriter } from '../domains/runtime/capability-evidence-writer.js'

export interface WorkspaceCapabilityEvidenceWriterOptions {
  readonly workspacePath: string
}

/** Routes events to one ordered writer per canonical assignment directory. */
export class WorkspaceCapabilityEvidenceWriter implements CapabilityEvidencePort {
  private readonly workspacePath: string
  private readonly writers = new Map<
    string,
    Promise<AssignmentCapabilityEvidenceWriter>
  >()
  private readonly releases = new Map<string, Promise<void>>()
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(options: WorkspaceCapabilityEvidenceWriterOptions) {
    if (!isNonEmptyString(options.workspacePath)) {
      throw new Error('Capability evidence workspace path is invalid.')
    }
    this.workspacePath = path.resolve(options.workspacePath)
  }

  append(event: CapabilityDispatchEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Capability evidence writer is closed.'))
    }
    return this.writerFor(event).then((writer) => writer.append(event))
  }

  /** Evicts one terminal assignment owner after every accepted append settles. */
  releaseAssignment(scope: CapabilityAssignmentScope): Promise<void> {
    if (!isAssignmentScope(scope)) {
      return Promise.reject(
        new Error('Capability evidence assignment identity is invalid.'),
      )
    }
    const key = assignmentIdentityKey(scope)
    const activeRelease = this.releases.get(key)
    if (activeRelease) return activeRelease
    const writerPromise = this.writers.get(key)
    if (!writerPromise) return Promise.resolve()
    this.writers.delete(key)
    const release = writerPromise.then((writer) => writer.close())
    this.releases.set(key, release)
    void release.then(
      () => this.deleteRelease(key, release),
      () => this.deleteRelease(key, release),
    )
    return release
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = Promise.all(
      [
        ...[...this.writers.values()].map(async (writerPromise) => {
          const writer = await writerPromise
          await writer.close()
        }),
        ...this.releases.values(),
      ],
    ).then(() => undefined)
    return this.closePromise
  }

  private deleteRelease(key: string, release: Promise<void>): void {
    if (this.releases.get(key) === release) this.releases.delete(key)
  }

  private writerFor(
    event: CapabilityDispatchEvent,
  ): Promise<AssignmentCapabilityEvidenceWriter> {
    const key = assignmentIdentityKey(event)
    const existing = this.writers.get(key)
    if (existing) return existing
    const created = this.createWriter(event)
    this.writers.set(key, created)
    void created.catch(() => {
      if (this.writers.get(key) === created) this.writers.delete(key)
    })
    return created
  }

  private async createWriter(
    event: CapabilityDispatchEvent,
  ): Promise<AssignmentCapabilityEvidenceWriter> {
    const location = buildSessionRunAssignmentLocation(this.workspacePath, event)
    if (!location) {
      throw new Error('Capability evidence assignment path is invalid.')
    }
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
        path.join(runRealPath, 'assignments', event.assignmentId)
    ) {
      throw new Error('Capability evidence assignment path is not canonical.')
    }
    return new AssignmentCapabilityEvidenceWriter({
      assignmentPath: assignmentRealPath,
      sessionId: event.sessionId,
      runId: event.runId,
      assignmentId: event.assignmentId,
    })
  }
}

function assignmentIdentityKey(input: {
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
}): string {
  return [input.sessionId, input.runId, input.assignmentId].join('\0')
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}
