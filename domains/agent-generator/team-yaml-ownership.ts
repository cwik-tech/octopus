/**
 * Who declares a generated team's final artifact, edited as `team.yaml` text.
 *
 * Pure: the functions take `team.yaml` text, its parsed form or its lines, do
 * no I/O, and use `parseYaml` as their only dependency outside this folder.
 * The caller in `team-manager.ts` keeps the lock, the revision check,
 * validation and every write. These bytes feed the revision digest a restarted caller
 * uses to recognize its own write, so a change here is a format change.
 *
 * This file also holds the `team:` block's building marker, `TEAM_BUILDING_KEY`,
 * and `readTeamBuildingFlag`, which reads it, plus `TEAM_PUBLISHED_BY_KEY`,
 * which records the build that published the team.
 */

import { parseYaml, type YamlObject } from '../../core/yaml-parser.js'
import {
  indentWidth,
  isObject,
  parseStringList,
  stringOrUndefined,
  stripInlineComment,
  topLevelKey,
  unquoteScalar,
  yamlQuoted,
} from './team-yaml-scalars.js'

export const GENERATED_TEAM_OUTPUT_ARTIFACT = 'final-result.md'

/**
 * Marks a `team.yaml` this app authored.
 *
 * Provenance is a recorded fact, never an inference. A hand-authored team may
 * use the same conventional output name, the same single `setup` level and the
 * same gate; none of that says who wrote the file. Only this key does.
 *
 * A generated team created before this key existed does not carry it and is
 * therefore treated as hand-authored: the builder refuses to move its output
 * owner rather than rewriting a file it cannot prove it owns. That is the
 * compatibility policy, and it fails safe. No migration is performed.
 */
export const GENERATED_TEAM_PROVENANCE_KEY = 'created_by'
export const GENERATED_TEAM_PROVENANCE = 'team-builder'

/**
 * The line range of one top-level block, indentless sequences included.
 *
 * `findTopLevelBlock` ends a block at the first unindented line, and a sequence
 * written at column zero — `agents:` followed by `- name: …` — is unindented,
 * so it ends the block immediately and hides every entry. That spelling is
 * valid YAML and `core/yaml-parser.ts` accepts it, so a team.yaml written that
 * way is a real team whose members must still be removable. Any `- ` at column
 * zero before the next top-level key belongs to this block, so it extends the
 * range rather than closing it.
 *
 * Add, update, and create keep the original locator: this one exists for the
 * removal path and changes nothing they do.
 */
export function findBlockRange(
  lines: string[],
  key: string,
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => topLevelKey(line) === key)
  if (start < 0) return null
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.startsWith('#')) continue
    if (!/^\S/.test(line)) continue
    if (line.startsWith('- ')) continue
    return { start, end: index }
  }
  return { start, end: lines.length }
}

export interface RosterEntrySpan {
  name: string
  /** Index of the entry's `- ` line. */
  start: number
  /** Index just past the entry, which is the next entry's `- ` line. */
  end: number
}

export function collectRosterEntrySpans(
  lines: string[],
  range: { start: number; end: number },
): RosterEntrySpan[] {
  const starts: number[] = []
  let entryIndent: number | undefined
  for (let index = range.start + 1; index < range.end; index++) {
    const line = lines[index] ?? ''
    const content = line.trimStart()
    if (!content.startsWith('- ')) continue
    const indent = line.length - content.length
    if (entryIndent === undefined) entryIndent = indent
    if (indent !== entryIndent) continue
    starts.push(index)
  }
  const indent = entryIndent ?? 0
  return starts.map((start) => {
    const end = rosterEntryEnd(lines, start, range.end, indent)
    return { start, end, name: rosterEntryName(lines, start, end, indent) }
  })
}

interface ArtifactItemSpan {
  /** Index of the item's `- ` line. */
  start: number
  /** The `path:` this item declares, whatever order its keys are written in. */
  artifactPath: string | undefined
}

/**
 * The mapping items of one `produces:` list, with the artifact each names.
 *
 * A YAML mapping has no required key order, and `parseTeamConfig` reads
 * `- description: ...` followed by `path: ...` as the same declaration as
 * `- path: ...`. So an item is located by its `- ` marker and its own indent,
 * and its path is read from whichever line inside it carries the key.
 */
function collectArtifactItems(
  lines: string[],
  start: number,
  end: number,
): ArtifactItemSpan[] {
  const items: ArtifactItemSpan[] = []
  let itemIndent: number | null = null
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (!/^-\s/u.test(line.trimStart())) continue
    const indent = indentWidth(line)
    itemIndent ??= indent
    if (indent !== itemIndent) continue
    items.push({ start: index, artifactPath: undefined })
  }
  if (itemIndent === null) return items

  for (const [position, item] of items.entries()) {
    const itemEnd = items[position + 1]?.start ?? end
    for (let index = item.start; index < itemEnd; index += 1) {
      const raw = lines[index] ?? ''
      const content = index === item.start
        ? raw.trimStart().replace(/^-\s+/u, '')
        : raw.trimStart()
      const match = content.match(/^path:\s*(.*)$/u)
      if (!match) continue
      item.artifactPath = unquoteScalar(stripInlineComment(match[1] ?? ''))
      break
    }
  }
  return items
}

/**
 * Whether this line is a `produces:` key with no inline value.
 *
 * A trailing comment is ordinary YAML and the shipped parser reads it without
 * complaint, so matching the line exactly made a commented key invisible: the
 * previous owner could not be found, and the artifact ended up declared twice.
 */
function isBlockProducesKey(line: string): boolean {
  return /^produces:\s*(?:#.*)?$/u.test(line.trimStart())
}

/**
 * Removes the generated final artifact from existing roster entries as text.
 *
 * Batch additions preserve hand-authored roster fields, so they cannot use the
 * full-block renderer merely to move one generated declaration. The new final
 * sequence member receives the declaration when its entry is rendered.
 */
export function removeGeneratedOutputOwnership(yaml: string): string {
  const lines = yaml.split('\n')
  const range = findBlockRange(lines, 'agents')
  if (!range) return yaml

  const replacements: Array<{ start: number; end: number; lines: string[] }> = []
  for (const entry of collectRosterEntrySpans(lines, range)) {
    const entryIndent = indentWidth(lines[entry.start] ?? '')
    let producesIndex: number | null = null
    for (let index = entry.start + 1; index < entry.end; index += 1) {
      const line = lines[index] ?? ''
      if (indentWidth(line) === entryIndent + 2 && isBlockProducesKey(line)) {
        producesIndex = index
        break
      }
    }
    if (producesIndex === null) continue

    const producesIndent = indentWidth(lines[producesIndex] ?? '')
    let producesEnd = entry.end
    for (let index = producesIndex + 1; index < entry.end; index += 1) {
      const line = lines[index] ?? ''
      if (line.trim() === '') continue
      if (indentWidth(line) <= producesIndent) {
        producesEnd = index
        break
      }
    }
    // A blank line after the last item separates this entry from what follows.
    // It belongs to the file's layout, not to the declaration being removed, and
    // taking it left two sections run together.
    while (producesEnd > producesIndex + 1 && (lines[producesEnd - 1] ?? '').trim() === '') {
      producesEnd -= 1
    }

    // Every item of the list, by its span, and the artifact each one names —
    // whichever key it happens to lead with. Matching only a leading `- path:`
    // mistook an item written description-first for part of its neighbour,
    // which deleted an unrelated artifact when ownership moved, and missed a
    // generated declaration written that way, which left it declared twice.
    const items = collectArtifactItems(lines, producesIndex + 1, producesEnd)
    const itemStarts = items
      .filter((item) => item.artifactPath === GENERATED_TEAM_OUTPUT_ARTIFACT)
      .map((item) => item.start)
    if (itemStarts.length === 0) continue
    const allItemStarts = items.map((item) => item.start)

    if (itemStarts.length === allItemStarts.length) {
      replacements.push({
        start: producesIndex,
        end: producesEnd,
        lines: [`${' '.repeat(producesIndent)}produces: []`],
      })
      continue
    }

    for (const start of itemStarts) {
      const nextItem = allItemStarts.find((itemStart) => itemStart > start)
      replacements.push({
        start,
        end: nextItem ?? producesEnd,
        lines: [],
      })
    }
  }

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    lines.splice(
      replacement.start,
      replacement.end - replacement.start,
      ...replacement.lines,
    )
  }
  return lines.join('\n')
}

/**
 * Puts `produces: final-result.md` on exactly the agent the shape says owns it.
 *
 * Two failures this prevents. Adding a member moves the declaration onto the
 * newest agent and leaves the previous owner with a literal `produces: []`;
 * removing that member had no inverse, so the gate's artifact lost its only
 * producer, validation refused the write, and the user could not undo the
 * addition they had just made. And each shape names a different owner — a
 * chain's last sequence agent, a discussion's coordinator, and for a review
 * nobody at all, because the runtime writes that artifact itself
 * (`engines/review.ts:1385-1412`) and self-registers as its producer.
 *
 * Only a generated team is touched. A hand-authored chain whose first agent
 * owns the output has arranged that deliberately, and its removal stays
 * refused.
 */
export function settleGeneratedOutputOwnership(yaml: string): string {
  const parsed = parseYaml(yaml)
  if (!generatedSetupStage(parsed)) return yaml

  const owner = intendedGeneratedOutputOwner(parsed)
  const current = generatedOutputOwners(parsed)

  // Already exactly right, including the review case of nobody at all.
  if (owner === undefined && current.length === 0) return yaml
  if (current.length === 1 && current[0] === owner) return yaml

  // Never leave two owners: a duplicate producer is a visible health warning.
  const stripped = current.length > 0 ? removeGeneratedOutputOwnership(yaml) : yaml
  if (owner === undefined) return stripped
  return grantGeneratedOutputOwnership(stripped, owner)
}

/** Which roster entries declare the generated final artifact. */
function generatedOutputOwners(parsed: YamlObject): string[] {
  const agents = Array.isArray(parsed.agents) ? parsed.agents : []
  return agents.flatMap((agent) => {
    if (!isObject(agent) || !Array.isArray(agent.produces)) return []
    const name = stringOrUndefined(agent.name)
    if (!name) return []
    return agent.produces.some(
      (artifact) =>
        isObject(artifact) && artifact.path === GENERATED_TEAM_OUTPUT_ARTIFACT,
    )
      ? [name]
      : []
  })
}

/**
 * Writes `produces: final-result.md` onto one roster entry, as text.
 *
 * Text, not a re-render, for the reason `removeRosterEntry` (in
 * `team-yaml-removal.ts`) gives: rendering the
 * block from the parsed model drops every field the Create UI does not model.
 * Three shapes have to be handled — the `produces: []` that ownership removal
 * leaves behind, an existing block list, and an entry with no `produces:` key.
 */
function grantGeneratedOutputOwnership(yaml: string, agentName: string): string {
  const lines = yaml.split('\n')
  const range = findBlockRange(lines, 'agents')
  if (!range) return yaml

  const entry = collectRosterEntrySpans(lines, range).find(
    (candidate) => candidate.name === agentName,
  )
  if (!entry) return yaml

  const entryIndent = indentWidth(lines[entry.start] ?? '')
  const fieldIndent = entryIndent + 2
  const itemIndent = fieldIndent + 2
  const item = `${' '.repeat(itemIndent)}- path: ${yamlQuoted(GENERATED_TEAM_OUTPUT_ARTIFACT)}`

  let producesIndex: number | null = null
  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const line = lines[index] ?? ''
    if (indentWidth(line) !== fieldIndent) continue
    if (/^produces:/u.test(line.trimStart())) {
      producesIndex = index
      break
    }
  }

  if (producesIndex === null) {
    // No declaration at all. Append after the entry's last content line, so a
    // trailing blank line or a comment that introduces the next entry stays put.
    let insertAt = entry.start + 1
    for (let index = entry.start + 1; index < entry.end; index += 1) {
      if ((lines[index] ?? '').trim() === '') continue
      if (indentWidth(lines[index] ?? '') <= entryIndent) break
      insertAt = index + 1
    }
    lines.splice(insertAt, 0, `${' '.repeat(fieldIndent)}produces:`, item)
    return lines.join('\n')
  }

  const producesLine = lines[producesIndex] ?? ''
  if (!isBlockProducesKey(producesLine)) {
    // An inline value — `produces: []` is what ownership removal writes when it
    // empties the list. Only the value is replaced, so a trailing comment on
    // the key survives: it is the author's note about the field, not about the
    // one declaration being added.
    const [, keyAndSpace = '', comment = ''] =
      producesLine.match(/^(\s*produces:)[^#]*(#.*)?$/u) ?? []
    const rewritten = keyAndSpace
      ? `${keyAndSpace}${comment ? ` ${comment}` : ''}`
      : `${' '.repeat(fieldIndent)}produces:`
    lines.splice(producesIndex, 1, rewritten, item)
    return lines.join('\n')
  }

  // A block list already: append one item after its last entry.
  let insertAt = producesIndex + 1
  for (let index = producesIndex + 1; index < entry.end; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (indentWidth(line) <= fieldIndent) break
    insertAt = index + 1
  }
  lines.splice(insertAt, 0, item)
  return lines.join('\n')
}

/**
 * Where one roster entry stops.
 *
 * Ending it at the next entry — or, for the last one, at the end of the block —
 * hands it every blank line and comment that merely follows it. A comment
 * sitting at or left of the entry's own indent is not inside the entry: it
 * introduces whatever comes next, most visibly a note above `levels:`, and
 * deleting the entry must not take it or the blank line that separates them.
 */
function rosterEntryEnd(
  lines: string[],
  start: number,
  blockEnd: number,
  entryIndent: number,
): number {
  let contentEnd = start + 1
  for (let index = start + 1; index < blockEnd; index++) {
    const line = lines[index] ?? ''
    const content = line.trimStart()
    if (content === '') continue
    if (line.length - content.length <= entryIndent) break
    contentEnd = index + 1
  }

  let probe = contentEnd
  while (probe < blockEnd && (lines[probe] ?? '').trim() === '') probe++
  if (probe < blockEnd) {
    const next = lines[probe] ?? ''
    const nextContent = next.trimStart()
    if (nextContent.startsWith('#') && next.length - nextContent.length <= entryIndent) {
      // The blank separator belongs to that comment, not to this entry.
      return contentEnd
    }
  }
  return probe
}

/**
 * The `name:` of one roster entry, whether written on the `- ` line or below
 * it. Only keys of the entry itself are read, so a `name:` nested inside
 * `provider_config` or `mount` cannot be mistaken for the member's own.
 */
function rosterEntryName(
  lines: string[],
  start: number,
  end: number,
  entryIndent: number,
): string {
  const nameOnItemLine = (lines[start] ?? '').trimStart().slice(2).match(/^name:(.*)$/)
  if (nameOnItemLine) return unquoteScalar(stripInlineComment(nameOnItemLine[1] ?? ''))
  for (let index = start + 1; index < end; index++) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    const content = line.trimStart()
    const indent = line.length - content.length
    if (indent <= entryIndent) break
    if (indent !== entryIndent + 2) continue
    const match = content.match(/^name:(.*)$/)
    if (match) return unquoteScalar(stripInlineComment(match[1] ?? ''))
  }
  return ''
}

/** Whether the team's completion artifact is the one generated teams produce. */
function declaresGeneratedCompletion(parsed: YamlObject): boolean {
  const workflow = isObject(parsed.workflow) ? parsed.workflow : undefined
  const output = workflow && isObject(workflow.output_contract)
    ? workflow.output_contract
    : undefined
  return output?.completion_artifact === GENERATED_TEAM_OUTPUT_ARTIFACT
}

/**
 * The single `setup` stage of a generated team, whatever shape it takes.
 *
 * Keyed on provenance, not on shape. A predicate that answered for a chain
 * only — which is what this replaced — gave a generated discussion no ownership
 * transfer when a member was added, so its coordinator declared nothing and the
 * team failed validation. Matching on the generated completion artifact keeps
 * hand-authored teams of every shape out of these paths.
 */
export function generatedSetupStage(parsed: YamlObject): YamlObject | undefined {
  // Provenance, not a filename. `final-result.md` is a conventional name a
  // hand-authored team may use too, and matching on it alone let the ownership
  // transfer reach a file whose author had arranged its producer deliberately.
  // Only a team this app built carries `created_by_orchestrator`, and every
  // real build supplies it (`resource-architect-service.ts:551`).
  if (!hasGeneratedProvenance(parsed)) return undefined
  if (!Array.isArray(parsed.levels) || parsed.levels.length !== 1) return undefined
  const level = parsed.levels[0]
  if (!isObject(level) || level.id !== 'setup' || !isObject(level.stage)) return undefined
  if (!declaresGeneratedCompletion(parsed)) return undefined
  const type = stringOrUndefined(level.stage.type)
  if (type !== 'chain' && type !== 'discussion' && type !== 'review') return undefined
  return level.stage
}

/**
 * Whether this app authored the file, as the file itself records.
 *
 * Either marker counts. `created_by` is written on every team the builder
 * creates; `created_by_orchestrator` is older and present on every team an
 * Architect build produced, so accepting it keeps those working without a
 * migration.
 */
function hasGeneratedProvenance(parsed: YamlObject): boolean {
  const team = isObject(parsed.team) ? parsed.team : undefined
  if (!team) return false
  if (stringOrUndefined(team[GENERATED_TEAM_PROVENANCE_KEY]) === GENERATED_TEAM_PROVENANCE) {
    return true
  }
  return stringOrUndefined(team.created_by_orchestrator) !== undefined
}

/**
 * Who declares `produces: final-result.md`, for the shape this team runs.
 *
 * Each shape has a different answer, and only one of them is "the newest
 * member". A chain's deliverable is written by its last sequence agent; a
 * discussion's by its coordinator; a review's by the runtime itself
 * (`engines/review.ts:1385-1412`), which self-registers as the producer, so
 * naming an agent there would assert something untrue.
 */
export function intendedGeneratedOutputOwner(
  parsed: YamlObject,
  addedNames: readonly string[] = [],
): string | undefined {
  const stage = generatedSetupStage(parsed)
  if (!stage) return undefined
  switch (stringOrUndefined(stage.type)) {
    case 'chain':
      // The declared sequence first: a shaped team names its order before any
      // member is added, and the last of those writes the deliverable. Only a
      // team that declared no sequence falls back to the newest addition.
      return parseStringList(stage.sequence).at(-1) ?? addedNames.at(-1)
    case 'discussion':
      return stringOrUndefined(stage.coordinator)
    default:
      return undefined
  }
}

/**
 * Marks a team whose build has not finished.
 *
 * Held in `team.yaml` rather than on the registry entry. A registry marker
 * would have to survive two independent allowlists — the runtime parser's
 * (`parsers/team-registry.ts:78-92`) and `team-yaml-render.ts`'s own `renderRegistryBlock`
 * — and an ordinary rename would erase it, silently publishing a half-built
 * team.
 *
 * **Absence means published.** Every team that existed before this marker did
 * carries nothing, so nothing disappears and no migration is needed.
 */
export const TEAM_BUILDING_KEY = 'building'

/** Whether a team.yaml carries the building marker. */
export function readTeamBuildingFlag(yaml: string): boolean {
  const team = parseYaml(yaml).team
  if (!isObject(team)) return false
  const value = team[TEAM_BUILDING_KEY]
  // `true`, or `true` with a comment after it, which the minimal parser keeps
  // as text. Both mean the build has not finished.
  return value === true || (typeof value === 'string' && /^true\b/u.test(value.trim()))
}

/**
 * Records which build published this team.
 *
 * Positive evidence, written at publication. Recovery cannot infer publication
 * from the *absence* of `building`: every team built before that marker existed
 * carries nothing, so absence would report an empty legacy shell as a finished
 * build. This key is written only by a publication that actually happened, and
 * only for the plan that owned it.
 */
export const TEAM_PUBLISHED_BY_KEY = 'published_by'
