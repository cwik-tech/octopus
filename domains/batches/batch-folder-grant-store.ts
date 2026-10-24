import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { writeFileAtomic } from '../../core/file-mutation.js'
import { resolveCanonicalDirectory } from '../../core/path-safety.js'

interface BatchFolderGrantsFileV1 {
  readonly schemaVersion: 1
  readonly grants: readonly string[]
}

export class BatchFolderGrantStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BatchFolderGrantStoreUnavailableError'
  }
}

export class BatchFolderGrantStore {
  private operationTail: Promise<void> = Promise.resolve()
  private grants: string[] = []
  private initialized = false
  private unavailableError: Error | undefined
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storagePath: string) {}

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storagePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      this.grants = raw === null ? [] : parseGrantFile(JSON.parse(raw)).grants.slice()
      this.initialized = true
      this.unavailableError = undefined
    } catch (error) {
      this.initialized = false
      this.unavailableError = error instanceof Error ? error : new Error(String(error))
      throw new BatchFolderGrantStoreUnavailableError(
        `Batch folder grant store failed to initialize: ${this.unavailableError.message}`,
        { cause: this.unavailableError },
      )
    }
  }

  async list(): Promise<readonly string[]> {
    return this.enqueue(async () => [...this.grants])
  }

  async grant(folderPath: string): Promise<string> {
    return this.enqueue(async () => {
      const canonical = await resolveCanonicalDirectory(folderPath)
      if (!canonical) throw new Error('Batch folder grant path must be an existing directory.')
      if (!this.grants.includes(canonical)) {
        this.grants = sortPaths([...this.grants, canonical])
        await this.persist()
        this.notify()
      }
      return canonical
    })
  }

  async revoke(folderPath: string): Promise<boolean> {
    return this.enqueue(async () => {
      const canonical = await fs.realpath(folderPath).catch(() => path.resolve(folderPath))
      const next = this.grants.filter((grant) => grant !== canonical)
      if (next.length === this.grants.length) return false
      this.grants = next
      await this.persist()
      this.notify()
      return true
    })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async persist(): Promise<void> {
    const state: BatchFolderGrantsFileV1 = {
      schemaVersion: 1,
      grants: this.grants,
    }
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.storagePath, `${JSON.stringify(state, null, 2)}\n`)
    await fs.chmod(this.storagePath, 0o600)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable()
    const running = this.operationTail.then(operation)
    this.operationTail = running.then(() => undefined, () => undefined)
    return running
  }

  private assertAvailable(): void {
    if (!this.initialized || this.unavailableError) {
      throw new BatchFolderGrantStoreUnavailableError('Batch folder grant store is unavailable.', {
        cause: this.unavailableError,
      })
    }
  }
}

function parseGrantFile(value: unknown): BatchFolderGrantsFileV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Batch folder grant state must be a JSON object.')
  }
  const source = value as Record<string, unknown>
  const unknown = Object.keys(source).filter((key) => key !== 'schemaVersion' && key !== 'grants')
  if (unknown.length > 0) throw new Error(`Batch folder grants contain unknown fields: ${unknown.join(', ')}.`)
  if (source.schemaVersion !== 1) throw new Error('Batch folder grants use an unsupported schema version.')
  if (!Array.isArray(source.grants)) throw new Error('Batch folder grants must contain an array.')
  const grants = source.grants.map((grant) => {
    if (typeof grant !== 'string' || !path.isAbsolute(grant)) {
      throw new Error('Batch folder grant path must be absolute.')
    }
    return path.normalize(grant)
  })
  if (new Set(grants).size !== grants.length) throw new Error('Batch folder grants contain duplicates.')
  return { schemaVersion: 1, grants: sortPaths(grants) }
}

function sortPaths(values: readonly string[]): string[] {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
}
