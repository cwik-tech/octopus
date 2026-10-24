import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { writeFileAtomic } from '../core/file-mutation.js'

const LEDGER_SCHEMA_VERSION = 1
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000

interface GeminiUsageEntry {
  readonly runId: string
  readonly videoId: string
  readonly startedAt: string
  readonly estimatedMinutes: number
  readonly status: 'reserved' | 'complete'
  readonly completedAt?: string
  readonly actualMinutes?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
}

interface GeminiUsageFile {
  readonly usageSchemaVersion: typeof LEDGER_SCHEMA_VERSION
  readonly entries: readonly GeminiUsageEntry[]
}

export class YoutubeGeminiUsageLedger {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: {
    readonly storagePath: string
    readonly now?: () => Date
  }) {}

  reserve(input: {
    readonly runId: string
    readonly videoId: string
    readonly estimatedMinutes: number
    readonly limitMinutes: number
    readonly allowOverLimit?: boolean
  }): Promise<{ readonly accepted: boolean; readonly rollingMinutes: number }> {
    return this.enqueue(async () => {
      const now = this.now()
      const entries = this.activeEntries(await this.read(), now)
      const existing = entries.find((entry) => entry.runId === input.runId)
      const rollingMinutes = sumMinutes(entries)
      if (existing) return { accepted: true, rollingMinutes }
      if (!input.allowOverLimit && rollingMinutes + input.estimatedMinutes > input.limitMinutes) {
        return { accepted: false, rollingMinutes }
      }
      const next: GeminiUsageEntry[] = [...entries, {
        runId: input.runId,
        videoId: input.videoId,
        startedAt: now.toISOString(),
        estimatedMinutes: input.estimatedMinutes,
        status: 'reserved',
      }]
      await this.persist(next)
      return { accepted: true, rollingMinutes: rollingMinutes + input.estimatedMinutes }
    })
  }

  complete(runId: string, usage: {
    readonly actualMinutes: number
    readonly inputTokens?: number
    readonly outputTokens?: number
  }): Promise<void> {
    return this.enqueue(async () => {
      const now = this.now()
      const entries = this.activeEntries(await this.read(), now)
      const found = entries.some((entry) => entry.runId === runId)
      if (!found) return
      await this.persist(entries.map((entry): GeminiUsageEntry => entry.runId === runId
        ? {
            ...entry,
            status: 'complete',
            completedAt: now.toISOString(),
            actualMinutes: usage.actualMinutes,
            ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          }
        : entry))
    })
  }

  release(runId: string): Promise<void> {
    return this.enqueue(async () => {
      const now = this.now()
      const entries = this.activeEntries(await this.read(), now)
      await this.persist(entries.filter((entry) =>
        entry.runId !== runId || entry.status === 'complete'))
    })
  }

  rollingUsage(): Promise<{
    readonly reservedMinutes: number
    readonly completedMinutes: number
    readonly totalMinutes: number
  }> {
    return this.enqueue(async () => {
      const entries = this.activeEntries(await this.read(), this.now())
      const reservedMinutes = entries
        .filter((entry) => entry.status === 'reserved')
        .reduce((total, entry) => total + entry.estimatedMinutes, 0)
      const completedMinutes = entries
        .filter((entry) => entry.status === 'complete')
        .reduce((total, entry) => total + (entry.actualMinutes ?? entry.estimatedMinutes), 0)
      return { reservedMinutes, completedMinutes, totalMinutes: reservedMinutes + completedMinutes }
    })
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private activeEntries(file: GeminiUsageFile, now: Date): GeminiUsageEntry[] {
    const cutoff = now.getTime() - ROLLING_WINDOW_MS
    return file.entries.filter((entry) => {
      const timestamp = Date.parse(entry.completedAt ?? entry.startedAt)
      return Number.isFinite(timestamp) && timestamp > cutoff && timestamp <= now.getTime()
    })
  }

  private async read(): Promise<GeminiUsageFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.storagePath, 'utf8')) as GeminiUsageFile
      if (parsed.usageSchemaVersion !== LEDGER_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
        throw new Error('Gemini usage ledger is invalid.')
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { usageSchemaVersion: LEDGER_SCHEMA_VERSION, entries: [] }
      }
      throw error
    }
  }

  private async persist(entries: readonly GeminiUsageEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.options.storagePath), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.options.storagePath, `${JSON.stringify({
      usageSchemaVersion: LEDGER_SCHEMA_VERSION,
      entries,
    }, null, 2)}\n`)
    if (process.platform !== 'win32') await fs.chmod(this.options.storagePath, 0o600)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.queue.then(operation)
    this.queue = running.then(() => undefined, () => undefined)
    return running
  }
}

function sumMinutes(entries: readonly GeminiUsageEntry[]): number {
  return entries.reduce((total, entry) => total + (
    entry.status === 'complete' ? entry.actualMinutes ?? entry.estimatedMinutes : entry.estimatedMinutes
  ), 0)
}
