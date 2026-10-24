/**
 * The durable record of what Octopus has told, or must still tell, the voice
 * layer (docs/feature-voice-control-mcp.md, "Notification delivery").
 *
 * An entry is written before any call and marked delivered only on a
 * successful `notify` result, so a crash can repeat a send but never lose one.
 * The voice layer removes the repeats by `dedupeKey`.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import * as z from 'zod/v4'

import { voiceNotifyInputSchema } from '../../contracts/voice-control.js'

/** How long an entry is kept, and how far back a task change is announced (D8). */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const outboxEntrySchema = z.object({
  key: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1),
  /** The task status this announces, rechecked before every send. */
  taskStatus: z.string().min(1),
  /** The question or offer it is about, rechecked for `needs_*` entries. */
  questionId: z.string().optional(),
  notify: voiceNotifyInputSchema,
  state: z.enum(['pending', 'delivered', 'discarded']),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().optional(),
  /** When the task reached the announced state; drives retention. */
  taskChangedAt: z.iso.datetime(),
})

export type OutboxEntry = z.infer<typeof outboxEntrySchema>

const outboxFileSchema = z.object({
  version: z.literal(1),
  /**
   * When voice control first ran in this workspace. Task changes before it are
   * never announced, so turning the feature on does not replay old work.
   */
  since: z.iso.datetime(),
  entries: z.array(outboxEntrySchema),
})

export class NotificationOutbox {
  private constructor(
    private readonly file: string,
    readonly since: string,
    private readonly entries: Map<string, OutboxEntry>,
  ) {}

  /**
   * Opens the outbox, creating it with `since` set to `now` when it does not
   * exist. A file that cannot be read is replaced rather than trusted: losing
   * the record can repeat an announcement, which the voice layer absorbs.
   */
  static async open(file: string, now: Date): Promise<NotificationOutbox> {
    let parsed: z.infer<typeof outboxFileSchema> | undefined
    try {
      const result = outboxFileSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')))
      if (result.success) parsed = result.data
    } catch {
      parsed = undefined
    }
    const outbox = new NotificationOutbox(
      file,
      parsed?.since ?? now.toISOString(),
      new Map((parsed?.entries ?? []).map((entry) => [entry.key, entry] as const)),
    )
    if (!parsed) await outbox.persist()
    return outbox
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** Pending entries, oldest first. */
  pending(): readonly OutboxEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'pending')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /**
   * Writes a new pending entry and flushes it. A known key changes nothing.
   * The entry is checked before it is kept, and dropped again if it cannot be
   * written, so one bad entry never stops the outbox from being saved.
   */
  async record(entry: Omit<OutboxEntry, 'state' | 'settledAt'>): Promise<boolean> {
    if (this.entries.has(entry.key)) return false
    const candidate = outboxEntrySchema.parse({ ...entry, state: 'pending' })
    this.entries.set(candidate.key, candidate)
    try {
      await this.persist()
    } catch (error) {
      this.entries.delete(candidate.key)
      throw error
    }
    return true
  }

  async settle(key: string, state: 'delivered' | 'discarded', now: Date): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry || entry.state !== 'pending') return
    this.entries.set(key, { ...entry, state, settledAt: now.toISOString() })
    try {
      await this.persist()
    } catch (error) {
      this.entries.set(key, entry)
      throw error
    }
  }

  /** Drops entries about task changes older than the retention window. */
  async prune(now: Date): Promise<void> {
    const cutoff = now.getTime() - OUTBOX_RETENTION_MS
    let changed = false
    for (const [key, entry] of this.entries) {
      if (Date.parse(entry.taskChangedAt) < cutoff) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  /** Written to a private temporary file and renamed, so a crash leaves the old or the new file whole. */
  private async persist(): Promise<void> {
    const directory = path.dirname(this.file)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.${path.basename(this.file)}.${randomBytes(6).toString('hex')}.tmp`)
    const body = outboxFileSchema.parse({
      version: 1,
      since: this.since,
      entries: [...this.entries.values()],
    })
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, this.file)
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
}
