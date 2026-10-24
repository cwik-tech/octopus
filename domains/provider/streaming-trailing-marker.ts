/**
 * Keep an internal control marker out of a live preview.
 *
 * One architect ends an approval reply with a marker line the client acts on
 * and the saved message never contains. Streaming raw suffixes would put that
 * marker on screen for a moment and then take it away — showing the user
 * machinery they are not meant to see, and making the preview disagree with
 * what is stored a second later.
 *
 * The marker only means anything as the reply's final line, so text that
 * merely resembles it is left alone. What is withheld is the shortest suffix
 * that could still grow into a trailing marker; the moment it cannot, it is
 * released. Nothing is dropped that the saved message would have kept.
 */

export interface TrailingMarkerSuppressor {
  /** Feed the next raw suffix; returns what is safe to show. */
  push(chunk: string): string
  /**
   * End the reply and release anything still held.
   *
   * Held text was only held because it might still have grown into the
   * marker. Once the reply is over it cannot, so keeping it would lose real
   * text — a reply that genuinely ends in `[` must still show that `[`. A
   * complete trailing marker stays suppressed. Safe to call twice.
   */
  finish(): string
}

export function createTrailingMarkerSuppressor(
  marker: string,
): TrailingMarkerSuppressor {
  let held = ''

  return {
    push(chunk: string): string {
      held += chunk

      // Release everything except a tail that could still become the marker.
      // Only the longest such tail matters: a shorter one would release
      // characters the marker may yet need.
      let keep = 0
      const maxTail = Math.min(held.length, marker.length)
      for (let length = maxTail; length > 0; length -= 1) {
        const tail = held.slice(held.length - length)
        if (marker.startsWith(tail)) {
          keep = length
          break
        }
      }

      // A complete marker at the very end is the control signal, and is
      // dropped along with the whitespace that separated it from the reply.
      if (keep === marker.length) {
        const body = held.slice(0, held.length - marker.length)
        held = marker
        return body
      }

      const released = held.slice(0, held.length - keep)
      held = held.slice(held.length - keep)
      return released
    },
    finish(): string {
      if (held === marker) {
        held = ''
        return ''
      }
      const remaining = held
      held = ''
      return remaining
    },
  }
}
