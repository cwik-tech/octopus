/**
 * Agent Skills specification checks (https://agentskills.io/specification) as a
 * production module.
 *
 * This is the single source of truth for skill conformance. The repository
 * scan in `tests/unit/skill-spec-conformance.test.ts` and every path that
 * publishes a generated `SKILL.md` call the same functions, so a rule can no
 * longer pass in the test suite and be skipped at publication time.
 */

import { parseYaml } from '../../core/yaml-parser.js'

export const SKILL_SPEC_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_SPEC_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
])
export const SKILL_SPEC_MAX_NAME_LENGTH = 64
export const SKILL_SPEC_MAX_DESCRIPTION_LENGTH = 1024
export const SKILL_SPEC_MAX_COMPATIBILITY_LENGTH = 500
export const SKILL_SPEC_MAX_BODY_LINES = 500

export interface SkillSpecViolation {
  /** Where the offending skill lives, for a message a reader can act on. */
  skillPath: string
  problem: string
}

/** Raised when a publication would write a non-conformant `SKILL.md`. */
export class SkillSpecViolationError extends Error {
  constructor(readonly violations: readonly SkillSpecViolation[]) {
    super(
      `Skill does not satisfy the Agent Skills specification: ${
        violations
          .map((violation) => `${violation.skillPath}: ${violation.problem}`)
          .join('; ')
      }`,
    )
    this.name = 'SkillSpecViolationError'
  }
}

export function findSkillSpecViolations(params: {
  source: string
  folderName: string
  skillPath: string
}): SkillSpecViolation[] {
  const violations: SkillSpecViolation[] = []
  const add = (problem: string): void => {
    violations.push({ skillPath: params.skillPath, problem })
  }

  const match = params.source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) {
    add('SKILL.md has no YAML frontmatter block')
    return violations
  }

  const [, frontmatterSource = '', body = ''] = match
  let frontmatter: Record<string, unknown>
  try {
    frontmatter = parseYaml(frontmatterSource)
  } catch (error) {
    add(`frontmatter is not valid YAML: ${String(error)}`)
    return violations
  }

  const name = requiredString(frontmatter, 'name', add)
  const description = requiredString(frontmatter, 'description', add)

  if (name !== null) {
    // The declared name exactly as it is written. Trimming it first would let a
    // quoted `name: " contract-review "` pass as exact kebab and match a folder
    // it does not actually name.
    if (!name) add('frontmatter is missing a `name`')
    else if (!SKILL_SPEC_NAME_PATTERN.test(name)) {
      add(
        `\`name: ${name}\` must be lowercase kebab-case without leading, trailing, or doubled hyphens`,
      )
    } else if (name.length > SKILL_SPEC_MAX_NAME_LENGTH) {
      add(`\`name\` is ${name.length} chars, over the ${SKILL_SPEC_MAX_NAME_LENGTH}-char limit`)
    }
    if (name && name !== params.folderName) {
      add(`\`name: ${name}\` does not match the folder name \`${params.folderName}\``)
    }
  }

  if (description !== null) {
    // Measured as declared. Collapsing runs of whitespace before counting lets
    // a description far over the limit through, and the text a host has to hold
    // is the text that is written, not a tidied version of it. Whitespace is
    // still what decides whether anything was said at all.
    if (!description.trim()) add('frontmatter is missing a `description`')
    else if (description.length > SKILL_SPEC_MAX_DESCRIPTION_LENGTH) {
      add(
        `\`description\` is ${description.length} chars, over the ${SKILL_SPEC_MAX_DESCRIPTION_LENGTH}-char limit`,
      )
    }
  }

  for (const key of Object.keys(frontmatter)) {
    if (!SKILL_SPEC_FRONTMATTER_KEYS.has(key)) {
      add(`\`${key}\` is not a frontmatter key defined by the spec`)
    }
  }

  optionalString(frontmatter, 'license', add)
  const compatibility = optionalString(frontmatter, 'compatibility', add)
  if (compatibility !== null && compatibility !== undefined) {
    // Optional, but 1-500 characters when it is there: an empty string declares
    // a compatibility and states nothing.
    if (compatibility.length === 0) add('`compatibility` is present but empty')
    else if (compatibility.length > SKILL_SPEC_MAX_COMPATIBILITY_LENGTH) {
      add(
        `\`compatibility\` is ${compatibility.length} chars, over the ${SKILL_SPEC_MAX_COMPATIBILITY_LENGTH}-char limit`,
      )
    }
  }
  // `allowed-tools` is one space-separated string. This repository's YAML
  // reader hands back an array for the list form, which a spec reader would
  // reject, so the shape is checked rather than accepted.
  optionalString(frontmatter, 'allowed-tools', add)
  checkMetadata(frontmatter, add)
  checkDescriptionScalar(frontmatterSource, add)

  const bodyLines = body.split('\n').length
  if (bodyLines > SKILL_SPEC_MAX_BODY_LINES) {
    add(`body is ${bodyLines} lines, over the ${SKILL_SPEC_MAX_BODY_LINES}-line limit`)
  }

  return violations
}

/** A required string field, or `null` when it is absent or the wrong type. */
function requiredString(
  frontmatter: Record<string, unknown>,
  key: string,
  add: (problem: string) => void,
): string | null {
  const value = frontmatter[key]
  if (value === undefined) {
    add(`frontmatter is missing a \`${key}\``)
    return null
  }
  if (typeof value !== 'string') {
    add(`\`${key}\` must be a string, not ${describeType(value)}`)
    return null
  }
  return value
}

/** An optional string field: `undefined` when absent, `null` when ill-typed. */
function optionalString(
  frontmatter: Record<string, unknown>,
  key: string,
  add: (problem: string) => void,
): string | null | undefined {
  const value = frontmatter[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    add(`\`${key}\` must be a string, not ${describeType(value)}`)
    return null
  }
  return value
}

/** `metadata` is a map of string keys to string values, or absent. */
function checkMetadata(
  frontmatter: Record<string, unknown>,
  add: (problem: string) => void,
): void {
  const value = frontmatter.metadata
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add(`\`metadata\` must be a map of string keys to string values, not ${describeType(value)}`)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      add(`\`metadata.${key}\` must be a string, not ${describeType(entry)}`)
    }
  }
}

/**
 * A description carrying `: ` has to be a folded block scalar.
 *
 * This repository's YAML reader splits on the first `: ` and hands back the
 * rest as a string, so an inline description with a colon in it parses here and
 * fails wherever the skill is actually loaded. The rule is therefore checked
 * against the frontmatter text rather than discovered from the parse.
 *
 * A quoted scalar and a literal `|` block both parse here, and both are
 * rejected: the project rule names the folded form, and letting other spellings
 * through would mean the rule everyone is told is not the rule enforced. What
 * is accepted is the folded indicators this reader actually opens — `>` and
 * `>-`, each alone on its line with the text indented beneath. `>+` and `>`
 * followed by text on the same line open no block at all here, so they are
 * refused with the rest.
 */
const FOLDED_DESCRIPTION_RULE =
  '`description` contains `: ` and must be a folded block scalar (`description: >` or `description: >-`, alone on its line with the text indented beneath), or the frontmatter does not parse as YAML'

function checkDescriptionScalar(
  frontmatterSource: string,
  add: (problem: string) => void,
): void {
  for (const line of frontmatterSource.split('\n')) {
    const inline = line.match(/^description:(.*)$/)?.[1]
    if (inline === undefined) continue
    const value = inline.trim()
    if (!value) return
    // Only the indicator on its own opens a block. `> text` is not a folded
    // scalar: this reader stores the literal `> text` string. `>+` is not a
    // form it opens either — it hands back the indicator as the description,
    // and the prose beneath it is lost.
    if (value === '>' || value === '>-') return
    if (value === '|' || value === '|-') {
      if (blockScalarBody(frontmatterSource).includes(': ')) add(FOLDED_DESCRIPTION_RULE)
      return
    }
    if (value.startsWith('>') || value.startsWith('|')) {
      add(
        `\`description: ${value}\` opens no block: the folded forms this frontmatter reader supports are \`>\` and \`>-\`, each alone on its line with the text indented beneath`,
      )
      return
    }
    if (value.includes(': ')) add(FOLDED_DESCRIPTION_RULE)
    return
  }
}

/** The indented lines under a `description:` block, as one string. */
function blockScalarBody(frontmatterSource: string): string {
  const lines = frontmatterSource.split('\n')
  const start = lines.findIndex((line) => /^description:/.test(line))
  if (start < 0) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  return `a ${typeof value}`
}

/** Where a skill about to be published comes from. */
export type SkillPublicationOrigin = 'imported' | 'generated'

/** One skill a publication is about to write, already read from its source. */
export interface SkillPublicationSource {
  origin: SkillPublicationOrigin
  /** The folder this skill will own inside the Agent's `skills/`. */
  folderName: string
  /** The exact `SKILL.md` bytes, or `null` when the source has none. */
  source: string | null
  /** Where the problem is, for a message a reader can act on. */
  skillPath: string
}

/**
 * Every violation in one publication, including the ones no single skill can
 * see.
 *
 * Two skills claiming one folder is such a violation. Copying the imported one
 * and then writing the generated one over it leaves a single folder holding
 * another skill's supporting files, which is neither of the two skills the
 * batch described. Checking the combined batch is the only place that is
 * visible.
 */
export function findSkillBatchViolations(
  sources: readonly SkillPublicationSource[],
): SkillSpecViolation[] {
  const violations: SkillSpecViolation[] = []
  const claimedBy = new Map<string, SkillPublicationOrigin>()
  for (const skill of sources) {
    // The exact string, never a trimmed one. A name validated after trimming
    // and then published untrimmed is a folder nothing checked.
    const folderName = skill.folderName
    if (!folderName) {
      violations.push({ skillPath: skill.skillPath, problem: 'the skill has no folder name' })
      continue
    }
    if (!SKILL_SPEC_NAME_PATTERN.test(folderName)) {
      violations.push({
        skillPath: skill.skillPath,
        problem: `folder name \`${folderName}\` must be lowercase kebab-case without leading, trailing, or doubled hyphens`,
      })
    } else if (folderName.length > SKILL_SPEC_MAX_NAME_LENGTH) {
      violations.push({
        skillPath: skill.skillPath,
        problem: `folder name is ${folderName.length} chars, over the ${SKILL_SPEC_MAX_NAME_LENGTH}-char limit`,
      })
    }
    if (skill.source === null) {
      violations.push({
        skillPath: skill.skillPath,
        problem: 'there is no SKILL.md to publish',
      })
    } else {
      violations.push(
        ...findSkillSpecViolations({
          source: skill.source,
          folderName,
          skillPath: skill.skillPath,
        }),
        ...findActivationViolations(skill.source, skill.skillPath),
      )
    }
    const claimed = claimedBy.get(folderName)
    if (claimed === undefined) {
      claimedBy.set(folderName, skill.origin)
      continue
    }
    violations.push({
      skillPath: skill.skillPath,
      problem: `skill folder \`${folderName}\` is claimed twice in one Agent, by ${claimed === skill.origin ? `two ${claimed} skills` : `an ${claimed} and a ${skill.origin} skill`}`,
    })
  }
  return violations
}

/**
 * Whether a description says when to use the skill, not only what it is about.
 *
 * `name` and `description` are the only text a host holds for every installed
 * skill, so the description carries the whole activation decision.
 * `Method for market sizing.` names a subject and gives an agent nothing to
 * match on: the skill installs and never fires.
 *
 * This rule belongs to publication, not to the structural checks the
 * repository scan runs. The catalog already holds skills written before it
 * existed and those stay as they are; what this repository publishes from
 * today has to earn its place in the startup context.
 */
const ACTIVATION_CUE = /\buse\s+(when|this|it|for|after|before)\b|\bwhen\b|\btrigger|\bactivate/i

function findActivationViolations(
  source: string,
  skillPath: string,
): SkillSpecViolation[] {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) return []
  let frontmatter: Record<string, unknown>
  try {
    frontmatter = parseYaml(match[1] ?? '')
  } catch {
    return []
  }
  const description = frontmatter.description
  // Anything ill-formed here is already a violation the structural checks
  // reported, and saying it twice helps nobody.
  if (typeof description !== 'string' || description.trim().length === 0) return []
  if (ACTIVATION_CUE.test(description)) return []
  return [{
    skillPath,
    problem:
      '`description` says what the skill is about but not when to use it; add the situations that should trigger it, such as a "Use when …" clause',
  }]
}

/** Throws before any file is written when a publication breaks the spec. */
export function assertSkillBatchConforms(
  sources: readonly SkillPublicationSource[],
): void {
  const violations = findSkillBatchViolations(sources)
  if (violations.length > 0) throw new SkillSpecViolationError(violations)
}
