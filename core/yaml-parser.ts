/**
 * Minimal YAML Parser
 *
 * Handles the subset of YAML needed for team.yaml configs:
 * - Scalar values (strings, numbers, booleans)
 * - Nested objects (indent-based)
 * - Arrays (both `- item` and `- key: value` forms)
 * - Comments (# stripped)
 * - Multi-line strings (> and >- folded, | and |- literal)
 *
 * NOT a full YAML spec implementation. Does not support:
 * - Anchors/aliases, tags, multi-document, etc.
 * - Flow style except top-level scalar sequences ([a, b, c])
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlObject

/**
 * Raw (unfiltered) input lines for the current parseYaml() invocation.
 * Used by block-scalar collectors to preserve blank lines inside literal (|)
 * and folded (>) scalars — the global pre-filter drops blank lines, which would
 * otherwise alter multiline string content. parseYaml() is synchronous and not
 * reentrant, so a module-scoped variable is safe here.
 */
let RAW_LINES: string[] = []
export interface YamlObject { [key: string]: YamlValue }

interface ParsedLine {
  indent: number
  content: string
  lineNum: number
}

/**
 * Parse a YAML string into a JavaScript object.
 */
export function parseYaml(input: string): YamlObject {
  const lines = input.split('\n')
  RAW_LINES = lines
  const parsed: ParsedLine[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    // Strip inline comments (but not inside quoted strings)
    const content = stripComment(raw).trimEnd()
    if (content.trim() === '') continue
    const indent = content.length - content.trimStart().length
    parsed.push({ indent, content: content.trimStart(), lineNum: i + 1 })
  }

  const result: YamlObject = {}
  parseObject(parsed, 0, 0, result)
  return result
}

function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? ''
    // An escaped character inside double quotes (`\"`, `\\`) neither closes
    // the scalar nor starts a comment.
    if (ch === '\\' && inDouble) {
      i++
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === '#' && !inSingle && !inDouble) {
      // Only strip if preceded by whitespace or at start of line
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') {
        return line.slice(0, i)
      }
    }
  }
  return line
}

/**
 * Collect literal/folded block-scalar content directly from the raw input
 * lines so that blank lines inside the block are preserved.
 *
 * Returns the de-indented content lines (blank lines included as '') and the
 * index in the filtered `lines` array at which to resume parsing.
 */
function collectBlockScalarLines(
  lines: ParsedLine[],
  startIdx: number,
  minIndent: number,
): { parts: string[]; resumeIdx: number } {
  const parts: string[] = []
  let filteredIdx = startIdx
  // Start from the raw line right after the key line (lines[startIdx - 1]).
  // Block scalars are verbatim: a line that looks like a comment (# ...) is
  // content, so we cannot start from lines[startIdx] — the filtered array has
  // already dropped comment-only lines, which may sit at the top of the block.
  const keyLineNum = lines[startIdx - 1]?.lineNum ?? 0
  for (let rawIdx = keyLineNum; rawIdx < RAW_LINES.length; rawIdx++) {
    const raw = RAW_LINES[rawIdx] ?? ''
    const processed = raw.replace(/\s+$/, '')
    if (processed.trim() === '') {
      // Blank line inside the block — preserve it.
      parts.push('')
      continue
    }
    const indent = processed.length - processed.replace(/^\s+/, '').length
    if (indent > minIndent) {
      parts.push(processed.slice(indent))
      // Advance the filtered index only for lines that have an entry in the
      // filtered array — comment-only lines are verbatim block content, but
      // parseYaml() skips them when building `lines`.
      if (stripComment(raw).trim() !== '') filteredIdx++
      continue
    }
    break
  }
  // A final newline in the YAML document is not literal block content. Keep
  // interior blank lines, but avoid manufacturing a trailing newline solely
  // because the source file ends after the scalar.
  while (parts.at(-1) === '') parts.pop()
  return { parts, resumeIdx: filteredIdx }
}

/**
 * Fold a folded-scalar (> / >-) line list: consecutive non-blank lines join
 * with a single space; blank lines become newline separators.
 */
function foldBlock(parts: string[]): string {
  const segments: string[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length) {
      segments.push(run.join(' '))
      run = []
    }
  }
  for (const p of parts) {
    if (p === '') flush()
    else run.push(p)
  }
  flush()
  return segments.join('\n')
}

function lineAt(lines: readonly ParsedLine[], index: number): ParsedLine {
  const line = lines[index]
  if (!line) throw new Error(`Missing YAML line at index ${index}`)
  return line
}

/**
 * Parse lines into an object, starting from the given line index and indent level.
 * Returns the number of lines consumed.
 */
function parseObject(lines: ParsedLine[], startIdx: number, expectedIndent: number, target: YamlObject): number {
  let idx = startIdx

  while (idx < lines.length) {
    const line = lineAt(lines, idx)

    // Stop if we've de-indented past our level
    if (line.indent < expectedIndent) break

    // Skip lines at deeper indent (shouldn't happen if parsing correctly)
    if (line.indent > expectedIndent && idx > startIdx) break

    const content = line.content

    // Array item at this level: "- ..."
    if (content.startsWith('- ')) {
      // This shouldn't happen at the object level without a parent key
      // Skip it
      idx++
      continue
    }

    // Key-value or key-only
    const colonIdx = findTopLevelColon(content)
    if (colonIdx < 0) {
      idx++
      continue
    }

    const key = parseMappingKey(content.slice(0, colonIdx).trim())
    const valueStr = content.slice(colonIdx + 1).trim()

    if (valueStr === '' || valueStr === '>' || valueStr === '>-' || valueStr === '|' || valueStr === '|-') {
      // Check what follows: nested object, array, or multi-line string
      const nextIdx = idx + 1
      if (nextIdx >= lines.length) {
        target[key] = null
        idx++
        continue
      }

      const nextLine = lineAt(lines, nextIdx)

      if (valueStr === '>' || valueStr === '>-') {
        // Folded multi-line string: collect all lines at deeper indent
        const { parts, resumeIdx } = collectBlockScalarLines(lines, nextIdx, expectedIndent)
        target[key] = foldBlock(parts)
        idx = resumeIdx
        continue
      }

      if (valueStr === '|' || valueStr === '|-') {
        // Literal multi-line string
        const { parts, resumeIdx } = collectBlockScalarLines(lines, nextIdx, expectedIndent)
        target[key] = parts.join('\n')
        idx = resumeIdx
        continue
      }

      if (nextLine.indent <= expectedIndent) {
        // An array at the same indent as its key is a valid YAML indentless
        // sequence (e.g. "steps:\n- id: a"). Anything else at this level
        // means the key has no value.
        if (nextLine.indent === expectedIndent && nextLine.content.startsWith('- ')) {
          const arr: YamlValue[] = []
          const consumed = parseArray(lines, nextIdx, nextLine.indent, arr)
          target[key] = arr
          idx = nextIdx + consumed
        } else {
          target[key] = null
          idx++
        }
        continue
      }

      // Determine if next lines form an array or object
      if (nextLine.content.startsWith('- ')) {
        // Array
        const arr: YamlValue[] = []
        const consumed = parseArray(lines, nextIdx, nextLine.indent, arr)
        target[key] = arr
        idx = nextIdx + consumed
      } else {
        // Nested object
        const nested: YamlObject = {}
        const consumed = parseObject(lines, nextIdx, nextLine.indent, nested)
        target[key] = nested
        idx = nextIdx + consumed
      }
    } else {
      // Inline value
      target[key] = parseScalar(valueStr)
      idx++
    }
  }

  return idx - startIdx
}

/**
 * Parse lines into an array, starting from the given line index.
 * Returns the number of lines consumed.
 */
function parseArray(lines: ParsedLine[], startIdx: number, expectedIndent: number, target: YamlValue[]): number {
  let idx = startIdx

  while (idx < lines.length) {
    const line = lineAt(lines, idx)

    if (line.indent < expectedIndent) break
    if (line.indent > expectedIndent) {
      idx++
      continue
    }

    const content = line.content
    if (!content.startsWith('- ')) break

    const itemContent = content.slice(2).trim()

    // Check if this is a key-value item (object in array)
    const colonIdx = findTopLevelColon(itemContent)
    if (colonIdx > 0) {
      // Object item: "- key: value"
      const obj: YamlObject = {}
      const itemKey = parseMappingKey(itemContent.slice(0, colonIdx).trim())
      const itemVal = itemContent.slice(colonIdx + 1).trim()

      if (itemVal === '' || itemVal === '>' || itemVal === '>-' || itemVal === '|' || itemVal === '|-') {
        // Nested value under this array item key
        const nextIdx = idx + 1
        const nextLine = nextIdx < lines.length ? lineAt(lines, nextIdx) : undefined
        if (nextLine && nextLine.indent > expectedIndent) {
          if (itemVal === '>' || itemVal === '>-') {
            const { parts, resumeIdx } = collectBlockScalarLines(lines, nextIdx, expectedIndent)
            obj[itemKey] = foldBlock(parts)
            idx = resumeIdx
          } else if (itemVal === '|' || itemVal === '|-') {
            const { parts, resumeIdx } = collectBlockScalarLines(lines, nextIdx, expectedIndent)
            obj[itemKey] = parts.join('\n')
            idx = resumeIdx
          } else if (nextLine.content.startsWith('- ')) {
            const arr: YamlValue[] = []
            const consumed = parseArray(lines, nextIdx, nextLine.indent, arr)
            obj[itemKey] = arr
            idx = nextIdx + consumed
          } else {
            const nested: YamlObject = {}
            const consumed = parseObject(lines, nextIdx, nextLine.indent, nested)
            obj[itemKey] = nested
            idx = nextIdx + consumed
          }
        } else {
          obj[itemKey] = null
          idx++
        }
      } else {
        obj[itemKey] = parseScalar(itemVal)
        idx++
      }

      // Continue collecting sibling keys at deeper indent (multi-key object in array)
      while (idx < lines.length) {
        const nestedLine = lineAt(lines, idx)
        if (nestedLine.indent <= expectedIndent || nestedLine.content.startsWith('- ')) break
        const nestedColon = findTopLevelColon(nestedLine.content)
        if (nestedColon > 0) {
          const nKey = parseMappingKey(
            nestedLine.content.slice(0, nestedColon).trim(),
          )
          const nVal = nestedLine.content.slice(nestedColon + 1).trim()

          if (nVal === '' || nVal === '>' || nVal === '>-' || nVal === '|' || nVal === '|-') {
            const nextIdx2 = idx + 1
            const nextLine = nextIdx2 < lines.length ? lineAt(lines, nextIdx2) : undefined
            if (nextLine && nextLine.indent > nestedLine.indent) {
              if (nVal === '>' || nVal === '>-') {
                const { parts, resumeIdx } = collectBlockScalarLines(lines, nextIdx2, nestedLine.indent)
                obj[nKey] = foldBlock(parts)
                idx = resumeIdx
              } else if (nVal === '|' || nVal === '|-') {
                const { parts, resumeIdx } = collectBlockScalarLines(lines, nextIdx2, nestedLine.indent)
                obj[nKey] = parts.join('\n')
                idx = resumeIdx
              } else if (nextLine.content.startsWith('- ')) {
                const arr: YamlValue[] = []
                const consumed = parseArray(lines, nextIdx2, nextLine.indent, arr)
                obj[nKey] = arr
                idx = nextIdx2 + consumed
              } else {
                const nested: YamlObject = {}
                const consumed = parseObject(lines, nextIdx2, nextLine.indent, nested)
                obj[nKey] = nested
                idx = nextIdx2 + consumed
              }
            } else {
              obj[nKey] = null
              idx++
            }
          } else {
            obj[nKey] = parseScalar(nVal)
            idx++
          }
        } else {
          idx++
        }
      }

      target.push(obj)
    } else {
      // Simple scalar item: "- value"
      target.push(parseScalar(itemContent))
      idx++
    }
  }

  return idx - startIdx
}

/**
 * Find the first colon that's not inside quotes.
 * Returns -1 if not found.
 */
function findTopLevelColon(str: string): number {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '\\' && inDouble) {
      i++
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === ':' && !inSingle && !inDouble) {
      // Must be followed by whitespace or end of string to be a key separator
      if (i + 1 >= str.length || str[i + 1] === ' ' || str[i + 1] === '\t') {
        return i
      }
    }
  }
  return -1
}

/**
 * The key of a `key: value` line, decoded exactly as this parser decodes it,
 * and the index of the colon that ends it; null when the line has no key.
 *
 * For text editors that locate keys in YAML they rewrite: matching keys with
 * their own pattern let a spelling the parser reads (a quoted key, a space
 * before the colon, an escape inside double quotes) slip past the editor.
 */
export function readMappingKey(content: string): { key: string; colonIndex: number } | null {
  const colonIndex = findTopLevelColon(content)
  if (colonIndex < 0) return null
  return { key: parseMappingKey(content.slice(0, colonIndex).trim()), colonIndex }
}

function parseMappingKey(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value)
      return typeof decoded === 'string' ? decoded : value
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

/**
 * Split the inside of a flow sequence (`a, b, 'c, d'`) into item strings.
 * Quote- and nesting-aware at the top level. Returns null when the content is
 * unbalanced (unclosed quote/bracket) so callers can fall back to a plain
 * string instead of misparsing.
 */
function splitFlowItems(inner: string): string[] | null {
  const items: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let depth = 0
  let escaped = false
  for (const ch of inner) {
    if (escaped) escaped = false
    else if (ch === '\\' && inDouble) escaped = true
    else if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') depth--
      else if (ch === ',' && depth === 0) {
        items.push(current.trim())
        current = ''
        continue
      }
    }
    current += ch
  }
  if (inSingle || inDouble || depth !== 0) return null
  items.push(current.trim())
  return items.filter((item) => item !== '')
}

/**
 * Parse a scalar value string into the appropriate JS type.
 */
function parseScalar(value: string): YamlValue {
  if (value === '' || value === 'null' || value === '~') return null
  if (value === '[]') return []
  if (value === '{}') return {}

  // Boolean
  const lower = value.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false

  // Remove surrounding quotes
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
  if (value.startsWith('"') && value.endsWith('"')) return decodeDoubleQuoted(value.slice(1, -1))

  // Flow sequence: [read, bash] — a natural authoring style for string lists.
  // Unbalanced content falls through and stays a plain string.
  if (value.startsWith('[') && value.endsWith(']')) {
    const items = splitFlowItems(value.slice(1, -1))
    if (items) return items.map(parseScalar)
  }

  // Number
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)

  return value
}

/** What each one-character escape in a double-quoted scalar stands for. */
const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * The text between a double-quoted scalar's quotes, with its escapes decoded.
 *
 * The set is JSON's, because the app writes double-quoted scalars with
 * `JSON.stringify` (`yamlQuoted`): these are every escape it emits, and YAML
 * reads each of them the same way. Any other backslash sequence is kept as
 * written, backslash included: a YAML-only escape such as `\x41` or
 * `\U0001F600`, a `\u` without four hex digits, or a trailing backslash.
 */
export function decodeDoubleQuoted(inner: string): string {
  return inner.replace(/\\(u[0-9A-Fa-f]{4}|["\\/bfnrt])/g, (_sequence, escape: string) =>
    escape.length === 5
      ? String.fromCharCode(Number.parseInt(escape.slice(1), 16))
      : DOUBLE_QUOTED_ESCAPES[escape] ?? escape,
  )
}
