/**
 * Team Runtime — Constraint Enforcement
 *
 * Time and budget bounds on levels and teams.
 * Tracks elapsed time and accumulated API cost, warns when limits approach,
 * and formats status summaries for injection into tool results.
 *
 * Extracted from CMO-crew's constraint checking logic.
 */

import type { ConstraintConfig, ConstraintStatus } from './types.js'

/**
 * Check current constraint status against configured limits.
 * Pass endTime to freeze elapsed time (e.g. after assignment completion).
 */
export function checkConstraints(
  config: ConstraintConfig,
  startTime: number,
  totalCost: number,
  endTime?: number | null,
): ConstraintStatus {
  const now = endTime ?? Date.now()
  const elapsedMinutes = startTime > 0 ? (now - startTime) / 60000 : 0
  const timeRemaining = config.max_time_minutes - elapsedMinutes
  const budgetRemaining = config.max_budget_usd - totalCost

  return {
    elapsedMinutes,
    budgetSpent: totalCost,
    timeRemaining,
    budgetRemaining,
    timeWarning: timeRemaining <= 1,
    budgetWarning: budgetRemaining <= 1,
  }
}

/**
 * Format elapsed time as "X.Y min".
 * Pass endTime to freeze elapsed time (e.g. after assignment completion).
 */
export function formatElapsed(startTime: number, endTime?: number | null): string {
  if (startTime === 0) return '0.0 min'
  const now = endTime ?? Date.now()
  const elapsed = (now - startTime) / 60000
  return `${elapsed.toFixed(1)} min`
}

/**
 * Format pre-computed elapsed milliseconds as "X.Y min".
 */
export function formatElapsedMs(ms: number): string {
  return `${(ms / 60000).toFixed(1)} min`
}

/**
 * Format a dollar cost as "$X.YY".
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`
}

/**
 * Format token count with K/M suffixes.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Build a constraint status string suitable for injection into tool results.
 * Includes warnings when limits are approached and mandatory action instructions
 * when limits are hit.
 */
export function formatConstraintStatus(
  status: ConstraintStatus,
  config: ConstraintConfig,
  round: number,
  memoPath: string,
  userReview: boolean = true,
): string {
  let text =
    `\n\n---\n**Constraint Status:**\n` +
    `- Time: ${status.elapsedMinutes.toFixed(1)} min elapsed / ${config.max_time_minutes} min max` +
    (status.timeWarning ? ' \u26a0\ufe0f NEAR LIMIT' : '') +
    `\n- Budget: ${formatCost(status.budgetSpent)} spent / $${config.max_budget_usd} max` +
    (status.budgetWarning ? ' \u26a0\ufe0f NEAR LIMIT' : '') +
    `\n- Round: ${round}` +
    `\n- Output path: \`${memoPath}\``

  if (status.timeWarning || status.budgetWarning) {
    text +=
      `\n\n**MANDATORY: WRITE THE OUTPUT NOW.**\n` +
      `Constraints are hit` +
      (status.timeWarning ? ' (time nearly up)' : '') +
      (status.budgetWarning ? ' (budget nearly exhausted)' : '') +
      `. Do NOT call the tool again. Your IMMEDIATE next action must be:\n` +
      `1. Use the \`write\` tool to save the output to \`${memoPath}\`.\n` +
      `Do not respond to the user first \u2014 write the output file first.`
  } else if (userReview) {
    const draftPath = memoPath.replace(/\.md$/, '-draft.md')
    text +=
      `\n\n**Reminder:** When you are done deliberating:\n` +
      `1. Use the \`write\` tool to save your DRAFT to \`${draftPath}\`.\n` +
      `2. Present the draft to the user and ask if they have feedback or changes.\n` +
      `3. Only after the user approves (or you incorporate their feedback), use the \`write\` tool to save the final version to \`${memoPath}\`.`
  } else {
    text +=
      `\n\n**Reminder:** When you are done, you MUST use the \`write\` tool to save the final output to \`${memoPath}\`. Do not skip this step.`
  }

  return text
}
