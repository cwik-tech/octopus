/**
 * Team Runtime — Stage Helpers
 *
 * Pure functions of LevelConfig — they take a level config and return a
 * value. No side effects, no closure dependencies, no imports from parsers/.
 *
 * These were originally module-level helpers at the bottom of team-runtime/index.ts.
 * Extracted here so that level-lifecycle.ts, prompt-builder.ts, and other
 * extracted modules can import them without pulling in all of team-runtime/index.ts.
 */

import type { LevelConfig } from './types.js'
import { STAGE_TYPE } from './constants.js'

export function resolveEntryLevelIndex(
  levels: readonly { id: string }[],
  entryLevelId?: string,
): number {
  if (!entryLevelId) return 0
  const entryLevelIndex = levels.findIndex((level) => level.id === entryLevelId)
  return entryLevelIndex >= 0 ? entryLevelIndex : 0
}

// ─── Participant Helpers ─────────────────────────────────────────────────────

/**
 * Return the names of all participants for the given level.
 * Returns an empty array if level is undefined.
 */
export function getParticipantNames(level: LevelConfig | undefined): string[] {
  if (!level) return []
  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:    return []
    case STAGE_TYPE.DISCUSSION: return level.stage.participants
    case STAGE_TYPE.PIPELINE:   return level.stage.participants ?? []
    case STAGE_TYPE.CHAIN:      return level.stage.sequence
    case STAGE_TYPE.BROADCAST:  return level.stage.fan_out
    case STAGE_TYPE.REVIEW:     return [level.stage.producer, level.stage.reviewer]
  }
}

// ─── Coordinator Helper ──────────────────────────────────────────────────────

/**
 * Return the coordinator name for the given level.
 *
 * Stages that use coordinators expose the same `coordinator` field.
 * A type assertion is used here rather than adding `coordinator` to the base
 * StageConfig union (which would require modifying types.ts prematurely).
 */
export function getCoordinatorName(level: LevelConfig): string | undefined {
  return (level.stage as { coordinator?: string }).coordinator
}

// ─── Constraint Helpers ──────────────────────────────────────────────────────

/**
 * Return a human-readable constraints summary for the given level, e.g.
 * "Time: 30 min; Advisory budget guidance: $5 (budget not runtime-enforced)".
 * Returns "No constraints configured" if the level has no constraints.
 *
 * The advisory qualifier is load-bearing, and it is scoped to **budget only**.
 * This string is substituted into a coordinator's system prompt as
 * `{{CONSTRAINTS}}`, so each half has to be accurate:
 *
 * - `max_time_minutes` **is** consumed. `team-runtime/index.ts:1590-1593` passes
 *   it to `runAgent` as `timeoutMinutes` for the delegated routing coordinator,
 *   and `core/constraints.ts:25`, `:86` use it for the time-remaining warning.
 *   Calling it unenforced would be the opposite error.
 * - `max_budget_usd` has no enforcement path at all. The removed
 *   `enforce`/`on_exceed` keys never had a runtime consumer, so stating a bare
 *   budget told the model it would be cut off at that figure, which was false.
 */
export function getConstraintSummary(level: LevelConfig | undefined): string {
  if (!level) return 'No constraints configured'

  const constraints = (
    level.stage.config as { constraints?: { max_time_minutes: number; max_budget_usd: number } }
  ).constraints

  if (!constraints) return 'No constraints configured'
  return (
    `Time: ${constraints.max_time_minutes} min; ` +
    `Advisory budget guidance: $${constraints.max_budget_usd} ` +
    `(budget not runtime-enforced)`
  )
}

/**
 * Return the active constraints for the given level as numbers, or null if
 * the level has no constraints. Suitable for progress-bar calculations.
 */
export function getCurrentConstraints(
  level: LevelConfig | undefined,
): { maxTime: number; maxBudget: number } | null {
  if (!level) return null

  const constraints = (
    level.stage.config as { constraints?: { max_time_minutes: number; max_budget_usd: number } }
  ).constraints

  if (!constraints) return null
  return {
    maxTime: constraints.max_time_minutes,
    maxBudget: constraints.max_budget_usd,
  }
}

// ─── Output Format Helper ────────────────────────────────────────────────────

/**
 * Return the output artifact filename / format string for the given level.
 * Pipeline stages do not produce a single output artifact, so "report.md" is
 * returned as a safe fallback.
 */
export function getOutputFormat(level: LevelConfig | undefined): string {
  if (!level) return 'report.md'
  // Pipeline has no single output artifact
  if (level.stage.type === STAGE_TYPE.PIPELINE) return 'report.md'
  // All other stage types expose config.output.format
  return (level.stage.config as { output: { format: string } }).output.format
}
