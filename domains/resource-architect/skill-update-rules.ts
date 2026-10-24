/**
 * Structural rules every `update_agent_skills` operation must satisfy.
 *
 * These say nothing about the repository — only whether the operation is a
 * coherent instruction at all. They are shared deliberately: a proposal is
 * refused with the message these return, and a plan read back from disk that
 * breaks any of them is simply not a plan. Without one source, a hand-edited
 * or partially written plan file could reach the executor carrying a skill
 * name the proposal boundary would never have accepted.
 */

import * as path from 'node:path'

import type { ResourceSkillUpdate } from '../../contracts/resource-architect.js'
import { assertExactAgentId } from '../agent-generator/agent-revision.js'
import {
  SKILL_SPEC_MAX_NAME_LENGTH,
  SKILL_SPEC_NAME_PATTERN,
} from '../agent-generator/skill-spec-validation.js'

/** The file one skill action writes, relative to the Agent package. */
export const SKILL_DOCUMENT_FILENAME = 'SKILL.md'

/**
 * The first structural rule these skill actions break, or `null`.
 *
 * Returned rather than thrown because the two callers answer differently: the
 * proposal boundary reports the message to the user, and the persisted-plan
 * parser reports that the file does not describe a plan.
 */
export function findSkillUpdateStructureViolation(
  skillUpdates: readonly ResourceSkillUpdate[],
): string | null {
  if (skillUpdates.length === 0) {
    return 'A skill update operation must change at least one skill'
  }
  const seen = new Set<string>()
  for (const update of skillUpdates) {
    if (update.action !== 'create' && update.action !== 'update') {
      return `A skill action must be create or update, not '${String(update.action)}'`
    }
    const nameViolation = findSkillNameViolation(update.name)
    if (nameViolation) return nameViolation
    if (seen.has(update.name)) {
      return `Duplicate skill in one update operation: ${update.name}`
    }
    seen.add(update.name)
    if (update.instruction.trim().length === 0) {
      return `Skill '${update.name}' has no instruction to author it from`
    }
  }
  return null
}

/**
 * Why this is not an exact skill folder name, or `null`.
 *
 * The name is both the folder a file is written into and the `name` its
 * frontmatter must carry, so it is validated exactly as written. Trimming it
 * first would validate one string and publish another.
 */
export function findSkillNameViolation(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) {
    return 'A skill name is required'
  }
  if (!SKILL_SPEC_NAME_PATTERN.test(name)) {
    return `Skill name '${name}' must be lowercase kebab-case without leading, trailing, or doubled hyphens`
  }
  if (name.length > SKILL_SPEC_MAX_NAME_LENGTH) {
    return `Skill name '${name}' is ${name.length} chars, over the ${SKILL_SPEC_MAX_NAME_LENGTH}-char limit`
  }
  // The pattern already excludes separators and dots. The containment check is
  // stated anyway, because it is the property that actually matters and a
  // future loosening of the pattern must not silently loosen this with it.
  if (name !== path.basename(name) || path.isAbsolute(name) || name.includes('..')) {
    return `Skill name '${name}' would not stay inside the Agent's skills folder`
  }
  return null
}

/**
 * Absolute path of one skill folder, refusing anything that leaves `skills/`.
 *
 * Both halves of the path are checked. A well-formed skill name under an
 * aliased Agent id — `elsewhere/../michigan-contract-lawyer`, or the same name
 * with a trailing separator — still resolves to a real package, and treating
 * two spellings as two targets would mean two revisions and two locks over one
 * set of files.
 *
 * Path math only: no file is read here, so the same containment rule holds in
 * the pure policy and in the executor that writes.
 */
export function agentSkillFolderPath(params: {
  repoRoot: string
  agentId: string
  skillName: string
}): string {
  const agentId = assertExactAgentId(params.agentId)
  const violation = findSkillNameViolation(params.skillName)
  if (violation) throw new Error(violation)
  const skillsRoot = path.resolve(params.repoRoot, 'agents', agentId, 'skills')
  const resolved = path.resolve(skillsRoot, params.skillName)
  if (path.dirname(resolved) !== skillsRoot) {
    throw new Error(
      `Skill '${params.skillName}' would not stay inside agents/${agentId}/skills`,
    )
  }
  return resolved
}

/** Package-relative posix path of the document one skill action writes. */
export function skillDocumentRelativePath(skillName: string): string {
  const violation = findSkillNameViolation(skillName)
  if (violation) throw new Error(violation)
  return `skills/${skillName}/${SKILL_DOCUMENT_FILENAME}`
}
