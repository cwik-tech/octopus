/**
 * Line and scalar helpers for editing `team.yaml` as text, `joinLabels`,
 * which joins names into the text of a message, and `STAGE_MEMBERSHIP_KEY`,
 * the list field each stage type reads as its membership.
 *
 * A leaf module: it imports nothing from this folder, so any `team.yaml`
 * text module can use it without importing `team-manager.ts`.
 */

import { decodeDoubleQuoted, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'

export function indentWidth(line: string): number {
  return (line.match(/^\s*/u) ?? [''])[0].length
}

export function stripInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '\\' && inDouble) index++
    else if (character === "'" && !inDouble) inSingle = !inSingle
    else if (character === '"' && !inSingle) inDouble = !inDouble
    else if (character === '#' && !inSingle && !inDouble) {
      const previous = value[index - 1]
      if (index === 0 || previous === ' ' || previous === '\t') return value.slice(0, index)
    }
  }
  return value
}

export function unquoteScalar(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed.at(-1)
  if (trimmed.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    // Decoded the way `parseYaml` decodes it, so a name or path located here
    // compares equal to the value the parser reads from the same line.
    const inner = trimmed.slice(1, -1)
    return first === '"' ? decodeDoubleQuoted(inner) : inner
  }
  return trimmed
}

export function topLevelKey(line: string): string | null {
  const match = line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/)
  return match?.[1] ?? null
}

export function parseStringList(value: YamlValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.map(String).map((item) => item.trim()).filter(Boolean)
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function yamlQuoted(value: string): string {
  return JSON.stringify(value)
}

export function isObject(value: unknown): value is YamlObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function findTopLevelBlock(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => topLevelKey(line) === key)
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    if (line.trim() === '' || line.startsWith('#')) continue
    if (/^\S/.test(line)) {
      end = i
      break
    }
  }
  return { start, end }
}

export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1) ?? ''}`
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

/**
 * The one list field each stage type reads as its membership.
 *
 * The name alone does not make a key a roster: `parseChainStage` reads
 * `sequence` and never a direct `participants`, `parseBroadcastStage` reads
 * `fan_out` and never `sequence`. A key of the wrong name for its stage type is
 * inert configuration the parser ignores, so this table's readers must ignore it too.
 * Routing and review name their agents singly, not in a list, and are absent
 * here on purpose.
 */
export const STAGE_MEMBERSHIP_KEY: Record<string, string> = {
  discussion: 'participants',
  chain: 'sequence',
  broadcast: 'fan_out',
  pipeline: 'participants',
}
