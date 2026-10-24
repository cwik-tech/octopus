/**
 * Team Runtime — Template Variable Substitution
 *
 * Centralises the {{KEY}} → value substitution used in coordinator system
 * prompts. Replaces the 18+ individual `replaceAll` calls that were
 * scattered across the `before_agent_start` handler in team-runtime/index.ts.
 *
 * Two exports:
 *   - `substituteTemplateVars`  — low-level: applies an arbitrary vars map
 *   - `buildStandardVars`       — high-level: builds the standard 18-var map
 *                                 from a RuntimeContext
 */

import * as path from 'node:path'
import type { RuntimeContext } from './runtime-context.js'
import { getAssignmentLogPath } from './logger.js'
import {
  getParticipantNames,
  getCoordinatorName,
  getConstraintSummary,
  getOutputFormat,
} from '../../core/stage-helpers.js'
import { getAssignmentPath } from './runtime-paths.js'

// ─── Core Substitution ───────────────────────────────────────────────────────

/**
 * Replace all `{{KEY}}` occurrences in `template` with the corresponding
 * value from `vars`. Keys not present in `vars` are left untouched.
 */
export function substituteTemplateVars(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value)
  }
  return result
}

// ─── Standard Variable Map ───────────────────────────────────────────────────

/**
 * Build the standard template variable map from the current RuntimeContext.
 * Returns an empty object when `teamConfig` is null (extension not yet booted).
 *
 * Variable inventory (18 variables):
 *   SESSION_ID, TEAM_NAME, CURRENT_LEVEL, PARTICIPANTS,
 *   WORKSPACE_PATH, ASSIGNMENT_PATH, CONSTRAINTS,
 *   KNOWLEDGE_BLOCK, EXPERIENCE_BLOCK, SKILLS_BLOCK, INPUT_FILES,
 *   AGENT_ROSTER, AVAILABLE_AGENTS, BOARD_MEMBERS,
 *   AVAILABLE_TEAMS,
 *   OUTPUT_PATH, OUTPUT_MODE, CONTEXT_FILES, TASK_CONTENT,
 *   EXPERIENCE_PATH, DISCUSSION_PATH, MEMO_PATH
 */
export function buildStandardVars(ctx: RuntimeContext): Record<string, string> {
  const { state, teamConfig, inputFilesContent, agents } = ctx

  if (!teamConfig) return {}

  const level = teamConfig.levels[state.currentLevelIndex]
  const availableTeams = [...ctx.teamRegistry.values()]
    .filter((entry) => entry.type === 'team' && entry.name !== teamConfig.team.name)
    .map((entry) => `- **${entry.name}**: ${entry.description ?? 'No description provided.'}`)
    .join('\n')

  // Resolve coordinator — used for knowledge/experience/skills blocks
  const coordName = level ? getCoordinatorName(level) : undefined
  const coordinator = coordName ? agents.get(coordName) : undefined

  const participantNames = getParticipantNames(level)
  const participantList = participantNames.join(', ')
  const workspacePath = teamConfig.workspace.path
  const assignmentPath = getAssignmentPath(ctx)
  const teamRootPath = ctx.teamRoot || process.cwd()
  const templatesPath = path.join(teamRootPath, 'templates')
  const profilesPath = path.join(teamRootPath, 'profiles')
  const styleGuidePath = path.join(teamRootPath, 'style-guide.md')

  // Build the roster block "- **AgentName**: role description"
  // Role data lives on the full AgentRosterEntry in teamConfig.agents,
  // not on the slim RosterEntrySlim stored in ctx.rosterEntries.
  const agentRosterBlock = participantNames
    .map((name) => {
      const fullEntry = teamConfig.agents.find((a) => a.name === name)
      const role = fullEntry?.role ?? 'No role description'
      return `- **${name}**: ${role}`
    })
    .join('\n')

  return {
    // ── Identity ────────────────────────────────────────────────────────
    SESSION_ID:      state.sessionId,
    TEAM_NAME:       teamConfig.team.name,
    CURRENT_LEVEL:   level?.id ?? '',

    // ── Participants ────────────────────────────────────────────────────
    PARTICIPANTS:    participantList,
    AGENT_ROSTER:    agentRosterBlock,
    // Aliases so prompts from different teams work without modification
    AVAILABLE_AGENTS: participantList,
    BOARD_MEMBERS:   participantList,
    AVAILABLE_TEAMS: availableTeams || '_No registered specialist teams._',

    // ── Paths ───────────────────────────────────────────────────────────
    WORKSPACE_PATH:  workspacePath,
    ASSIGNMENT_PATH: assignmentPath,
    OUTPUT_PATH:     assignmentPath,
    EXPERIENCE_PATH: coordinator?.experienceEnabled ? path.join(coordinator.agentDir, 'experience') : '',
    DISCUSSION_PATH: getAssignmentLogPath(assignmentPath, 'conversation.jsonl'),
    MEMO_PATH:       path.join(assignmentPath, getOutputFormat(level)),
    TEAM_ROOT_PATH:  teamRootPath,
    TEMPLATES_PATH:  templatesPath,
    PROFILES_PATH:   profilesPath,
    STYLE_GUIDE_PATH: styleGuidePath,

    // ── Constraints ─────────────────────────────────────────────────────
    CONSTRAINTS:     getConstraintSummary(level),

    // ── Agent content blocks ─────────────────────────────────────────────
    KNOWLEDGE_BLOCK:   coordinator?.knowledgeContent  ?? '_No domain knowledge loaded._',
    EXPERIENCE_BLOCK:  coordinator?.experienceContent ?? '_No experience accumulated yet._',
    SKILLS_BLOCK:      coordinator?.skillsContent     ?? '_No skills loaded._',

    // ── Input / context ──────────────────────────────────────────────────
    INPUT_FILES:    inputFilesContent || '_No input files._',
    CONTEXT_FILES:  inputFilesContent ? 'See INPUT_FILES section' : 'none',

    // ── Misc ────────────────────────────────────────────────────────────
    OUTPUT_MODE:    'orchestration',
    TASK_CONTENT:   '_The user will provide the task in their message._',
    CLIENT_NAME:    '',
    PROJECT_NAME:   '',
  }
}
