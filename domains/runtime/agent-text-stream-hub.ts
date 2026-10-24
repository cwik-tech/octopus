/**
 * Ephemeral agent text stream hub — in-memory, display-only.
 *
 * ADR: `docs/adr/2026-08-22-Ephemeral-Agent-Text-Stream.md`.
 *
 * Holds a bounded ring of frames per channel and assigns the channel-global
 * cursor that orders delivery. It is the only component that observes a whole
 * channel, which is why it — not a producer — owns the cursor.
 *
 * Invariant 9: this module performs no I/O and never awaits. `publish` appends,
 * assigns a cursor, fires cheap synchronous notifications, and returns. Writing
 * is the SSE route's job, because `writeSseEvent` resolves on `drain` and
 * awaiting it here would couple model generation to renderer and socket speed.
 *
 * Frames are lossy by design: the durable `ChatMessage` remains authoritative,
 * so a dropped frame costs nothing. What must never happen is silent loss —
 * hence the `gap` frame below and the route's `reset` control.
 */

import type {
  AgentTextGapFrame,
  AgentTextStreamFrame,
  AgentTextStreamInput,
  AgentTextProgressInput,
} from '../../contracts/agent-text-stream.js'

/** Returned by `publish` when the frame was deduped, or the channel is gone. */
export const PUBLISH_IGNORED = -1

/** Outcome of waiting for a channel that its turn has not opened yet. */
export type AgentTextStreamWaitResult =
  | 'opened'
  | 'timeout'
  | 'aborted'
  | 'rejected'

export interface AgentTextStreamWaitOptions {
  /** Bounded deadline. A waiter is never open-ended. */
  readonly timeoutMs: number
  /** Aborts the wait when the requesting connection closes. */
  readonly signal?: AbortSignal
}

export interface AgentTextStreamHubOptions {
  /** Frames retained per channel. Older frames age out and become a `reset`. */
  readonly ringCapacity?: number
  /** How long a closed channel stays readable, so a late reader can drain it. */
  readonly closedRetentionMs?: number
  /** Injectable for deterministic tests; the hub keeps no timers of its own. */
  readonly now?: () => number
  /** Ceiling on concurrent waiters, so idle GETs cannot grow memory. */
  readonly maxPendingWaiters?: number
  /** Injectable so a bounded deadline can be proved without real time. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => () => void
}

export interface AgentTextStreamPage {
  readonly progressSnapshots?: readonly AgentTextProgressInput[]
  readonly frames: readonly AgentTextStreamFrame[]
  /** Oldest cursor still held. Greater than a caller's cursor means eviction. */
  readonly retainedFromCursor: number
  /** The cursor the next accepted frame will receive. */
  readonly nextCursor: number
  readonly closed: boolean
}

export type AgentTextStreamNotifier = () => void

const DEFAULT_RING_CAPACITY = 512
const DEFAULT_CLOSED_RETENTION_MS = 60_000
const DEFAULT_MAX_PENDING_WAITERS = 64
const MAX_PROGRESS_REPLY_IDENTITIES = 64

interface PendingWaiter {
  readonly channelId: string
  readonly ownerId: string
  readonly settle: (result: AgentTextStreamWaitResult) => void
}

interface ChannelState {
  /** Null remembers a terminal reply without retaining its progress payload. */
  progress: Map<string, AgentTextProgressInput | null>
  /**
   * Who the channel belongs to. A channel id alone must not grant access: the
   * SSE route is addressed by session, and serving a channel through a
   * different session's URL would leak one conversation's live text into
   * another. The hub records the owner so the route can enforce its own path.
   */
  ownerId: string | undefined
  frames: AgentTextStreamFrame[]
  nextCursor: number
  /** Last accepted `producerSequence` per reply, for cross-process dedupe. */
  lastProducerSequence: Map<string, number>
  subscribers: Set<AgentTextStreamNotifier>
  closedAt: number | undefined
}

export class AgentTextStreamHub {
  private readonly channels = new Map<string, ChannelState>()
  private readonly ringCapacity: number
  private readonly closedRetentionMs: number
  private readonly now: () => number
  private readonly maxPendingWaiters: number
  private readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => () => void

  /** Keyed by `${ownerId}\u0000${channelId}` — one waiter per pair. */
  private readonly waiters = new Map<string, PendingWaiter>()

  constructor(options: AgentTextStreamHubOptions = {}) {
    this.ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY
    this.closedRetentionMs =
      options.closedRetentionMs ?? DEFAULT_CLOSED_RETENTION_MS
    this.now = options.now ?? Date.now
    this.maxPendingWaiters =
      options.maxPendingWaiters ?? DEFAULT_MAX_PENDING_WAITERS
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
  }

  /** Number of connections currently waiting for a channel to be opened. */
  get pendingWaiterCount(): number {
    return this.waiters.size
  }

  /**
   * Wait for `channelId` to be opened by `ownerId`.
   *
   * The UI mints a turn id, subscribes, and only then sends the turn, so a
   * stream can legitimately arrive before its channel exists. Waiting turns
   * that arrival order into a contract.
   *
   * A waiter never creates or reserves the channel: only the POST that owns the
   * turn may do that. So an unmatched GET leaves nothing behind, and is bounded
   * three ways — one waiter per (owner, channel), a global ceiling, and an
   * explicit deadline — so idle connections cannot accumulate.
   */
  waitForChannel(
    channelId: string,
    ownerId: string,
    options: AgentTextStreamWaitOptions,
  ): Promise<AgentTextStreamWaitResult> {
    if (options.signal?.aborted) return Promise.resolve('aborted')

    const key = `${ownerId}\u0000${channelId}`
    if (this.waiters.has(key) || this.waiters.size >= this.maxPendingWaiters) {
      return Promise.resolve('rejected')
    }

    return new Promise<AgentTextStreamWaitResult>((resolve) => {
      let settled = false
      let cancelTimeout: () => void = () => {}

      const settle = (result: AgentTextStreamWaitResult): void => {
        if (settled) return
        settled = true
        this.waiters.delete(key)
        cancelTimeout()
        options.signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => settle('aborted')

      this.waiters.set(key, { channelId, ownerId, settle })
      cancelTimeout = this.scheduleTimeout(
        () => settle('timeout'),
        options.timeoutMs,
      )
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  openChannel(channelId: string, ownerId?: string): void {
    this.evictExpired()
    if (this.channels.has(channelId)) {
      throw new Error(`Agent text stream channel is already open: ${channelId}`)
    }
    this.channels.set(channelId, {
      ownerId,
      frames: [],
      progress: new Map(),
      nextCursor: 0,
      lastProducerSequence: new Map(),
      subscribers: new Set(),
      closedAt: undefined,
    })
    this.releaseWaiters(channelId, ownerId)
  }

  private releaseWaiters(channelId: string, ownerId: string | undefined): void {
    if (ownerId === undefined) return
    const waiter = this.waiters.get(`${ownerId}\u0000${channelId}`)
    waiter?.settle('opened')
  }

  /**
   * Append one producer frame. Returns its cursor, or `PUBLISH_IGNORED` when
   * the frame was a duplicate or the channel is closed or unknown.
   *
   * A closed or unknown channel is a no-op rather than a throw: a producer
   * finishing after its turn was abandoned must not fail the turn. Display data
   * never changes execution outcomes.
   */
  publish(channelId: string, input: AgentTextStreamInput): number {
    const channel = this.channels.get(channelId)
    if (!channel || channel.closedAt !== undefined) return PUBLISH_IGNORED
    if (input.type === 'progress' && (channel.progress.get(input.replyId) === null ||
      (!channel.progress.has(input.replyId) && channel.progress.size >= MAX_PROGRESS_REPLY_IDENTITIES))) return PUBLISH_IGNORED

    if (input.producerSequence !== undefined) {
      const last = channel.lastProducerSequence.get(input.replyId)
      if (last !== undefined && input.producerSequence <= last) {
        return PUBLISH_IGNORED
      }
      const expected = last === undefined ? 0 : last + 1
      if (input.producerSequence > expected) {
        // The sender dropped frames. Record the hole before the frame that
        // revealed it, so the client can never splice across it. The range is
        // in producerSequence space: those frames never received cursors.
        this.append(channel, channelId, {
          type: 'gap',
          channelId,
          cursor: channel.nextCursor,
          replyId: input.replyId,
          missingProducerFrom: expected,
          missingProducerTo: input.producerSequence - 1,
        } satisfies AgentTextGapFrame)
      }
      channel.lastProducerSequence.set(input.replyId, input.producerSequence)
    }

    const cursor = channel.nextCursor
    if (input.type === 'progress') {
      channel.progress.set(input.replyId, input)
    }
    if ((input.type === 'final' || input.type === 'error') && channel.progress.has(input.replyId)) {
      channel.progress.set(input.replyId, null)
    }
    this.append(channel, channelId, { ...input, channelId, cursor })
    this.notify(channel)
    return cursor
  }

  read(channelId: string, fromCursor: number): AgentTextStreamPage | undefined {
    this.evictExpired()
    const channel = this.channels.get(channelId)
    if (!channel) return undefined

    const oldest = channel.frames[0]
    const retainedFromCursor = oldest ? oldest.cursor : channel.nextCursor
    const progressSnapshots = [...channel.progress.values()].filter(progress => progress !== null)
    return {
      ...(progressSnapshots.length > 0 ? { progressSnapshots } : {}),
      frames: channel.frames.filter((frame) => frame.cursor >= fromCursor),
      retainedFromCursor,
      nextCursor: channel.nextCursor,
      closed: channel.closedAt !== undefined,
    }
  }

  /**
   * Register a notifier. It carries no frames — a subscriber must call `read`.
   * Keeping the signal empty is what lets `publish` stay synchronous and
   * bounded regardless of how many subscribers exist or how slow they are.
   */
  subscribe(channelId: string, onNotify: AgentTextStreamNotifier): () => void {
    const channel = this.channels.get(channelId)
    if (!channel) return () => {}
    channel.subscribers.add(onNotify)
    return () => {
      channel.subscribers.delete(onNotify)
    }
  }

  closeChannel(channelId: string): void {
    const channel = this.channels.get(channelId)
    if (!channel || channel.closedAt !== undefined) return
    channel.closedAt = this.now()
    // Wake every pump so it can drain the tail and close its connection.
    this.notify(channel)
  }

  /**
   * The owner recorded at `openChannel`, or `undefined` for an unknown channel
   * or one opened without an owner. Callers addressed by owner must treat a
   * mismatch as "not found" rather than "forbidden", so an unguessable id is
   * not confirmed to exist.
   */
  ownerOf(channelId: string): string | undefined {
    this.evictExpired()
    return this.channels.get(channelId)?.ownerId
  }

  /**
   * Whether a channel is currently open.
   *
   * Used by replay classification: the user message is persisted before
   * generation begins, so an in-flight turn and a crashed one look identical in
   * the chat log. An open channel is what tells them apart.
   */
  isOpen(channelId: string): boolean {
    this.evictExpired()
    const channel = this.channels.get(channelId)
    return channel !== undefined && channel.closedAt === undefined
  }

  private append(
    channel: ChannelState,
    _channelId: string,
    frame: AgentTextStreamFrame,
  ): void {
    channel.frames.push(frame)
    channel.nextCursor = frame.cursor + 1
    if (channel.frames.length > this.ringCapacity) {
      channel.frames.splice(0, channel.frames.length - this.ringCapacity)
    }
  }

  private notify(channel: ChannelState): void {
    for (const subscriber of channel.subscribers) {
      try {
        subscriber()
      } catch {
        // A failing pump must not stop the producer or the other subscribers.
        // Observability never changes outcomes.
      }
    }
  }

  private evictExpired(): void {
    if (this.channels.size === 0) return
    const now = this.now()
    for (const [channelId, channel] of this.channels) {
      if (
        channel.closedAt !== undefined &&
        now - channel.closedAt > this.closedRetentionMs
      ) {
        this.channels.delete(channelId)
      }
    }
  }
}
