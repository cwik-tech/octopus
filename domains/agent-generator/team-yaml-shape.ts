/**
 * Rewrites how a saved generated team works together, edited as `team.yaml`
 * text.
 *
 * `SHAPE_STAGE_KEYS` and `SHAPE_CONFIG_KEYS` name the keys that describe a
 * saved shape. `savedTeamShapeIsEditable` says whether this app may still
 * rewrite a saved file, and `replaceGeneratedStageBody` rewrites those keys
 * and leaves every other line where it was. Publication calls
 * `stageDiffersFromShape` to learn how a saved stage differs from the shape
 * its build was admitted with. They take `team.yaml` text or its parsed form,
 * return text, a flag or a reason, and do no I/O. The lock, the reads, the
 * revision check, validation and the writes stay in `team-manager.ts`, in
 * `changeSavedTeamShape` and `finishTeamBuilderPublication`. This module does
 * not import `team-manager.ts`.
 */

import type { YamlObject } from '../../core/yaml-parser.js'
import { depthRounds, type TeamShape } from '../../contracts/schemas/team-shape.js'
import type { TeamRosterAgent } from './types.js'
import {
  GENERATED_TEAM_OUTPUT_ARTIFACT,
  generatedSetupStage,
  readTeamBuildingFlag,
} from './team-yaml-ownership.js'
import { renderStageBody } from './team-yaml-render.js'
import {
  findTopLevelBlock,
  isObject,
  parseStringList,
  stringOrUndefined,
  stripInlineComment,
} from './team-yaml-scalars.js'

/**
 * Whether this app may still rewrite how a saved team works together.
 *
 * Provenance is not enough. This app emits one arrangement — a single first
 * level whose stage produces `final-result.md`, with one gate that waits for
 * exactly that — and the rewrite assumes every part of it. A file that has
 * moved away from any of it is a team somebody has made their own: the stage
 * may feed a level this app never wrote, or a gate that waits for something
 * else, and rewriting it would break whatever they built around it.
 *
 * A team still being built is excluded too. Its roster is half-assembled and
 * its shape belongs to the build that is assembling it.
 */
export function savedTeamShapeIsEditable(parsed: YamlObject, yaml: string): boolean {
  if (!generatedSetupStage(parsed)) return false
  if (readTeamBuildingFlag(yaml)) return false
  // The rewrite edits text where this app writes the stage. A file laid out
  // otherwise, such as an indentless `levels:` list, has no line there to
  // edit, and changing nothing while reporting success is the failure this
  // refuses.
  if (setupStageLine(yaml.split('\n')) === null) return false

  const level = Array.isArray(parsed.levels) ? parsed.levels[0] : undefined
  if (!isObject(level) || level.order !== 0) return false
  const stage = isObject(level.stage) ? level.stage : undefined
  const config = stage && isObject(stage.config) ? stage.config : undefined
  const output = config && isObject(config.output) ? config.output : undefined
  if (stringOrUndefined(output?.format) !== GENERATED_TEAM_OUTPUT_ARTIFACT) {
    return false
  }

  // One gate, and it is the one this app writes. A second gate is a route
  // through the team that this rewrite knows nothing about.
  const gates = Array.isArray(parsed.gates) ? parsed.gates : []
  if (gates.length !== 1) return false
  const gate = gates[0]
  if (!isObject(gate) || gate.from !== 'setup' || gate.to !== 'done') return false
  const condition = isObject(gate.condition) ? gate.condition : undefined
  return (
    condition?.type === 'artifact_exists' &&
    stringOrUndefined(condition.artifact) === GENERATED_TEAM_OUTPUT_ARTIFACT
  )
}

/**
 * Rewrites only the parts of the stage this feature owns.
 *
 * A saved team's stage carries more than the shape: a comment somebody wrote,
 * a constraint list nobody else declared, an `output.user_review` turned on by
 * hand. Replacing the block wholesale silently reverted all of it, so the keys
 * that describe the shape are removed and rewritten and everything else stays
 * exactly where it is.
 *
 * Located by indentation rather than by matching text: a stage can legitimately
 * contain the same words a roster entry does, and a line filter has already
 * deleted an unrelated nested field once in `team-manager.ts`'s history.
 */
export function replaceGeneratedStageBody(
  yaml: string,
  agents: TeamRosterAgent[],
  shape: TeamShape,
): string {
  const lines = yaml.split('\n')
  const stageIndex = setupStageLine(lines)
  if (stageIndex === null) return yaml
  const stageEnd = blockEnd(lines, stageIndex + 1, 6)

  const configIndex = lines
    .slice(stageIndex + 1, stageEnd)
    .findIndex((line) => /^ {6}config:\s*(#.*)?$/u.test(line))
  const configStart = configIndex < 0 ? -1 : stageIndex + 1 + configIndex
  const configEnd = configStart < 0 ? -1 : blockEnd(lines, configStart + 1, 8)

  const stageOwn = configStart < 0
    ? lines.slice(stageIndex + 1, stageEnd)
    : lines.slice(stageIndex + 1, configStart)
  const afterConfig = configStart < 0 ? [] : lines.slice(configEnd, stageEnd)
  const configOwn = configStart < 0 ? [] : lines.slice(configStart + 1, configEnd)

  const rendered = renderStageBody(agents, shape)
  const renderedConfigAt = rendered.findIndex((line) => /^ {6}config:\s*$/u.test(line))
  // The saved header, comment and all, is what stays. Emitting a fresh
  // `config:` beside it produced two blocks and split the settings between
  // them.
  const configHeader = configStart < 0 ? '      config:' : lines[configStart] ?? '      config:'
  const renderedStageKeys = rendered.slice(0, renderedConfigAt)
  const renderedConfigKeys = rendered
    .slice(renderedConfigAt + 1)
    // `output` is rendered too, but a saved team's own output block is not this
    // operation's to rewrite: the format and the review setting belong to it.
    .filter((line) => !/^ {8}output:/u.test(line) && !/^ {10}(format|user_review):/u.test(line))

  return [
    ...lines.slice(0, stageIndex + 1),
    ...renderedStageKeys,
    ...withoutKeys(stageOwn, 6, SHAPE_STAGE_KEYS),
    ...(configStart < 0 && renderedConfigKeys.length === 0 ? [] : [configHeader]),
    ...renderedConfigKeys,
    ...withoutKeys(configOwn, 8, SHAPE_CONFIG_KEYS),
    // Stage keys may follow the config block too. Left there, an old `type:`
    // or member list would be a second copy that the parser reads last.
    ...withoutKeys(afterConfig, 6, SHAPE_STAGE_KEYS),
    ...lines.slice(stageEnd),
  ].join('\n')
}

/**
 * The line of the setup level's `stage:` header, where this app writes it.
 *
 * Looked for inside the first item of the top-level `levels:` block only, at
 * the generated layout's indentation. A line reading `stage:` elsewhere, such
 * as inside a folded description, is text, not the stage. A header can carry
 * a trailing comment somebody wrote.
 */
function setupStageLine(lines: readonly string[]): number | null {
  const levels = findTopLevelBlock([...lines], 'levels')
  if (!levels) return null
  let itemStart: number | null = null
  for (let index = levels.start + 1; index < levels.end; index += 1) {
    const line = lines[index] ?? ''
    const content = line.trim()
    if (content === '' || content.startsWith('#')) continue
    if (itemStart === null) {
      if (!line.startsWith('  - ')) return null
      itemStart = index
      continue
    }
    if (/^ {0,2}\S/u.test(line)) return null
    if (/^ {4}stage:\s*(#.*)?$/u.test(line)) return index
  }
  return null
}

/** The stage keys that describe a shape, and nothing else. */
const SHAPE_STAGE_KEYS = [
  'type',
  'sequence',
  'coordinator',
  'participants',
  'producer',
  'reviewer',
] as const

/** The config keys that describe a shape's depth, and nothing else. */
const SHAPE_CONFIG_KEYS = [
  'handoff_format',
  'min_rounds',
  'max_rounds',
  'max_iterations',
  'on_max_iterations',
  // Settings one arrangement has and another does not. Left behind, a
  // discussion's reviewer rule or a chain's participation floor would still be
  // in the file describing a stage that no longer has either.
  'mode',
  'min_successful_participants',
  'on_reviewer_skip',
] as const

/**
 * Where a block that starts at `from` and is indented by `indent` ends.
 *
 * Blank lines and comments do not decide it. YAML puts no indentation contract
 * on either, and authors write both at the margin to make them stand out — so
 * a run of them says nothing about whether the block has ended. What decides is
 * the next line that declares something: if that is still inside the block, so
 * is the run leading up to it, and if it is not, the block ended before the
 * run and those lines belong to whatever comes next.
 *
 * Reading an outdented comment as the end of the block is what split a saved
 * team's stage in two. The real `config:` fell outside the part being
 * rewritten and a second one was written beside it. The write succeeded and
 * the validator accepted the file, so the change reported success — but the
 * settings were now split across two blocks, the older one won when the shape
 * was read back, and the depth the user had just chosen was gone.
 */
function blockEnd(lines: string[], from: number, indent: number): number {
  const prefix = ' '.repeat(indent)
  const declaresSomething = (line: string): boolean => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith('#')
  }
  let end = from
  while (end < lines.length) {
    const line = lines[end] ?? ''
    if (!declaresSomething(line)) {
      const next = lines.slice(end + 1).find(declaresSomething)
      if (next === undefined || !next.startsWith(prefix)) break
      end += 1
      continue
    }
    if (!line.startsWith(prefix)) break
    end += 1
  }
  return end
}

/** The same lines with the named keys, and whatever is nested under them, gone. */
function withoutKeys(
  lines: string[],
  indent: number,
  keys: readonly string[],
): string[] {
  const prefix = ' '.repeat(indent)
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = line.startsWith(prefix)
      ? /^\s*([A-Za-z_][A-Za-z0-9_]*):/u.exec(line)
      : null
    if (
      match &&
      line.slice(0, line.indexOf(match[1] ?? '')).length === indent &&
      keys.includes(match[1] ?? '')
    ) {
      const end = blockEnd(lines, index + 1, indent + 2)
      // The key goes; what the author wrote around it stays. Three kinds of
      // bytes are theirs, not the setting's: a note on the end of the key line,
      // a note nested under it, and the blank lines they left for readability.
      // Only a `#` outside quotes starts a note; one inside a quoted value is
      // part of the value and goes with it.
      const trailing = line.slice(stripInlineComment(line).length).trim()
      if (trailing) kept.push(`${' '.repeat(indent)}${trailing}`)
      kept.push(
        ...lines
          .slice(index + 1, end)
          .filter((nested) => nested.trim().startsWith('#') || nested.trim() === ''),
      )
      index = end - 1
      continue
    }
    kept.push(line)
  }
  return kept
}

/**
 * How the saved stage differs from the shape the build was admitted with, if it
 * does.
 *
 * Every field compared is executable. Order decides what a chain produces and
 * what each discussion participant reads; depth is the round ceiling the engine
 * loops to.
 */
export function stageDiffersFromShape(
  parsed: YamlObject,
  shape: TeamShape,
): string | undefined {
  const stage = generatedSetupStage(parsed)
  if (!stage) return 'it has no generated stage to compare.'
  const type = stringOrUndefined(stage.type)
  if (type !== shape.kind) {
    return `it was admitted as '${shape.kind}' and its stage is '${type ?? 'missing'}'.`
  }
  const config = isObject(stage.config) ? stage.config : {}
  const { rounds } = depthRounds(shape.depth)

  if (shape.kind === 'chain') {
    return sameOrder(parseStringList(stage.sequence), shape.order)
      ? undefined
      : 'its sequence is not the order this build was admitted with.'
  }
  if (shape.kind === 'discussion') {
    if (stringOrUndefined(stage.coordinator) !== shape.coordinator) {
      return `it was admitted with '${shape.coordinator}' leading it.`
    }
    if (!sameOrder(parseStringList(stage.participants), shape.participants)) {
      return 'its participants are not the ones this build was admitted with.'
    }
    return config.max_rounds === rounds
      ? undefined
      : `it was admitted to go ${rounds} round(s).`
  }
  if (stringOrUndefined(stage.producer) !== shape.producer) {
    return `it was admitted with '${shape.producer}' writing.`
  }
  if (stringOrUndefined(stage.reviewer) !== shape.reviewer) {
    return `it was admitted with '${shape.reviewer}' checking.`
  }
  return config.max_iterations === rounds
    ? undefined
    : `it was admitted to allow ${rounds} attempt(s).`
}

/** Whether a saved list is the same names in the same order. */
function sameOrder(saved: readonly string[], expected: readonly string[]): boolean {
  return (
    saved.length === expected.length &&
    saved.every((name, index) => name === expected[index])
  )
}
