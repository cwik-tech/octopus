/**
 * Removes one member from `team.yaml`, edited as text.
 *
 * `removeRosterEntry` deletes the member's roster entry and
 * `pruneAgentFromStageLists` deletes the member from each stage membership
 * list. Both take and return `team.yaml` text and do no I/O. The caller in
 * `team-manager.ts` keeps the lock, the reference checks, validation and the
 * write. `STAGE_MEMBERSHIP_KEY`, which this module and the caller's checks
 * read, is in `team-yaml-scalars.ts`. This
 * module does not import `team-manager.ts`.
 */

import { parseYaml, readMappingKey } from '../../core/yaml-parser.js'
import { collectRosterEntrySpans, findBlockRange } from './team-yaml-ownership.js'
import {
  STAGE_MEMBERSHIP_KEY,
  isObject,
  stringOrUndefined,
  stripInlineComment,
  unquoteScalar,
} from './team-yaml-scalars.js'

/**
 * Delete one roster entry from the `agents:` block, byte for byte.
 *
 * The block is edited as text rather than re-emitted from a roster model,
 * which would carry only the fields the Create UI edits. Re-rendering it to drop one
 * member would also silently drop every field it does not model — `on_failure`,
 * `mount`, `color`, `experience_file`, `provider_config`, and a team-type
 * entry's `team_path`, `input_artifact` and `output_artifact` — from the
 * members that stay.
 */
export function removeRosterEntry(yaml: string, agentName: string): string {
  const lines = yaml.split('\n')
  const range = findBlockRange(lines, 'agents')
  if (!range) return yaml

  const entries = collectRosterEntrySpans(lines, range)
  const target = entries.find((entry) => entry.name === agentName)
  if (!target) return yaml
  if (entries.length === 1) {
    // Only the entry's own span goes; anything after it in the block stays.
    return [
      ...lines.slice(0, range.start),
      'agents: []',
      ...lines.slice(target.end),
    ].join('\n')
  }
  return [...lines.slice(0, target.start), ...lines.slice(target.end)].join('\n')
}

/**
 * Drop `agentName` from every list-based stage membership under `levels:`.
 *
 * Edited as text rather than re-emitted from the parsed document: levels are
 * hand-authored, and re-rendering them would rewrite stage settings this module
 * does not model.
 *
 * A key is a stage membership only where it sits structurally: a direct child
 * of a `stage:` mapping. Matching the name alone would rewrite any nested
 * `participants`, `sequence`, or `fan_out` a level happens to carry — inside a
 * stage's `config`, or under a level's `permissions` — which are not rosters
 * and not this operation's business.
 */
export function pruneAgentFromStageLists(yaml: string, agentName: string): string {
  const lines = yaml.split('\n')
  const range = findBlockRange(lines, 'levels')
  if (!range) return yaml

  // The parser is the authority on what each level's stage is; the text scan
  // only decides which lines that stage occupies. Levels keep document order in
  // both, so the Nth level item in the text is `levels[N]` here.
  const parsedLevels = parseYaml(yaml).levels
  const stageTypes = (Array.isArray(parsedLevels) ? parsedLevels.filter(isObject) : []).map(
    (level) => {
      const stage = isObject(level.stage) ? level.stage : undefined
      return stage ? stringOrUndefined(stage.type) ?? 'discussion' : undefined
    },
  )

  const rewritten: string[] = []
  let index = range.start
  let levelItemIndent: number | undefined
  let levelIndex = -1
  let levelNestedIndent: number | undefined
  let stageKeyIndent: number | undefined
  let stageChildIndent: number | undefined
  while (index < range.end) {
    const line = lines[index] ?? ''
    const content = line.trimStart()
    if (content === '' || content.startsWith('#')) {
      rewritten.push(line)
      index++
      continue
    }

    // A `- ` item opens a mapping whose own keys sit two columns further in,
    // so `- id: draft` states a key at the same depth as a following `stage:`.
    const isItem = content.startsWith('- ')
    const itemIndent = line.length - content.length
    if (isItem) {
      if (levelItemIndent === undefined) levelItemIndent = itemIndent
      if (itemIndent === levelItemIndent) {
        levelIndex++
        levelNestedIndent = undefined
        stageKeyIndent = undefined
        stageChildIndent = undefined
      }
    }
    const keyIndent = itemIndent + (isItem ? 2 : 0)
    const keyText = isItem ? content.slice(2) : content
    // The key as the parser reads it, whatever its spelling: bare, quoted,
    // with spaces before the colon, or with an escape inside double quotes. A
    // spelling this scan missed left the member on a list the parser still read.
    const mapping = readMappingKey(keyText)
    const key = mapping?.key
    // Up to and including the colon, and the key exactly as written.
    const keyLength = mapping ? mapping.colonIndex + 1 : 0
    const writtenKey = mapping ? keyText.slice(0, mapping.colonIndex) : ''

    // Which keys belong to the level itself, rather than to something nested
    // inside one of them. The parser accepts a level's own keys at any depth
    // past its `- `, so their column is read from the document instead of
    // assumed: `levelNestedIndent` marks where the block a level key opened
    // begins, and everything from there in belongs to that key, not the level.
    const isLevelKey =
      key !== undefined &&
      levelIndex >= 0 &&
      keyIndent > (levelItemIndent ?? 0) &&
      (levelNestedIndent === undefined || keyIndent < levelNestedIndent)
    if (isLevelKey) {
      const opensBlock =
        stripInlineComment(keyText.slice(keyLength)).trim() === ''
      levelNestedIndent = opensBlock ? keyIndent + 1 : undefined
    }

    if (key === 'stage' && isLevelKey) {
      stageKeyIndent = keyIndent
      stageChildIndent = undefined
    } else if (
      key !== undefined &&
      stageKeyIndent !== undefined &&
      keyIndent <= stageKeyIndent
    ) {
      // A sibling of `stage:`, or a key of the next level: the stage is closed.
      stageKeyIndent = undefined
      stageChildIndent = undefined
    } else if (
      key !== undefined &&
      stageKeyIndent !== undefined &&
      stageChildIndent === undefined
    ) {
      // The parser uses the first nested key's actual indentation as the
      // mapping depth; valid hand-authored YAML need not use two spaces.
      stageChildIndent = keyIndent
    }

    // A membership list is a plain key at the stage mapping's parsed depth and
    // named the one key that stage type reads. Anything nested more deeply
    // keeps its line untouched.
    const membershipKey =
      levelIndex >= 0 ? STAGE_MEMBERSHIP_KEY[stageTypes[levelIndex] ?? ''] : undefined
    if (
      isItem ||
      key === undefined ||
      key !== membershipKey ||
      stageKeyIndent === undefined ||
      stageChildIndent === undefined ||
      keyIndent !== stageChildIndent
    ) {
      rewritten.push(line)
      index++
      continue
    }

    const indentText = line.slice(0, keyIndent)
    const rawValue = keyText.slice(keyLength)
    const withoutComment = stripInlineComment(rawValue)
    // Whatever separated the value from its trailing comment, and the comment.
    const commentSuffix = rawValue.slice(withoutComment.trimEnd().length)
    const inlineValue = withoutComment.trim()

    // Flow sequence: participants: [writer, editor]  # a note
    if (inlineValue.startsWith('[') && inlineValue.endsWith(']')) {
      const items = splitFlowSequence(inlineValue)
      const kept = items.filter((item) => item.value !== agentName)
      // A list the departing member was never in is not this operation's to
      // reformat: re-rendering it would requote its entries, collapse its
      // spacing, and drop its comment for no reason.
      if (kept.length === items.length) {
        rewritten.push(line)
        index++
        continue
      }
      rewritten.push(
        `${indentText}${writtenKey}: ` +
          `${renderFlowSequence(kept.map((item) => item.raw))}${commentSuffix}`,
      )
      index++
      continue
    }
    // Any other inline value is not a list this pass understands.
    if (inlineValue !== '') {
      rewritten.push(line)
      index++
      continue
    }

    // A blank line or a comment between two entries does not end a block list.
    // Collect the whole run, then cut it back to the last entry: whatever
    // follows that belongs to the next key, not to this list.
    const collected: Array<{ line: string; value?: string }> = []
    let cursor = index + 1
    let lastEntryOffset = -1
    while (cursor < range.end) {
      const entryLine = lines[cursor] ?? ''
      const entryContent = entryLine.trimStart()
      if (entryContent === '') {
        collected.push({ line: entryLine })
        cursor++
        continue
      }
      if (entryLine.length - entryContent.length < keyIndent) break
      if (entryContent.startsWith('#')) {
        collected.push({ line: entryLine })
        cursor++
        continue
      }
      if (!entryContent.startsWith('- ')) break
      lastEntryOffset = collected.length
      collected.push({
        line: entryLine,
        value: unquoteScalar(stripInlineComment(entryContent.slice(2))),
      })
      cursor++
    }

    const listLines = collected.slice(0, lastEntryOffset + 1)
    const items = listLines.filter((entry) => entry.value !== undefined)
    const kept = items.filter((entry) => entry.value !== agentName)
    if (kept.length === items.length) {
      rewritten.push(line)
      index++
      continue
    }
    // Only the departing member's own lines go; every comment and blank line
    // the author wrote inside the list stays exactly where it was.
    const survivors = listLines.filter((entry) => entry.value !== agentName)
    if (kept.length === 0) {
      rewritten.push(`${indentText}${writtenKey}: []`, ...survivors.map((entry) => entry.line))
    } else {
      rewritten.push(line, ...survivors.map((entry) => entry.line))
    }
    index = index + 1 + listLines.length
  }

  return [...lines.slice(0, range.start), ...rewritten, ...lines.slice(range.end)].join('\n')
}

/** Kept entries keep the spelling they were written with. */
function renderFlowSequence(rawItems: string[]): string {
  return rawItems.length === 0 ? '[]' : `[${rawItems.join(', ')}]`
}

interface FlowItem {
  /** The entry exactly as written, quotes included. */
  raw: string
  /** Its scalar value, for comparing against an agent name. */
  value: string
}

function splitFlowSequence(value: string): FlowItem[] {
  const items: FlowItem[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  const push = () => {
    const raw = current.trim()
    if (raw !== '') items.push({ raw, value: unquoteScalar(raw) })
    current = ''
  }
  for (const character of value.slice(1, -1)) {
    if (escaped) escaped = false
    else if (character === '\\' && inDouble) escaped = true
    else if (character === "'" && !inDouble) inSingle = !inSingle
    else if (character === '"' && !inSingle) inDouble = !inDouble
    else if (character === ',' && !inSingle && !inDouble) {
      push()
      continue
    }
    current += character
  }
  push()
  return items
}
