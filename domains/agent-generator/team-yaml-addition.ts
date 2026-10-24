/**
 * Adds members to `team.yaml`, edited as text.
 *
 * `insertRosterEntries` appends roster entries without re-rendering the
 * roster, and `extendEntryStageMembership` writes the new names into the entry
 * stage's own membership list. `extendGeneratedStageMembership` makes that
 * edit for one name on a generated team and settles who declares its final
 * artifact. `refusalToAddMember` says why a generated review cannot take a
 * member, and `usesDefaultSetupChain` says whether a team runs the default
 * setup chain. They take `team.yaml` text or its parsed form, return text, a
 * message or a flag, and do no I/O. `addTeamBuilderAgent` and
 * `addTeamBuilderAgents` in `team-manager.ts` keep the lock, the reads, the
 * revision check, the hooks and the write. This module does not import
 * `team-manager.ts`.
 */

import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import { resolveEntryLevelIndex } from '../../core/stage-helpers.js'
import type { TeamRosterAgent } from './types.js'
import {
  generatedSetupStage,
  settleGeneratedOutputOwnership,
} from './team-yaml-ownership.js'
import { renderRosterEntryLines } from './team-yaml-render.js'
import {
  findTopLevelBlock,
  indentWidth,
  isObject,
  joinLabels,
  parseStringList,
  stringOrUndefined,
  stripInlineComment,
  yamlQuoted,
} from './team-yaml-scalars.js'

/**
 * Why a roster no writer can extend is refused, or undefined when it can.
 *
 * Read from the header's text, not its parsed value: a bare `agents:` header
 * parses as null just like `agents: null`, but it is an empty roster a writer
 * extends. A bare header, with or without a comment, and an empty flow list
 * are extended. A flow list with members is refused, because the parser reads
 * no mappings inside a flow list, so an entry appended below it would be
 * ignored. An explicit scalar is refused, and so is a second top-level
 * `agents` key, which the parser would read instead of the first. So is a
 * roster the parser reads under a key not written `agents:` (such as
 * `agents :` or `"agents":`), because the inserter appends only under that
 * exact header and would start a second roster instead.
 */
export function refusalForRosterShape(teamId: string, yaml: string): string | undefined {
  const lines = yaml.split('\n')
  const rosterKeys = lines.filter((line) => /^(?:agents|"agents"|'agents')\s*:/u.test(line))
  if (rosterKeys.length > 1) {
    return `Team '${teamId}' declares more than one roster, so it cannot take new members`
  }
  const header = lines.find((line) => /^agents:/u.test(line))
  if (header === undefined) {
    return Object.hasOwn(parseYaml(yaml), 'agents')
      ? `Team '${teamId}' declares its roster under a key not written "agents:", so it cannot take new members`
      : undefined
  }
  const value = stripInlineComment(header.slice('agents:'.length)).trim()
  if (value === '' || /^\[\s*\]$/u.test(value)) return undefined
  if (value.startsWith('[')) {
    return `Team '${teamId}' declares its roster as a flow list with members, so it cannot take new members`
  }
  return `Team '${teamId}' declares a roster that is not a list, so it cannot take new members`
}

/**
 * Whether an edited `team.yaml` still shows everything the current one shows
 * on its roster, plus the added names, and still has its levels.
 *
 * The last check before a roster writer writes, for shapes the header check
 * does not know: an indentless roster, one indented other than two spaces, or
 * a later key that decodes to `agents`. A named member is compared by name, so
 * the stage-membership and output-ownership edits an add makes on purpose
 * pass. An item without a name (a plain string, or a mapping with no `name`)
 * has nothing else to be known by, so it is compared whole and must survive
 * unchanged.
 */
export function rosterEditKeepsTeam(
  before: YamlObject,
  after: YamlObject,
  addedNames: readonly string[],
): boolean {
  const namesAfter = new Set(rosterNames(after.agents))
  const namelessAfter = rosterNamelessItems(after.agents)
  for (const item of rosterNamelessItems(before.agents)) {
    const index = namelessAfter.indexOf(item)
    if (index === -1) return false
    namelessAfter.splice(index, 1)
  }
  return (
    addedNames.every((name) => namesAfter.has(JSON.stringify(name))) &&
    rosterNames(before.agents).every((name) => namesAfter.has(name)) &&
    (!Object.hasOwn(before, 'levels') || Object.hasOwn(after, 'levels'))
  )
}

function rosterNames(roster: YamlValue | undefined): string[] {
  return Array.isArray(roster)
    ? roster.flatMap((entry) => (isObject(entry) && entry.name !== undefined ? [JSON.stringify(entry.name)] : []))
    : []
}

function rosterNamelessItems(roster: YamlValue | undefined): string[] {
  return Array.isArray(roster)
    ? roster.flatMap((entry) => (isObject(entry) && entry.name !== undefined ? [] : [JSON.stringify(entry)]))
    : []
}

/**
 * Appends roster entries to the existing `agents:` block without re-rendering
 * it.
 *
 * Re-rendering the block would silently drop comments, field order, and any
 * roster key the roster model does not carry, which an update was never
 * authorized to change. Only the new entries are written.
 */
export function insertRosterEntries(yaml: string, additions: readonly TeamRosterAgent[]): string {
  if (additions.length === 0) return yaml
  const rendered = additions.flatMap((agent, index) => [
    ...(index === 0 ? [] : ['']),
    ...renderRosterEntryLines(agent),
  ])
  const lines = yaml.split('\n')
  const range = findTopLevelBlock(lines, 'agents')
  if (!range) {
    return [...trimTrailingBlankLines(lines), '', 'agents:', ...rendered].join('\n')
  }
  const headerLine = lines[range.start] ?? ''
  // `agents: []` declares an empty roster inline and has to become a block
  // before an entry can be appended to it. Any trailing comment is kept, moved
  // onto the block header so the result is still valid YAML.
  const emptyInline = headerLine.match(/^agents:\s*\[\s*\]\s*(#.*)?$/u)
  if (emptyInline) {
    const comment = emptyInline[1]
    return [
      ...lines.slice(0, range.start),
      comment ? `agents: ${comment}` : 'agents:',
      ...rendered,
      ...lines.slice(range.start + 1),
    ].join('\n')
  }
  const body = trimTrailingBlankLines(lines.slice(range.start, range.end))
  return [
    ...lines.slice(0, range.start),
    ...body,
    '',
    ...rendered,
    ...lines.slice(range.end),
  ].join('\n')
}

/**
 * Adds the new names to the entry stage's own membership list.
 *
 * A discussion entry stage takes participants. The generated default setup
 * chain takes sequence entries, which is the only sequence an update may
 * touch. Every other topology keeps its own membership rules: an update adds
 * roster members, it does not rewrite how a Team runs.
 */
export function extendEntryStageMembership(
  yaml: string,
  parsed: YamlObject,
  names: readonly string[],
): string {
  if (names.length === 0) return yaml
  const rawLevels = Array.isArray(parsed.levels) ? parsed.levels : []
  if (rawLevels.length === 0) return yaml
  const workflow = isObject(parsed.workflow) ? parsed.workflow : undefined
  const entryLevelIndex = resolveEntryLevelIndex(
    rawLevels.map((level) => ({
      id: (isObject(level) ? stringOrUndefined(level.id) : undefined) ?? '',
    })),
    workflow ? stringOrUndefined(workflow.entry_level) : undefined,
  )
  const level = rawLevels[entryLevelIndex]
  if (!isObject(level) || !isObject(level.stage)) return yaml
  const stage = level.stage
  const stageType = stringOrUndefined(stage.type)

  const membershipKey = stageType === 'discussion' && Array.isArray(stage.participants)
    ? 'participants'
    : stageType === 'chain' &&
        usesDefaultSetupChain(parsed)
      ? 'sequence'
      : null
  // A review stage has no membership list at all, so there is nothing to
  // extend and a third agent would be inert. The shape contract refuses that
  // roster before it reaches here.
  if (!membershipKey) return yaml
  const declared = parseStringList(
    membershipKey === 'participants' ? stage.participants : stage.sequence,
  )
  // The coordinator speaks as the coordinator. Listing it among the
  // participants too would make one member hold two roles, and the discussion
  // engine would dispatch it twice a round.
  const coordinator = stringOrUndefined(stage.coordinator)
  const eligible = membershipKey === 'participants' && coordinator
    ? names.filter((name) => name !== coordinator)
    : names
  const missing = eligible.filter((name) => !declared.includes(name))
  if (missing.length === 0) return yaml

  return insertStageMembers(yaml, entryLevelIndex, membershipKey, missing)
}

/**
 * Writes the missing names into the entry level's own membership key.
 *
 * The key is located inside the entry level's item range and at the stage's
 * own depth, so a `participants` key belonging to a later level or nested in
 * stage configuration is never selected.
 */
function insertStageMembers(
  yaml: string,
  entryLevelIndex: number,
  membershipKey: string,
  missing: readonly string[],
): string {
  const lines = yaml.split('\n')
  const levelsRange = findTopLevelBlock(lines, 'levels')
  if (!levelsRange) return yaml
  const itemRange = findSequenceItemRange(lines, levelsRange, entryLevelIndex)
  if (!itemRange) return yaml
  // A level item's own keys sit one indent level inside the `- ` marker. A
  // `stage:` nested under `metadata:` is deeper, so requiring the exact depth
  // keeps documentation blocks from being mistaken for the real stage.
  const itemIndent = indentWidth(lines[itemRange.start] ?? '')
  const stageIndex = findKeyIndex(lines, itemRange, 'stage', itemIndent + 2)
  if (stageIndex === null) return yaml
  const stageIndent = indentWidth(lines[stageIndex] ?? '')
  // The stage's own keys sit at whatever depth its first key uses, not always
  // two spaces in, so a list at that depth is the one to extend rather than a
  // reason to write a second key of the same name.
  const stageChildIndent = firstChildIndent(lines, stageIndex, itemRange.end, stageIndent) ?? stageIndent + 2
  const keyIndex = findKeyIndex(lines, { start: stageIndex + 1, end: itemRange.end }, membershipKey, stageChildIndent)
  if (keyIndex === null) {
    return insertMissingStageMemberList(
      lines,
      itemRange,
      stageIndex,
      stageIndent,
      membershipKey,
      missing,
    )
  }

  const keyLine = lines[keyIndex] ?? ''
  // An inline flow sequence may carry a trailing comment. Only the bracketed
  // span is rewritten, so the comment keeps its text and position.
  const inline = keyLine.match(/^(\s*[A-Za-z0-9_-]+:\s*\[)([^\]]*)(\].*)$/u)
  if (inline) {
    const [, prefix = '', inner = '', suffix = ''] = inline
    const additions = missing.map((name) => yamlQuoted(name)).join(', ')
    const existing = inner.trim()
    return [
      ...lines.slice(0, keyIndex),
      `${prefix}${existing ? `${existing}, ` : ''}${additions}${suffix}`,
      ...lines.slice(keyIndex + 1),
    ].join('\n')
  }
  // A block list header may carry a comment of its own; the entries below it
  // are the same list either way.
  if (!/^\s*[A-Za-z0-9_-]+:\s*(?:#.*)?$/u.test(keyLine)) return yaml

  const keyIndent = indentWidth(keyLine)
  // Insert after the last existing entry, not after the last line of the
  // block. A comment or blank line below the names belongs to whatever follows
  // it, so moving the insertion point past them would re-associate it.
  let insertAt = keyIndex + 1
  let entryPrefix: string | null = null
  for (let index = keyIndex + 1; index < itemRange.end; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const indent = indentWidth(line)
    if (indent <= keyIndent) break
    if (line.trim().startsWith('#')) continue
    const entry = line.match(/^(\s*)- /u)
    if (!entry) break
    entryPrefix = line.slice(0, (entry[1] ?? '').length + 2)
    insertAt = index + 1
  }
  const prefix = entryPrefix ?? `${' '.repeat(keyIndent + 2)}- `
  return [
    ...lines.slice(0, insertAt),
    ...missing.map((name) => `${prefix}${yamlQuoted(name)}`),
    ...lines.slice(insertAt),
  ].join('\n')
}

function insertMissingStageMemberList(
  lines: string[],
  itemRange: { start: number; end: number },
  stageIndex: number,
  stageIndent: number,
  membershipKey: string,
  missing: readonly string[],
): string {
  let stageChildIndent: number | null = null
  let typeIndex: number | null = null
  for (let index = stageIndex + 1; index < itemRange.end; index += 1) {
    const line = lines[index] ?? ''
    const content = line.trimStart()
    if (content === '' || content.startsWith('#')) continue
    const indent = indentWidth(line)
    if (indent <= stageIndent) break
    stageChildIndent ??= indent
    if (indent === stageChildIndent && content.startsWith('type:')) {
      typeIndex = index
      break
    }
  }
  if (stageChildIndent === null || typeIndex === null) return lines.join('\n')

  const keyIndent = ' '.repeat(stageChildIndent)
  const entryIndent = ' '.repeat(stageChildIndent + 2)
  return [
    ...lines.slice(0, typeIndex + 1),
    `${keyIndent}${membershipKey}:`,
    ...missing.map((name) => `${entryIndent}- ${yamlQuoted(name)}`),
    ...lines.slice(typeIndex + 1),
  ].join('\n')
}

/** Indent of the first key under the line at `parentIndex`, if it has one. */
function firstChildIndent(
  lines: readonly string[],
  parentIndex: number,
  end: number,
  parentIndent: number,
): number | null {
  for (let index = parentIndex + 1; index < end; index += 1) {
    const line = lines[index] ?? ''
    const content = line.trimStart()
    if (content === '' || content.startsWith('#')) continue
    const indent = indentWidth(line)
    return indent > parentIndent ? indent : null
  }
  return null
}

/** Line range of the `index`-th item of a block sequence inside `range`. */
function findSequenceItemRange(
  lines: readonly string[],
  range: { start: number; end: number },
  index: number,
): { start: number; end: number } | null {
  const itemStarts: number[] = []
  let itemIndent: number | null = null
  for (let line = range.start + 1; line < range.end; line += 1) {
    const match = (lines[line] ?? '').match(/^(\s*)- /u)
    if (!match) continue
    const indent = (match[1] ?? '').length
    if (itemIndent === null) itemIndent = indent
    if (indent === itemIndent) itemStarts.push(line)
  }
  const start = itemStarts[index]
  if (start === undefined) return null
  return { start, end: itemStarts[index + 1] ?? range.end }
}

/**
 * Index of `key` inside `range`, optionally restricted to one exact
 * indentation so a nested key of the same name is never selected.
 */
function findKeyIndex(
  lines: readonly string[],
  range: { start: number; end: number },
  key: string,
  requiredIndent: number | null,
): number | null {
  const pattern = new RegExp(`^(\\s*)${key}:`, 'u')
  for (let line = range.start; line < range.end; line += 1) {
    const match = (lines[line] ?? '').match(pattern)
    if (!match) continue
    if (requiredIndent !== null && (match[1] ?? '').length !== requiredIndent) continue
    return line
  }
  return null
}

function trimTrailingBlankLines(lines: readonly string[]): string[] {
  const kept = [...lines]
  while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop()
  return kept
}

export function usesDefaultSetupChain(parsed: YamlObject): boolean {
  if (!Array.isArray(parsed.levels) || parsed.levels.length !== 1) return false
  const level = parsed.levels[0]
  if (!isObject(level) || level.id !== 'setup' || !isObject(level.stage)) return false
  return level.stage.type === 'chain'
}

/**
 * Adds one name to a generated team's stage membership, if its shape has one.
 *
 * Exported so every writer that can put a member on a roster applies the same
 * edit. A roster entry the stage does not name is an agent the runtime never
 * dispatches, and which page added it makes no difference to that.
 */
export function extendGeneratedStageMembership(
  yaml: string,
  agentName: string,
): string {
  const parsed = parseYaml(yaml)
  if (!generatedSetupStage(parsed)) return yaml
  return settleGeneratedOutputOwnership(
    extendEntryStageMembership(yaml, parsed, [agentName]),
  )
}

/**
 * Why this generated team cannot take another member, if it cannot.
 *
 * A review stage carries no membership list, so a third agent joins the roster
 * and is never dispatched — the user is told it is on the team while nothing
 * will ever run it. Discussion membership is an eligible roster from which
 * the lead can select specialists, so it has no conversation-size restriction.
 *
 * Only generated teams are governed. A hand-authored review is its author's own
 * arrangement, and this says nothing about it.
 */
export function refusalToAddMember(
  parsed: YamlObject,
  names: readonly string[],
): string | undefined {
  const stage = generatedSetupStage(parsed)
  if (!stage || names.length === 0) return undefined
  const type = stringOrUndefined(stage.type)

  if (type === 'review') {
    // The stage's own two roles are still being assembled onto the roster, and
    // refusing those would make building the team impossible. What is refused
    // is a member no role names, because that one can never be dispatched.
    const roles = [
      stringOrUndefined(stage.producer),
      stringOrUndefined(stage.reviewer),
    ].filter((name): name is string => name !== undefined)
    const unrunnable = names.filter((name) => !roles.includes(name))
    if (unrunnable.length === 0) return undefined
    return `A review team is one writer and one checker, so ${joinLabels([...unrunnable])} ` +
      `cannot be added: a review stage has no membership list, and the agent would ` +
      `never run. Change how this team works together first, or replace the writer or the checker.`
  }

  return undefined
}
