import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { writeFileAtomic } from '../core/file-mutation.js'
import { emitTaskQueueControlEvent } from '../core/task-queue-events.js'
import {
  DEFAULT_MAXIMUM_CONCURRENT_TASKS,
  isValidMaximumConcurrentTasks,
  MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE,
  parseMaximumConcurrentTasksEnvironmentValue,
  parseSchedulingSettingsFile,
  SCHEDULING_SETTINGS_SCHEMA_VERSION,
  schedulingSettingsSnapshot,
  type SchedulingSettingsFile,
  type SchedulingSettingsSnapshot,
} from '../domains/scheduling/scheduling-settings.js'

export type SchedulingSettingsServiceErrorCode =
  | 'configuration_invalid'
  | 'invalid_request'
  | 'managed_by_environment'
  | 'settings_persistence_failed'

export class SchedulingSettingsServiceError extends Error {
  constructor(
    readonly code: SchedulingSettingsServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SchedulingSettingsServiceError'
  }
}

export interface SchedulingSettingsServiceOptions {
  readonly storagePath: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

interface SchedulingSettingsState {
  readonly persisted?: SchedulingSettingsFile
  readonly environmentMaximumConcurrentTasks?: number
}

export class SchedulingSettingsService {
  private state: SchedulingSettingsState | null = null
  private loadPromise: Promise<SchedulingSettingsState> | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly environment: Readonly<Record<string, string | undefined>>

  constructor(private readonly options: SchedulingSettingsServiceOptions) {
    if (!options.storagePath.trim()) {
      throw new SchedulingSettingsServiceError(
        'configuration_invalid',
        'Scheduling settings storage path is required.',
      )
    }
    this.environment = options.environment ?? process.env
  }

  async snapshot(): Promise<SchedulingSettingsSnapshot> {
    return this.snapshotFromState(await this.ensureLoaded())
  }

  async updateMaximumConcurrentTasks(
    maximumConcurrentTasks: number,
  ): Promise<SchedulingSettingsSnapshot> {
    if (!isValidMaximumConcurrentTasks(maximumConcurrentTasks)) {
      throw new SchedulingSettingsServiceError(
        'invalid_request',
        'Maximum concurrent tasks must be an integer from 1 through 64.',
      )
    }

    return this.enqueueWrite(async () => {
      const state = await this.ensureLoaded()
      if (state.environmentMaximumConcurrentTasks !== undefined) {
        throw new SchedulingSettingsServiceError(
          'managed_by_environment',
          `Maximum concurrent tasks is managed by ${MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE}.`,
        )
      }

      if (state.persisted?.maximumConcurrentTasks === maximumConcurrentTasks) {
        return this.snapshotFromState(state)
      }

      const persisted: SchedulingSettingsFile = {
        version: SCHEDULING_SETTINGS_SCHEMA_VERSION,
        maximumConcurrentTasks,
      }
      await this.persist(persisted)
      this.state = { persisted }
      return this.snapshotFromState(this.state)
    })
  }

  private async ensureLoaded(): Promise<SchedulingSettingsState> {
    if (this.state) return this.state
    if (!this.loadPromise) this.loadPromise = this.load()
    try {
      this.state = await this.loadPromise
      return this.state
    } finally {
      this.loadPromise = null
    }
  }

  private async load(): Promise<SchedulingSettingsState> {
    const persisted = await this.loadPersistedSettings()
    let environmentMaximumConcurrentTasks: number | undefined
    try {
      environmentMaximumConcurrentTasks =
        parseMaximumConcurrentTasksEnvironmentValue(
          this.environment[MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE],
        )
    } catch (error) {
      throw new SchedulingSettingsServiceError(
        'configuration_invalid',
        `${MAXIMUM_CONCURRENT_TASKS_ENVIRONMENT_VARIABLE} is invalid.`,
        { cause: error },
      )
    }
    return {
      ...(persisted ? { persisted } : {}),
      ...(environmentMaximumConcurrentTasks === undefined
        ? {}
        : { environmentMaximumConcurrentTasks }),
    }
  }

  private async loadPersistedSettings(): Promise<SchedulingSettingsFile | undefined> {
    let content: string
    try {
      content = await fs.readFile(this.options.storagePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new SchedulingSettingsServiceError(
        'configuration_invalid',
        'Scheduling settings file could not be read.',
        { cause: error },
      )
    }

    try {
      return parseSchedulingSettingsFile(JSON.parse(content))
    } catch (error) {
      throw new SchedulingSettingsServiceError(
        'configuration_invalid',
        'Scheduling settings file is invalid.',
        { cause: error },
      )
    }
  }

  private snapshotFromState(
    state: SchedulingSettingsState,
  ): SchedulingSettingsSnapshot {
    if (state.environmentMaximumConcurrentTasks !== undefined) {
      return schedulingSettingsSnapshot({
        maximumConcurrentTasks: state.environmentMaximumConcurrentTasks,
        source: 'environment',
      })
    }
    if (state.persisted) {
      return schedulingSettingsSnapshot({
        maximumConcurrentTasks: state.persisted.maximumConcurrentTasks,
        source: 'persisted',
      })
    }
    return schedulingSettingsSnapshot({
      maximumConcurrentTasks: DEFAULT_MAXIMUM_CONCURRENT_TASKS,
      source: 'default',
    })
  }

  private async persist(settings: SchedulingSettingsFile): Promise<void> {
    const directory = path.dirname(this.options.storagePath)
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700)
      await writeFileAtomic(
        this.options.storagePath,
        `${JSON.stringify(settings, null, 2)}\n`,
      )
      await fs.chmod(this.options.storagePath, 0o600)
    } catch (error) {
      emitTaskQueueControlEvent(directory, {
        event: 'scheduling_settings.persistence_failed',
        reason: error instanceof Error ? error.message : String(error),
      })
      throw new SchedulingSettingsServiceError(
        'settings_persistence_failed',
        'Scheduling settings could not be persisted.',
        { cause: error },
      )
    }
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.writeQueue.then(operation)
    this.writeQueue = running.then(() => undefined, () => undefined)
    return running
  }
}
