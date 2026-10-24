/**
 * Renders `team.yaml` and `teams.yaml` text, and replaces or removes one
 * top-level block in either file.
 *
 * Holds `renderNewTeamYaml`, which writes a new team's whole `team.yaml`, the
 * `team:` and `levels:` block renderers, the roster-entry and stage-body
 * renderers, `renderRegistryBlock` for one `teams.yaml` entry, and the three
 * top-level block edits. The roster-entry and stage-body renderers moved here
 * first, so `team-yaml-addition.ts` and `team-yaml-shape.ts` need not import
 * `team-manager.ts`. The audit's renderer item moved the rest.
 * `team-manager.ts` imports the renderers, the block edits and
 * `GENERATED_TEAM_INPUT_ARTIFACT` back.
 * `team-manager.ts` also imports `collapseText` for `parseRosterAgents`.
 * Nothing here does I/O or imports `team-manager.ts`.
 */

import { whenDefined } from '../../core/optional-properties.js'
import { depthRounds, type TeamShape } from '../../contracts/schemas/team-shape.js'
import type { TeamRosterAgent } from './types.js'
import {
  GENERATED_TEAM_OUTPUT_ARTIFACT,
  GENERATED_TEAM_PROVENANCE,
  GENERATED_TEAM_PROVENANCE_KEY,
  TEAM_BUILDING_KEY,
  TEAM_PUBLISHED_BY_KEY,
} from './team-yaml-ownership.js'
import { readMappingKey } from '../../core/yaml-parser.js'
import {
  ensureTrailingNewline,
  findTopLevelBlock,
  indentWidth,
  stripInlineComment,
  topLevelKey,
  yamlQuoted,
} from './team-yaml-scalars.js'

export const GENERATED_TEAM_INPUT_ARTIFACT = 'incoming-brief.md'

/**
 * One roster entry, exactly as the full-block renderer writes it.
 *
 * Surgical insertion reuses this so an added member reads identically to the
 * members already in the file.
 */
export function renderRosterEntryLines(agent: TeamRosterAgent): string[] {
  const lines = [
    `  - name: ${yamlQuoted(agent.name)}`,
    `    type: ${agent.type}`,
    '    role: >',
    ...blockLines(agent.role || `${agent.name} library agent.`, 6),
    ...(agent.tier === undefined ? [] : [`    tier: ${agent.tier}`]),
    renderStringArray('    tools', agent.tools),
  ]
  if (agent.agent_file) lines.push(`    agent_file: ${yamlQuoted(agent.agent_file)}`)
  if (agent.experience_enabled !== undefined) {
    lines.push(`    experience_enabled: ${agent.experience_enabled ? 'true' : 'false'}`)
  }
  lines.push(...renderArtifactDeclarations('    produces', agent.produces ?? []))
  lines.push(...renderArtifactDeclarations('    consumes', agent.consumes ?? []))
  return lines
}

function renderArtifactDeclarations(
  key: string,
  artifacts: Array<{ path: string; description?: string }>,
): string[] {
  if (artifacts.length === 0) return []
  const lines = [`${key}:`]
  const indent = key.match(/^\s*/)?.[0] ?? ''
  for (const artifact of artifacts) {
    lines.push(`${indent}  - path: ${yamlQuoted(artifact.path)}`)
    if (artifact.description) {
      lines.push(
        `${indent}    description: ${yamlQuoted(artifact.description)}`,
      )
    }
  }
  return lines
}

export function renderStringArray(label: string, values: string[]): string {
  if (values.length === 0) return `${label}: []`
  const indent = (label.match(/^ */)?.[0].length ?? 0) + 2
  const prefix = ' '.repeat(indent)
  return [`${label}:`, ...values.map((value) => `${prefix}- ${yamlQuoted(value)}`)].join('\n')
}

export function blockLines(text: string, indent: number): string[] {
  const collapsed = collapseText(text) || 'No description.'
  const prefix = ' '.repeat(indent)
  return wrapText(collapsed, 76).map((line) => `${prefix}${line}`)
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) current = word
    else if (`${current} ${word}`.length <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['No description.']
}

export function collapseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The stage body of the single `setup` level every generated team runs.
 *
 * `type:` is written for every shape, never inferred. A stage with no `type:`
 * key parses as a discussion (`parsers/stage-parsers.ts:255`), and a discussion
 * with no coordinator is a hard parse error — so an emitter that omits it turns
 * a chain into an unparseable team.
 *
 * `user_review` is written as `false` for the same kind of reason: the parser
 * defaults it to `true` (`stage-parsers.ts:110`), which appends an instruction
 * telling the coordinator to save a draft and wait for an approval that never
 * comes in a workflow run.
 */
export function renderStageBody(
  agents: readonly Pick<TeamRosterAgent, 'name'>[],
  shape?: TeamShape,
): string[] {
  const output = [
    '        output:',
    `          format: ${yamlQuoted(GENERATED_TEAM_OUTPUT_ARTIFACT)}`,
    '          user_review: false',
  ]

  if (!shape || shape.kind === 'chain') {
    // The shape's own order when there is one, and the roster's insertion
    // order only for a team that chose no shape. Membership written from the
    // roster instead is how a chosen order silently became whatever order the
    // agents happened to be added in.
    const sequence = shape ? [...shape.order] : agents.map((agent) => agent.name)
    const lines = ['      type: chain']
    if (sequence.length > 0) {
      lines.push('      sequence:')
      for (const name of sequence) lines.push(`        - ${yamlQuoted(name)}`)
    }
    lines.push('      config:', '        handoff_format: markdown', ...output)
    return lines
  }

  const { rounds } = depthRounds(shape.depth)

  if (shape.kind === 'discussion') {
    return [
      '      type: discussion',
      `      coordinator: ${yamlQuoted(shape.coordinator)}`,
      // The participants the shape chose, in the order it chose. Order is
      // load-bearing: `engines/discussion.ts:790` dispatches them in list
      // order and each one reads what the earlier ones said. The add path then
      // appends only names this list does not already carry.
      '      participants:',
      ...shape.participants.map((name) => `        - ${yamlQuoted(name)}`),
      '      config:',
      '        min_rounds: 1',
      `        max_rounds: ${rounds}`,
      ...output,
    ]
  }

  return [
    '      type: review',
    `      producer: ${yamlQuoted(shape.producer)}`,
    `      reviewer: ${yamlQuoted(shape.reviewer)}`,
    '      config:',
    `        max_iterations: ${rounds}`,
    // Not because `block` leaves the run hanging: both policies set the stage
    // BLOCKED and return (`engines/review.ts:1460-1479`). They differ in what
    // the user is told, and only this one says the run is over, that nothing is
    // waiting for a reply, and that a new run is how to try again.
    // `approve_latest_with_warnings`, which the shipped writing-team uses,
    // publishes a draft no reviewer approved — the exact contradiction of what
    // a review team promises the user.
    '        on_max_iterations: escalate_to_user',
    ...output,
  ]
}

export function renderNewTeamYaml(params: {
  id: string
  description: string
  orchestratorKey?: string
  shape?: TeamShape
  building?: boolean
}): string {
  return ensureTrailingNewline([
    renderTeamMetaBlock({
      id: params.id,
      description: params.description,
      // The one place provenance is created. Every other writer preserves
      // whatever the file already holds, including nothing.
      provenance: GENERATED_TEAM_PROVENANCE,
      ...whenDefined(params.building, (definedValue) => ({ building: definedValue })),
      ...whenDefined(params.orchestratorKey, (definedValue) => ({ orchestratorKey: definedValue })),
    }),
    '',
    'workspace:',
    '  path: ../../workspace',
    '  watch: false',
    '',
    'workflow:',
    '  entry_level: setup',
    '  invocation_modes:',
    '    - user',
    '    - team',
    '  user_facing: true',
    '  input_contract:',
    '    artifacts:',
    `      - path: ${yamlQuoted(GENERATED_TEAM_INPUT_ARTIFACT)}`,
    '        required: true',
    '        description: Runtime brief for the generated team.',
    '  output_contract:',
    '    artifacts:',
    `      - path: ${yamlQuoted(GENERATED_TEAM_OUTPUT_ARTIFACT)}`,
    '        required: true',
    '        description: Final result produced by the generated team.',
    `    completion_artifact: ${yamlQuoted(GENERATED_TEAM_OUTPUT_ARTIFACT)}`,
    '',
    'agents: []',
    '',
    renderLevelsBlock([], params.shape),
    '',
    'gates:',
    '  - from: setup',
    '    to: done',
    '    condition:',
    '      type: artifact_exists',
    `      artifact: ${yamlQuoted(GENERATED_TEAM_OUTPUT_ARTIFACT)}`,
  ].join('\n'))
}

export function renderTeamMetaBlock(params: {
  id: string
  description: string
  orchestratorKey?: string
  /** What the file records about who authored it. Absent means nothing. */
  provenance?: string
  /** Whether the build that owns this team has still to finish. */
  building?: boolean
  /** The build that published it, once one has. */
  publishedBy?: string
}): string {
  const lines = [
    'team:',
    `  name: ${yamlQuoted(params.id)}`,
    '  description: >',
    ...blockLines(params.description, 4),
    `  version: ${yamlQuoted('0.1.0')}`,
  ]
  // Recorded at creation, and carried over by every later writer. Re-rendering
  // this block unconditionally would mint the marker on a file this app never
  // authored, and the very next removal would rewrite that file's ownership —
  // so the caller states what the file already says rather than assuming.
  if (params.provenance) {
    lines.push(
      `  ${GENERATED_TEAM_PROVENANCE_KEY}: ${yamlQuoted(params.provenance)}`,
    )
  }
  // Written only while a build owns this team. Cleared by removing the line, so
  // a finished team looks exactly like one that was never built by a job.
  if (params.building) lines.push(`  ${TEAM_BUILDING_KEY}: true`)
  if (params.publishedBy) {
    lines.push(`  ${TEAM_PUBLISHED_BY_KEY}: ${yamlQuoted(params.publishedBy)}`)
  }
  if (params.orchestratorKey) {
    lines.push(`  created_by_orchestrator: ${yamlQuoted(params.orchestratorKey)}`)
  }
  return lines.join('\n')
}

/**
 * The `levels:` block for a generated team's single setup stage.
 *
 * Takes names alone, because names alone is what it writes: the sequence, the
 * participants and the two review roles. Asking for whole roster entries made
 * callers that hold only names assert a type they did not have.
 */
export function renderLevelsBlock(
  agents: readonly Pick<TeamRosterAgent, 'name'>[],
  shape?: TeamShape,
): string {
  const lines = [
    'levels:',
    '  - id: setup',
    '    name: Setup',
    '    order: 0',
    '    stage:',
    ...renderStageBody(agents, shape),
  ]
  return lines.join('\n')
}

export function renderRegistryBlock(params: {
  id: string
  description: string
  tags: string[]
  teamPath: string
  inputArtifact?: string
  outputArtifact?: string
  hostModel?: string
  hostProvider?: string
}): string {
  const lines = [
    `${params.id}:`,
    '  type: team',
    `  description: ${yamlQuoted(params.description)}`,
    `  team_path: ${yamlQuoted(params.teamPath)}`,
  ]
  if (params.inputArtifact) lines.push(`  input_artifact: ${yamlQuoted(params.inputArtifact)}`)
  if (params.outputArtifact) lines.push(`  output_artifact: ${yamlQuoted(params.outputArtifact)}`)
  if (params.hostModel) lines.push(`  host_model: ${yamlQuoted(params.hostModel)}`)
  if (params.hostProvider) lines.push(`  host_provider: ${yamlQuoted(params.hostProvider)}`)
  lines.push(renderStringArray('  tags', params.tags))
  return lines.join('\n')
}

export function replaceOrAppendTopLevelBlock(yaml: string, key: string, block: string): string {
  const removed = removeTopLevelBlock(yaml, key)
  const lines = removed.split('\n')
  const trimmedBlock = block.trimEnd()
  if (yaml.split('\n').some((line) => topLevelKey(line) === key)) {
    return upsertTopLevelBlock(yaml, key, trimmedBlock)
  }
  while (lines.length > 0) {
    const lastLine = lines.at(-1)
    if (lastLine === undefined || lastLine.trim() !== '') break
    lines.pop()
  }
  return [...lines, '', trimmedBlock].join('\n')
}

export function upsertTopLevelBlock(yaml: string, key: string, block: string): string {
  if (!yaml.trim()) return block
  const lines = yaml.split('\n')
  const range = findTopLevelBlock(lines, key)
  if (!range) {
    while (lines.length > 0) {
      const lastLine = lines.at(-1)
      if (lastLine === undefined || lastLine.trim() !== '') break
      lines.pop()
    }
    return [...lines, '', block.trimEnd()].join('\n')
  }
  return [
    ...lines.slice(0, range.start),
    block.trimEnd(),
    ...lines.slice(firstKeptTrailingComment(lines, range)),
  ].join('\n')
}

/**
 * Where the replaced range really ends: at the first column-zero comment of
 * the blank-and-comment run that closes it, or at the range's end when the
 * run holds no comment.
 *
 * `findTopLevelBlock` counts that run as the block's, but a comment written
 * at the margin just before the next key is about that key, and replacing the
 * block used to delete it. The blank lines before that comment still go with
 * the block, as they always have.
 */
function firstKeptTrailingComment(
  lines: readonly string[],
  range: { start: number; end: number },
): number {
  let runStart = range.end
  while (runStart > range.start + 1) {
    const line = lines[runStart - 1] ?? ''
    if (line.trim() !== '' && !line.startsWith('#')) break
    runStart -= 1
  }
  for (let index = runStart; index < range.end; index += 1) {
    if ((lines[index] ?? '').startsWith('#')) return index
  }
  return range.end
}

export function removeTopLevelBlock(yaml: string, key: string): string {
  const lines = yaml.split('\n')
  const range = findTopLevelBlock(lines, key)
  if (!range) return yaml
  const next = [...lines.slice(0, range.start), ...lines.slice(range.end)]
  return collapseBlankRunsOutsideBlockScalars(next).join('\n').trimEnd()
}

/**
 * Collapses runs of empty lines as a registry removal always has, except
 * inside a block scalar.
 *
 * Outside one, two or more empty lines become one (at the very start of the
 * file, three or more become two), exactly as replacing three or more
 * newlines with two did. Inside a `|` or `>` scalar a blank line is part of
 * the value: the parser keeps a block body's interior blank lines, so
 * collapsing them there changed another entry's description. A body is what
 * the parser reads as one: the lines after the key that are blank or indented
 * deeper than it.
 */
function collapseBlankRunsOutsideBlockScalars(lines: readonly string[]): string[] {
  const kept: string[] = []
  let blockKeyIndent: number | null = null
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line !== '') {
      if (line.trim() !== '') {
        const indent = indentWidth(line)
        if (blockKeyIndent === null || indent <= blockKeyIndent) {
          blockKeyIndent = opensBlockScalar(line) ? indent : null
        }
      }
      kept.push(line)
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && lines[end] === '') end += 1
    const run = end - index
    const nextContent = lines.slice(end).find((candidate) => candidate.trim() !== '')
    const insideBlock = blockKeyIndent !== null &&
      nextContent !== undefined &&
      indentWidth(nextContent) > blockKeyIndent
    const keep = insideBlock ? run : Math.min(run, index === 0 ? 2 : 1)
    for (let count = 0; count < keep; count += 1) kept.push('')
    index = end
  }
  return kept
}

/** Whether a line's key opens a literal or folded block scalar the parser reads. */
function opensBlockScalar(line: string): boolean {
  const content = line.trimStart().replace(/^- /u, '')
  const mapping = readMappingKey(content)
  if (!mapping) return false
  const value = stripInlineComment(content.slice(mapping.colonIndex + 1)).trim()
  return value === '|' || value === '|-' || value === '>' || value === '>-'
}
