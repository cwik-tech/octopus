/**
 * Post a run child's display frames to the parent, without ever getting in
 * the way of the run.
 *
 * This lives in a detached process, on the model's hot path, and everything
 * about it follows from that. `send` returns immediately and never rejects, so
 * a display concern cannot slow or fail generation. At most one request is
 * open at a time, so a slow parent cannot make the child accumulate sockets.
 * The backlog is capped in bytes, so a parent that stops answering cannot make
 * the child spend memory.
 *
 * When the cap is reached the oldest frames go, not the newest: a preview that
 * falls further and further behind is worse than one that skips. Dropping
 * advances nothing on its own — the surviving frames keep their own
 * `producerSequence`, so the hub sees the jump and reports a `gap` rather than
 * splicing text across the hole. That is the point of the cap being honest
 * about loss instead of quietly truncating.
 */
import type { AgentTextStreamInput } from '../../contracts/agent-text-stream.js'

/** Small enough to feel live, large enough not to send one frame at a time. */
const DEFAULT_FLUSH_INTERVAL_MS = 100
/** A busy turn should not wait out the timer to show what it already has. */
const DEFAULT_BATCH_FLUSH_BYTES = 2 * 1024
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/**
 * How long a close waits for what is already moving.
 *
 * Bounded independently of the request timeout, because a transport is free to
 * ignore an abort signal and a turn must be able to end regardless.
 */
const DEFAULT_TERMINAL_FLUSH_TIMEOUT_MS = 2_000

export interface AgentTextDeltaSender {
  /** Enqueue a frame. Returns immediately; never throws. */
  send(frame: AgentTextStreamInput): void
  /**
   * Deliver what is queued, then return. Bounded by the same terminal deadline
   * as `close`, and never throws.
   *
   * This is the only way a producer can order its frames against something
   * outside this channel. The durable record of a dispatch ending travels a
   * different road and is not batched, so without a barrier here it can
   * overtake the text it belongs to — and a renderer that learns an attempt
   * finished has already replaced the bubble that text was going into.
   */
  flush(): Promise<void>
  /** Flush once, then stop. Safe to call twice. */
  close(): Promise<void>
}

export interface AgentTextDeltaSenderOptions {
  readonly url: string
  readonly channelId: string
  readonly token: string
  /** Injected so a test can settle each request itself. */
  readonly send: (url: string, init: RequestInit) => Promise<Response>
  readonly flushIntervalMs?: number
  readonly batchFlushBytes?: number
  readonly maxPendingBytes?: number
  readonly terminalFlushTimeoutMs?: number
  readonly signal?: AbortSignal
}

export function createAgentTextDeltaSender(
  options: AgentTextDeltaSenderOptions,
): AgentTextDeltaSender {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const batchFlushBytes = options.batchFlushBytes ?? DEFAULT_BATCH_FLUSH_BYTES
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
  const terminalFlushTimeoutMs =
    options.terminalFlushTimeoutMs ?? DEFAULT_TERMINAL_FLUSH_TIMEOUT_MS

  let pending: AgentTextStreamInput[] = []
  let pendingBytes = 0
  let inFlight = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // A set rather than one slot: several dispatches share a channel, so more
  // than one barrier can be waiting on the same quiet moment. A single slot
  // would let a later waiter overwrite an earlier one and leave it to time out.
  const idleWaiters = new Set<() => void>()
  let closing: Promise<void> | undefined

  const notifyIdle = (): void => {
    if (idleWaiters.size === 0) return
    for (const waiter of [...idleWaiters]) waiter()
  }

  /** Resolve once nothing is queued or in flight, or on the deadline. */
  const awaitIdle = (): Promise<void> => {
    if (!inFlight && pending.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(deadline)
        idleWaiters.delete(finish)
        resolve()
      }
      const deadline = setTimeout(finish, terminalFlushTimeoutMs)
      idleWaiters.add(finish)
    })
  }

  // Bytes, not characters. A budget counted in UTF-16 units understates every
  // multibyte frame, so the real memory held would exceed the stated bound by
  // whatever the text happens to contain.
  const frameBytes = (frame: AgentTextStreamInput): number =>
    Buffer.byteLength(JSON.stringify(frame), 'utf8')

  const trimToCap = (): void => {
    // Drop from the front. The frames that survive keep their own sequence
    // numbers, so the hole is visible to the hub instead of being papered over.
    // The last frame is not spared: one frame larger than the whole budget
    // would break the bound this cap exists to state, and the parent would
    // refuse it anyway.
    while (pendingBytes > maxPendingBytes && pending.length > 0) {
      const dropped = pending.shift()
      if (!dropped) break
      pendingBytes -= frameBytes(dropped)
    }
  }

  const flush = (): void => {
    if (inFlight || pending.length === 0) {
      if (!inFlight && pending.length === 0) notifyIdle()
      return
    }
    const batch = pending
    pending = []
    pendingBytes = 0
    inFlight = true

    const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)
    const signal = options.signal
      ? AbortSignal.any([timeout, options.signal])
      : timeout

    void options
      .send(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The credential is a header, never part of the address: a URL
          // reaches access logs and error text, and this one would still work
          // from there.
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ channelId: options.channelId, frames: batch }),
        signal,
      })
      .catch(() => {
        // Dropped, never retried. A resend would splice an old suffix into a
        // bubble that has already moved on, and the durable record is still
        // coming either way.
      })
      .finally(() => {
        inFlight = false
        // A waiting barrier is why this does not sit out the timer: a producer
        // asking to be told when the channel is quiet should not be made to
        // wait for a batch that could go now.
        if (pending.length > 0 && !closed && idleWaiters.size === 0) schedule()
        else if (pending.length > 0) flush()
        else notifyIdle()
      })
  }

  const schedule = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, flushIntervalMs)
    timer.unref?.()
  }

  return {
    send(frame) {
      if (closed) return
      pending.push(frame)
      pendingBytes += frameBytes(frame)
      if (pendingBytes > maxPendingBytes) trimToCap()
      // A batch that is already worth sending goes now. Waiting out the timer
      // would hold text the user could be reading.
      if (pendingBytes >= batchFlushBytes) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        flush()
        return
      }
      schedule()
    },
    flush() {
      if (closed) return closing ?? Promise.resolve()
      // Send now rather than waiting out the coalescing timer: the caller is
      // asking to be ordered against something, so the delay that makes
      // batching worthwhile is exactly what has to be skipped here.
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      flush()
      return awaitIdle()
    },
    close() {
      // Repeated closes await the one close, rather than each starting another
      // terminal flush and sending the same frames twice.
      if (closing) return closing
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // One last flush so a turn's final frame is not lost to a timer that
      // never fired, then wait only for what is already moving — and only for
      // as long as a turn can afford. A transport is free to ignore its abort
      // signal, so the deadline here is what actually ends the turn.
      flush()
      closing = awaitIdle()
      return closing
    },
  }
}
