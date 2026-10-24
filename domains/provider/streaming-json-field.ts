/**
 * Read one named string field out of JSON that is still arriving.
 *
 * Two architects are required to answer with a single JSON object whose
 * visible reply sits under `message`; the rest of the object is the structured
 * part of the turn. Streaming the model's raw tokens would therefore put a
 * growing JSON blob on screen. This reader emits the decoded value of that one
 * field and nothing else, so a preview shows prose from its first character
 * and never leaks a brace, a key name, or a draft.
 *
 * It is deliberately not a JSON parser. It tracks only what it needs to know
 * where it is — string boundaries, escape state and object depth — so that a
 * same-named key nested one level down, or the field's name appearing inside
 * an earlier value, cannot be mistaken for the reply.
 *
 * The finished text remains the authority. Anything this reader cannot decode
 * it simply does not emit; the validated response still arrives.
 */

export interface StreamingJsonFieldReader {
  /**
   * Feed the next raw suffix. Returns the decoded suffix of the tracked field,
   * or an empty string when this chunk contained none of it.
   */
  push(chunk: string): string
}

type Phase =
  | 'scanning'
  /** Inside some other string; its content cannot be the reply. */
  | 'skipping-string'
  /** The key just closed; waiting for `:`. */
  | 'awaiting-colon'
  /** The colon arrived; waiting for the value's opening quote. */
  | 'awaiting-value'
  /** Inside the tracked field's value. */
  | 'reading'
  /** The field closed. Nothing further is ever emitted. */
  | 'done'

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

export function createStreamingJsonFieldReader(
  fieldName: string,
): StreamingJsonFieldReader {
  let phase: Phase = 'scanning'
  let depth = 0
  /** The string currently being skipped, kept only to compare against the key. */
  let candidateKey = ''
  /** True when the next character is the body of a `\` escape. */
  let escaped = false
  /** Partial `\uXXXX` digits held across a chunk boundary. */
  let unicodeDigits: string | undefined
  /** A high surrogate waiting for its pair, so a lone half is never emitted. */
  let pendingHighSurrogate: string | undefined

  // Read through a call so the compiler does not narrow `phase` past the
  // assignments the helpers below make to it.
  const finished = (): boolean => phase === 'done'

  const readValueCharacter = (character: string, out: string[]): void => {
    if (unicodeDigits !== undefined) {
      unicodeDigits += character
      if (unicodeDigits.length < 4) return
      const code = Number.parseInt(unicodeDigits, 16)
      unicodeDigits = undefined
      if (!Number.isFinite(code)) return
      const decoded = String.fromCharCode(code)
      if (code >= 0xd800 && code <= 0xdbff) {
        // Hold the high half: emitting it alone would hand the UI half a
        // character, which renders as a replacement glyph rather than a
        // preview of the answer.
        pendingHighSurrogate = decoded
        return
      }
      if (pendingHighSurrogate !== undefined) {
        out.push(pendingHighSurrogate + decoded)
        pendingHighSurrogate = undefined
        return
      }
      out.push(decoded)
      return
    }

    if (escaped) {
      escaped = false
      if (character === 'u') {
        unicodeDigits = ''
        return
      }
      const simple = SIMPLE_ESCAPES[character]
      // An escape JSON does not define is dropped rather than guessed at.
      if (simple !== undefined) out.push(simple)
      return
    }

    if (character === '\\') {
      escaped = true
      return
    }
    if (character === '"') {
      phase = 'done'
      return
    }
    out.push(character)
  }

  return {
    push(chunk: string): string {
      if (finished() || chunk === '') return ''
      const out: string[] = []

      for (const character of chunk) {
        if (finished()) break

        if (phase === 'reading') {
          readValueCharacter(character, out)
          continue
        }

        if (phase === 'skipping-string') {
          if (escaped) {
            escaped = false
            candidateKey += character
            continue
          }
          if (character === '\\') {
            escaped = true
            continue
          }
          if (character === '"') {
            phase =
              depth === 1 && candidateKey === fieldName
                ? 'awaiting-colon'
                : 'scanning'
            candidateKey = ''
            continue
          }
          candidateKey += character
          continue
        }

        if (character === '"') {
          if (phase === 'awaiting-value') {
            phase = 'reading'
            continue
          }
          // Any other string is either a key or a value that is not the reply.
          // Both are skipped, but only a key at depth 1 can match.
          phase = 'skipping-string'
          candidateKey = ''
          continue
        }

        if (phase === 'awaiting-colon') {
          if (character === ':') phase = 'awaiting-value'
          else if (!isJsonWhitespace(character)) phase = 'scanning'
          continue
        }

        if (phase === 'awaiting-value') {
          // The key matched but its value is not a string — a number, `null`,
          // an object. There is no prose to preview, so stop looking.
          if (!isJsonWhitespace(character)) phase = 'scanning'
          continue
        }

        if (character === '{' || character === '[') depth += 1
        else if (character === '}' || character === ']') depth -= 1
      }

      // A trailing backslash or a half-read `\u` escape simply stays in
      // `escaped` / `unicodeDigits` and resumes on the next chunk, so a split
      // escape is never emitted as its own characters.
      return out.join('')
    },
  }
}

function isJsonWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\n' ||
    character === '\r' ||
    character === '\t'
  )
}
