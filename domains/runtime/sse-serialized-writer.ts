/**
 * One serialized writer per SSE connection.
 *
 * Every byte a connection emits — the `: connected` prelude, keep-alives, the
 * `reset` control and frames — goes through here, because backpressure is a
 * property of the socket, not of any one producer.
 *
 * A flag on the pump cannot enforce this. A heartbeat written while the pump is
 * idle can itself return false, and a publish arriving before that heartbeat
 * drains would start a frame write concurrently: two writers, one socket,
 * interleaved bytes. Ordering the writes in a single chain is what makes "one
 * outstanding write per connection" true rather than merely intended.
 */

export type SseRawWrite = (payload: string) => Promise<void>

export interface SerializedSseWriter {
  /** Queue `payload`. Resolves when it has been accepted by the socket. */
  write(payload: string): Promise<void>
  /** False while anything is queued or draining. Lets a heartbeat skip itself. */
  readonly idle: boolean
}

export function createSerializedSseWriter(
  writeRaw: SseRawWrite,
): SerializedSseWriter {
  let tail: Promise<void> = Promise.resolve()
  let queued = 0

  return {
    write(payload: string): Promise<void> {
      queued += 1
      const next = tail.then(() => writeRaw(payload))
      // The chain must survive a rejection, or one closed socket would stall
      // every later write behind a permanently rejected link. The caller still
      // sees the rejection through `next`.
      tail = next.then(
        () => undefined,
        () => undefined,
      )
      return next.finally(() => {
        queued -= 1
      })
    },
    get idle(): boolean {
      return queued === 0
    },
  }
}
