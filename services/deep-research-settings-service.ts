import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION,
  DEFAULT_DEEP_RESEARCH_DURATION_MINUTES,
  DEFAULT_MAXIMUM_RESEARCHER_AGENTS,
  deepResearchSettingsSnapshot,
  parseDeepResearchSettingsFile,
  validateDeepResearchSettingsValues,
  type DeepResearchSettingsFile,
  type DeepResearchSettingsSnapshot,
  type DeepResearchSettingsValues,
} from '../domains/deep-research/deep-research-settings.js'
import { writeFileAtomic } from '../core/file-mutation.js'

export type DeepResearchSettingsServiceErrorCode =
  | 'configuration_invalid'
  | 'invalid_request'
  | 'settings_persistence_failed'

export class DeepResearchSettingsServiceError extends Error {
  constructor(
    readonly code: DeepResearchSettingsServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'DeepResearchSettingsServiceError'
  }
}

export interface DeepResearchSettingsServiceOptions {
  readonly storagePath: string
}

export class DeepResearchSettingsService {
  private persisted: DeepResearchSettingsFile | undefined
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: DeepResearchSettingsServiceOptions) {
    if (!options.storagePath.trim()) {
      throw new DeepResearchSettingsServiceError(
        'configuration_invalid',
        'Deep Research settings storage path is required.',
      )
    }
  }

  async snapshot(): Promise<DeepResearchSettingsSnapshot> {
    await this.ensureLoaded()
    return this.snapshotFromState()
  }

  async update(
    values: DeepResearchSettingsValues,
  ): Promise<DeepResearchSettingsSnapshot> {
    try {
      validateDeepResearchSettingsValues(values)
    } catch (error) {
      throw new DeepResearchSettingsServiceError(
        'invalid_request',
        error instanceof Error ? error.message : 'Deep Research settings are invalid.',
        { cause: error },
      )
    }

    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      if (
        this.persisted?.maxDurationMinutes === values.maxDurationMinutes
        && this.persisted.maxResearcherAgents === values.maxResearcherAgents
      ) {
        return this.snapshotFromState()
      }

      const persisted: DeepResearchSettingsFile = {
        schemaVersion: DEEP_RESEARCH_SETTINGS_SCHEMA_VERSION,
        maxDurationMinutes: values.maxDurationMinutes,
        maxResearcherAgents: values.maxResearcherAgents,
      }
      await this.persist(persisted)
      this.persisted = persisted
      return this.snapshotFromState()
    })
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loadPromise) this.loadPromise = this.load()
    try {
      await this.loadPromise
      this.loaded = true
    } finally {
      this.loadPromise = null
    }
  }

  private async load(): Promise<void> {
    let content: string
    try {
      content = await fs.readFile(this.options.storagePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new DeepResearchSettingsServiceError(
        'configuration_invalid',
        'Deep Research settings file could not be read.',
        { cause: error },
      )
    }

    try {
      this.persisted = parseDeepResearchSettingsFile(JSON.parse(content))
    } catch (error) {
      throw new DeepResearchSettingsServiceError(
        'configuration_invalid',
        'Deep Research settings file is invalid.',
        { cause: error },
      )
    }
  }

  private snapshotFromState(): DeepResearchSettingsSnapshot {
    if (this.persisted) {
      return deepResearchSettingsSnapshot({
        values: this.persisted,
        source: 'persisted',
      })
    }
    return deepResearchSettingsSnapshot({
      values: {
        maxDurationMinutes: DEFAULT_DEEP_RESEARCH_DURATION_MINUTES,
        maxResearcherAgents: DEFAULT_MAXIMUM_RESEARCHER_AGENTS,
      },
      source: 'default',
    })
  }

  private async persist(settings: DeepResearchSettingsFile): Promise<void> {
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
      throw new DeepResearchSettingsServiceError(
        'settings_persistence_failed',
        'Deep Research settings could not be persisted.',
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
