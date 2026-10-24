/**
 * Shared Server-Sent Events frame reader for providers.
 *
 * Lifted from the LM Studio provider so every streaming provider added in
 * Phase 2 frames its transport identically instead of re-implementing the two
 * things that are easy to get wrong: CRLF normalization, and holding back an
 * unterminated trailing frame until the rest of it arrives.
 *
 * `readSseData` deliberately hands back `unknown`. Inbound bytes are untrusted,
 * so a caller must narrow into a freshly constructed typed value rather than
 * asserting a shape onto the raw object.
 */

export interface SseFrameSplit {
  /** Complete frames, blank ones dropped. */
  readonly events: readonly string[]
  /** The unterminated tail, to be prepended to the next chunk. */
  readonly remainder: string
}

export function extractSseFrames(buffer: string): SseFrameSplit {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  return {
    events: parts.slice(0, -1).filter((part) => part.trim().length > 0),
    remainder: parts.at(-1) ?? '',
  }
}

/**
 * What a frame's `data:` lines turned out to be.
 *
 * The three outcomes are kept apart because they mean different things to a
 * reader. `absent` is a comment, a `ping`, or a bare `event:` line — routine
 * traffic to skip. `malformed` is a frame that carried a payload nobody can
 * read, which for a text stream means answer text was lost and the turn must
 * fail rather than return short. `json` is the only case with a value, and that
 * value is `unknown`: narrowing is the caller's job.
 */
export type SseData =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed'; readonly raw: string }
  | { readonly kind: 'json'; readonly raw: string; readonly value: unknown }

/**
 * Decode a frame's `data:` payload without deciding what a failure means.
 *
 * Sentinels such as chat completions' `[DONE]` are not valid JSON and surface
 * as `malformed` with their `raw` text intact, because only the protocol's own
 * reader knows whether a given non-JSON payload is a terminator or a fault.
 */
export function readSseData(frame: string): SseData {
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }
  if (dataLines.length === 0) return { kind: 'absent' }

  const raw = dataLines.join('\n')
  try {
    return { kind: 'json', raw, value: JSON.parse(raw) }
  } catch {
    return { kind: 'malformed', raw }
  }
}

/**
 * Decode a frame's `data:` payload, returning `undefined` for a frame with no
 * data line and for unreadable JSON alike.
 *
 * Kept for callers that genuinely cannot distinguish the two — anything that
 * must tell a lost payload from routine traffic should use `readSseData`.
 */
export function parseSseData(frame: string): unknown {
  const data = readSseData(frame)
  return data.kind === 'json' ? data.value : undefined
}
