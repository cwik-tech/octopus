/**
 * Sequential delivery pump for one agent-text-stream subscriber.
 *
 * ADR: `docs/adr/2026-08-22-Ephemeral-Agent-Text-Stream.md`, §6.5 of the
 * implementation plan.
 *
 * The hub never writes to a socket. It cannot: `writeSseEvent` resolves on
 * `drain`, so awaiting a write inside `publish` would couple model generation
 * to renderer and socket speed, while not awaiting it would produce unbounded
 * concurrent writes that can resolve out of order.
 *
 * So delivery lives here, one connection at a time:
 *   - at most one outstanding `write`, ever;
 *   - notifications arriving mid-drain set a dirty flag rather than starting a
 *     second loop;
 *   - no per-subscriber queue, so a stalled connection cannot grow memory. It
 *     simply stops consuming and its read position ages out of the ring.
 *
 * A connection whose position has been evicted gets a `reset` prelude with no
 * SSE id, which leaves the client's last-event-id untouched and keeps ids
 * strictly monotonic. A ring-member frame could not do that: it would need a
 * cursor above the range it warns about, yet must arrive before the retained
 * frames.
 */

import type {
  AgentTextResetControl,
  AgentTextStreamDelivery,
} from '../../contracts/agent-text-stream.js'
import type { AgentTextStreamHub } from './agent-text-stream-hub.js'

/**
 * Writes one delivery. `id` is the SSE `id:` to emit, and is `undefined` for
 * the `reset` prelude — the one delivery that must not advance the client's
 * resume cursor.
 */
export type AgentTextStreamWrite = (
  delivery: AgentTextStreamDelivery,
  id: number | undefined,
) => Promise<void>

export interface AgentTextStreamPumpOptions {
  readonly hub: AgentTextStreamHub
  readonly channelId: string
  readonly fromCursor: number
  readonly write: AgentTextStreamWrite
}

export interface AgentTextStreamPump {
  /** Stop delivering and release the subscription. Idempotent. */
  stop(): void
  readonly stopped: boolean
  /**
   * True while a `write` is outstanding.
   *
   * Nothing else may touch the socket while this is true. A heartbeat written
   * from a timer would interleave with a frame that is still draining, and
   * would keep buffering on a connection that is already backpressured — which
   * is exactly the unbounded growth the single-flight pump exists to prevent.
   */
  readonly busy: boolean
  /** Resolves once the pump has stopped, for whatever reason. */
  readonly done: Promise<void>
}

export function startAgentTextStreamPump(
  options: AgentTextStreamPumpOptions,
): AgentTextStreamPump {
  const { hub, channelId, fromCursor, write } = options

  let cursor = fromCursor
  let stopped = false
  let writing = false
  let draining = false
  let dirty = false
  let snapshotsSent = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const finish = (): void => {
    if (stopped) return
    stopped = true
    unsubscribe()
    resolveDone()
  }

  const drain = async (): Promise<void> => {
    if (draining) {
      // A notification during a write must not start a second loop; one
      // outstanding write per connection is the whole point.
      dirty = true
      return
    }
    draining = true
    try {
      do {
        dirty = false
        while (!stopped) {
          const page = hub.read(channelId, cursor)
          if (!page) {
            finish()
            return
          }

          if (page.retainedFromCursor > cursor) {
            const reset: AgentTextResetControl = {
              type: 'reset',
              channelId,
              requestedFromCursor: cursor,
              retainedFromCursor: page.retainedFromCursor,
              reason: 'evicted',
            }
            cursor = page.retainedFromCursor
            // The reader drops progress on a reset, because a terminal may have
            // been evicted. Snapshots then restore only replies still running.
            snapshotsSent = false
            writing = true
            try {
              await write(reset, undefined)
            } finally {
              writing = false
            }
            if (stopped) return
            continue
          }

          if (!snapshotsSent) {
            snapshotsSent = true
            for (const snapshot of page.progressSnapshots ?? []) {
              writing = true
              try {
                await write({ type: 'progress-snapshot', channelId, replyId: snapshot.replyId, progress: snapshot.progress }, undefined)
              } finally { writing = false }
              if (stopped) return
            }
            continue
          }
          const frame = page.frames[0]
          if (!frame) {
            if (page.closed) {
              finish()
              return
            }
            break
          }

          writing = true
          try {
            await write(frame, frame.cursor)
          } finally {
            writing = false
          }
          if (stopped) return
          cursor = frame.cursor + 1
        }
      } while (dirty && !stopped)
    } catch {
      // A rejected write means the socket is gone. Stop rather than loop.
      finish()
    } finally {
      draining = false
    }
  }

  const unsubscribe = hub.subscribe(channelId, () => {
    void drain()
  })

  void drain()

  return {
    stop: finish,
    get stopped() {
      return stopped
    },
    get busy() {
      return writing && !stopped
    },
    done,
  }
}
