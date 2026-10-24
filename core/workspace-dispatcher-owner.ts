import { whenDefined } from './optional-properties.js'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  acquireProcessFileLock,
  ProcessFileLockError,
  type AcquiredProcessFileLock,
  type ProcessFileLockAdapter,
} from './cross-process-file-lock.js'
import { emitWorkspaceTaskQueueEvent } from './task-queue-events.js'

export const TASK_QUEUE_CONTROL_DIRECTORY = 'task-queue'
export const TASK_QUEUE_OWNER_FILENAME = 'owner.lock'

export interface WorkspaceOwnerRecordV1 {
  version: 1
  pid: number
  instanceId: string
  epoch: string
  acquiredAt: string
}

export class WorkspaceDispatcherOwnerError extends Error {
  constructor(
    readonly code: 'workspace_in_use' | 'owner_corrupt' | 'ownership_lost',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceDispatcherOwnerError'
  }
}

const ownerAdapter: ProcessFileLockAdapter<WorkspaceOwnerRecordV1> = {
  parse: parseWorkspaceOwnerRecord,
  pid: (record) => record.pid,
  token: (record) => record.epoch,
}

export class WorkspaceDispatcherOwner {
  private constructor(
    readonly controlDirectory: string,
    private readonly lock: AcquiredProcessFileLock<WorkspaceOwnerRecordV1>,
  ) {}

  static async acquire(params: {
    workspacePath: string
    instanceId?: string
    pid?: number
    now?: () => Date
    isProcessAlive?: (pid: number) => boolean
  }): Promise<WorkspaceDispatcherOwner> {
    const controlDirectory = path.join(
      params.workspacePath,
      TASK_QUEUE_CONTROL_DIRECTORY,
    )
    await fs.mkdir(controlDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(controlDirectory, 0o700)
    const record: WorkspaceOwnerRecordV1 = {
      version: 1,
      pid: params.pid ?? process.pid,
      instanceId: params.instanceId ?? crypto.randomUUID(),
      epoch: crypto.randomUUID(),
      acquiredAt: (params.now ?? (() => new Date()))().toISOString(),
    }
    try {
      const lock = await acquireProcessFileLock({
        lockPath: path.join(controlDirectory, TASK_QUEUE_OWNER_FILENAME),
        record,
        adapter: ownerAdapter,
        timeoutMs: 0,
        corruptBehavior: 'fail',
        ...whenDefined(params.isProcessAlive, (definedValue) => ({ isProcessAlive: definedValue })),
      })
      await fs.chmod(lock.path, 0o600)
      if (lock.reclaimed) {
        emitWorkspaceTaskQueueEvent(params.workspacePath, {
          event: 'task_queue.owner_reclaimed',
          owner_epoch: record.epoch,
          owner_instance_id: record.instanceId,
          owner_pid: record.pid,
        })
      }
      emitWorkspaceTaskQueueEvent(params.workspacePath, {
        event: 'task_queue.owner_acquired',
        owner_epoch: record.epoch,
        owner_instance_id: record.instanceId,
        owner_pid: record.pid,
      })
      return new WorkspaceDispatcherOwner(controlDirectory, lock)
    } catch (error) {
      if (error instanceof ProcessFileLockError) {
        emitWorkspaceTaskQueueEvent(params.workspacePath, {
          event: 'task_queue.owner_conflict',
          owner_instance_id: record.instanceId,
          owner_pid: record.pid,
          reason: error.code,
        })
        if (error.code === 'corrupt') {
          throw new WorkspaceDispatcherOwnerError(
            'owner_corrupt',
            'Workspace dispatcher owner record is corrupt',
          )
        }
        throw new WorkspaceDispatcherOwnerError(
          'workspace_in_use',
          'Workspace already has a live dispatcher owner',
        )
      }
      throw error
    }
  }

  get record(): WorkspaceOwnerRecordV1 {
    return this.lock.record
  }

  get epoch(): string {
    return this.lock.record.epoch
  }

  async assertCurrent(): Promise<void> {
    if (await this.lock.isCurrentOwner()) return
    throw new WorkspaceDispatcherOwnerError(
      'ownership_lost',
      'Workspace dispatcher ownership was lost',
    )
  }

  async release(): Promise<void> {
    await this.lock.release()
  }
}

export function parseWorkspaceOwnerRecord(
  value: unknown,
): WorkspaceOwnerRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<WorkspaceOwnerRecordV1>
  if (
    record.version !== 1 ||
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.instanceId !== 'string' ||
    !record.instanceId ||
    typeof record.epoch !== 'string' ||
    !record.epoch ||
    typeof record.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(record.acquiredAt))
  ) {
    return null
  }
  return {
    version: 1,
    pid: record.pid,
    instanceId: record.instanceId,
    epoch: record.epoch,
    acquiredAt: record.acquiredAt,
  }
}
