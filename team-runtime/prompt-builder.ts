/**
 * Team Runtime — Coordinator Prompt Builder
 *
 * Extracts the `before_agent_start` prompt assembly logic from `index.ts`.
 * Builds the fully-substituted system prompt for the coordinator agent by:
 *   1. Constructing the template variable map from RuntimeContext
 *   2. Calling `substituteTemplateVars` from `domains/runtime/template.ts`
 *   3. Appending the agent-selection protocol block for discussion stages
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import type { LevelConfig, LoadedAgent } from '../core/types.js'
import { STAGE_TYPE } from '../core/constants.js'
import { substituteTemplateVars } from '../domains/runtime/template.js'
import {
  getParticipantNames,
  getConstraintSummary,
  getOutputFormat,
} from '../core/stage-helpers.js'
import { TEAM_CHAT_ROSTER_SIZE_GUIDELINE } from '../core/team-chat-roster-policy.js'
import type { RuntimeContext } from '../domains/runtime/runtime-context.js'
import { getAssignmentLogPath } from '../domains/runtime/logger.js'
import {
  buildToolPolicyBlock,
  formatAllowedTools,
  resolveCoordinatorAllowedTools,
  resolveGrantedGovernedFileTools,
} from '../core/tool-policy.js'
import { getAssignmentPath } from '../domains/runtime/runtime-paths.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Build the fully-substituted system prompt for the coordinator agent.
 *
 * Combines:
 *   • The Pi framework's base system prompt (`eventSystemPrompt`)
 *   • The coordinator's agent.md body with all `{{VARIABLE}}` placeholders replaced
 *   • An injected agent-selection protocol block (discussion stages only)
 *
 * @param eventSystemPrompt  Base system prompt injected by the Pi framework
 * @param coordinator        The resolved coordinator LoadedAgent for the current level
 * @param level              Current level config (undefined if no level is active)
 * @param ctx                Runtime context (state, teamConfig, teamRoot, etc.)
 * @returns The complete `systemPrompt` string to return from `before_agent_start`
 */
export function buildCoordinatorPrompt(
  eventSystemPrompt: string,
  coordinator: LoadedAgent,
  level: LevelConfig | undefined,
  ctx: RuntimeContext,
): string {
  const teamConfig = ctx.teamConfig
  if (!teamConfig) throw new Error('Cannot build the coordinator prompt before the team config is loaded')
  const workspacePath = resolveWorkspacePath(ctx)
  const assignmentPath = getAssignmentPath(ctx)
  const coordinatorOutputArtifactPath = resolveCoordinatorOutputArtifactPath(level, assignmentPath)
  const teamRootPath = ctx.teamRoot || process.cwd()
  const templatesPath = path.join(teamRootPath, 'templates')
  const profilesPath = path.join(teamRootPath, 'profiles')
  const styleGuidePath = path.join(teamRootPath, 'style-guide.md')
  const participantNames = getParticipantNames(level)
  const participantList = participantNames.join(', ')
  const availableTeamsList = [...ctx.teamRegistry.values()]
    .filter((entry) => entry.type === 'team' && entry.name !== teamConfig.team.name)
    .map((entry) => `- **${entry.name}**: ${entry.description ?? 'No description provided.'}`)
    .join('\n')
  const availableWorkflowsList = [...ctx.workflowRegistry.values()]
    .map((entry) => `- **${entry.name}**: ${entry.description ?? 'No description provided.'}`)
    .join('\n')
  const latestDelegationContext = resolveLatestDelegationContext(assignmentPath)

  // Build the roster block for AGENT_ROSTER and the agent-selection protocol.
  // Role data lives on teamConfig.agents (full AgentRosterEntry), not on the
  // slim RosterEntrySlim stored in rosterEntries.
  const agentRosterBlock = participantNames
    .map((name) => {
      const fullEntry = teamConfig.agents.find((a) => a.name === name)
      const role = fullEntry?.role ?? 'No role description'
      return `- **${name}**: ${role}`
    })
    .join('\n')

  // Resolve coordinator-specific content for knowledge/experience/skills blocks
  const coordAgent = ctx.agents.get(coordinator.name)

  // The same grant the authorization uses. A coordinator told "any other tool
  // call will be blocked" acts on that sentence, so a prompt that omits a tool
  // authorization would admit is not a cosmetic difference: it is the reason
  // the tool goes unused.
  const effectiveCoordinatorTools = resolveCoordinatorAllowedTools(
    coordinator.tools,
    getAllowedLevelTools(level, ctx),
    resolveGrantedGovernedFileTools(coordinator.tools),
  )

  const vars: Record<string, string> = {
    // ── Identity ──────────────────────────────────────────────────────────
    SESSION_ID:      ctx.state.sessionId,
    TEAM_NAME:       teamConfig.team.name,
    CURRENT_LEVEL:   level?.id ?? '',

    // ── Participants ──────────────────────────────────────────────────────
    PARTICIPANTS:    participantList,
    AGENT_ROSTER:    agentRosterBlock,
    // Aliases so prompts from different teams work without modification
    AVAILABLE_AGENTS: participantList,
    BOARD_MEMBERS:   participantList,
    AVAILABLE_TEAMS: availableTeamsList || '_No registered specialist teams._',
    AVAILABLE_WORKFLOWS: availableWorkflowsList || '_No registered workflows._',
    ACTIVE_RESULT_ARTIFACT: latestDelegationContext.activeResultArtifact || '_No completed child artifact in this assignment yet._',
    ACTIVE_RESULT_CONTEXT: latestDelegationContext.summary,

    // ── Paths ─────────────────────────────────────────────────────────────
    WORKSPACE_PATH:  workspacePath,
    ASSIGNMENT_PATH: assignmentPath,
    OUTPUT_PATH:     coordinatorOutputArtifactPath,
    EXPERIENCE_PATH: coordAgent?.experienceEnabled ? path.join(coordAgent.agentDir, 'experience') : '',
    DISCUSSION_PATH: getAssignmentLogPath(assignmentPath, 'conversation.jsonl'),
    MEMO_PATH:       coordinatorOutputArtifactPath,
    TEAM_ROOT_PATH:  teamRootPath,
    TEMPLATES_PATH:  templatesPath,
    PROFILES_PATH:   profilesPath,
    STYLE_GUIDE_PATH: styleGuidePath,

    // ── Constraints ───────────────────────────────────────────────────────
    CONSTRAINTS:     getConstraintSummary(level),

    // ── Agent content blocks ──────────────────────────────────────────────
    KNOWLEDGE_BLOCK:  coordinator.knowledgeContent  ?? '_No domain knowledge loaded._',
    EXPERIENCE_BLOCK: coordinator.experienceContent ?? '_No experience accumulated yet._',
    SKILLS_BLOCK:     coordinator.skillsContent     ?? '_No skills loaded._',

    // ── Input / context ───────────────────────────────────────────────────
    INPUT_FILES:   ctx.inputFilesContent || '_No input files._',
    CONTEXT_FILES: ctx.inputFilesContent ? 'See INPUT_FILES section' : 'none',
    ALLOWED_TOOLS: formatAllowedTools(effectiveCoordinatorTools),

    // ── Misc ──────────────────────────────────────────────────────────────
    OUTPUT_MODE:   'orchestration',
    TASK_CONTENT:  ctx.inputFilesContent || '_The user will provide the task in their message._',
    CLIENT_NAME:   '',
    PROJECT_NAME:  '',
  }

  const substitutedPrompt = substituteTemplateVars(coordinator.systemPrompt, vars)

  // Inject the agent-selection protocol for discussion stages only
  const agentSelectionBlock = buildAgentSelectionBlock(
    level,
    agentRosterBlock,
    Boolean(ctx.state.parentSessionId),
    process.env.TEAM_CHAT_MODE === '1',
  )
  const dynamicDelegationBlock = buildDynamicDelegationBlock(level, availableTeamsList)
  const artifactVersioningBlock = buildArtifactVersioningBlock(level, assignmentPath, coordinatorOutputArtifactPath)
  const effectiveCoordinator = {
    ...coordinator,
    ...whenDefined(effectiveCoordinatorTools, (tools) => ({ tools })),
  }
  const toolPolicyBlock = buildToolPolicyBlock(effectiveCoordinator)
  const stageDisciplineBlock = buildStageDisciplineBlock(level, level?.stage.type !== STAGE_TYPE.DISCUSSION)

  return eventSystemPrompt + '\n\n' + substitutedPrompt + toolPolicyBlock + artifactVersioningBlock + dynamicDelegationBlock + agentSelectionBlock + stageDisciplineBlock
}

function resolveLatestDelegationContext(assignmentPath: string): {
  activeResultArtifact: string
  summary: string
} {
  const delegationsLogPath = getAssignmentLogPath(assignmentPath, 'delegations.jsonl')
  if (!fs.existsSync(delegationsLogPath)) {
    return {
      activeResultArtifact: '',
      summary: '_No completed delegation context available._',
    }
  }

  const lines = fs.readFileSync(delegationsLogPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    try {
      const event: unknown = JSON.parse(line)
      if (!isRecord(event)) continue
      const status = typeof event.status === 'string' ? event.status : ''
      const toTeam = typeof event.to_team === 'string' ? event.to_team : ''
      const artifact = typeof event.child_output_artifact === 'string' ? event.child_output_artifact : ''
      if ((status === 'completed' || status === 'completed_with_warnings') && artifact) {
        const warningNote = status === 'completed_with_warnings' ? ' Result had warnings.' : ''
        return {
          activeResultArtifact: artifact,
          summary:
            `Latest completed delegated team: ${toTeam || 'unknown'}. ` +
            `Default continuation source artifact: ${artifact}.${warningNote}`,
        }
      }
    } catch {
      continue
    }
  }

  return {
    activeResultArtifact: '',
    summary: '_No completed delegation context available._',
  }
}

function getStageToolNames(level: LevelConfig | undefined): string[] {
  if (!level) return []

  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
      return []
    case STAGE_TYPE.DISCUSSION:
      return ['set_roster', 'create_brief', 'converse']
    case STAGE_TYPE.PIPELINE:
      return ['dispatch']
    case STAGE_TYPE.CHAIN:
      return ['handoff']
    case STAGE_TYPE.BROADCAST:
      return ['broadcast']
    case STAGE_TYPE.REVIEW:
      return ['submit_for_review']
    default:
      return []
  }
}

function getAllowedLevelTools(level: LevelConfig | undefined, ctx?: RuntimeContext): string[] {
  const tools = getStageToolNames(level)
  if (level?.permissions?.spawn_teams) tools.push('spawn_team')
  if (level?.permissions?.spawn_teams && (ctx?.workflowRegistry.size ?? 0) > 0) tools.push('spawn_workflow')
  return Array.from(new Set(tools))
}

export function buildRuntimeWorkflowPrompt(
  eventSystemPrompt: string,
  level: LevelConfig | undefined,
  ctx: RuntimeContext,
): string {
  const teamConfig = ctx.teamConfig
  if (!teamConfig) throw new Error('Cannot build the runtime workflow prompt before the team config is loaded')
  const workspacePath = resolveWorkspacePath(ctx)
  const assignmentPath = getAssignmentPath(ctx)
  const teamRootPath = ctx.teamRoot || process.cwd()
  const participantNames = getParticipantNames(level)
  const availableTeamsList = [...ctx.teamRegistry.values()]
    .filter((entry) => entry.type === 'team' && entry.name !== teamConfig.team.name)
    .map((entry) => `- **${entry.name}**: ${entry.description ?? 'No description provided.'}`)
    .join('\n')
  const availableWorkflowsList = [...ctx.workflowRegistry.values()]
    .map((entry) => `- **${entry.name}**: ${entry.description ?? 'No description provided.'}`)
    .join('\n')

  const runtimeHeader = [
    `You are executing the '${teamConfig.team.name}' workflow.`,
    `This active level is runtime-controlled.`,
    `Workflow progression is owned by the runtime, not by free-form coordinator judgment.`,
    `Only use stage tools when the active runtime follow-up or an explicit recovery instruction tells you to do so.`,
    `Your responsibilities are to follow deterministic stage instructions, surface blockers clearly, and synthesize results only when the workflow explicitly calls for that.`,
    `Do not improvise a new workflow path, do not manually inspect artifacts when the stage tool already owns that boundary, and do not advance levels yourself.`,
  ].join('\n')

  const vars: Record<string, string> = {
    SESSION_ID: ctx.state.sessionId,
    TEAM_NAME: teamConfig.team.name,
    CURRENT_LEVEL: level?.id ?? '',
    PARTICIPANTS: participantNames.join(', '),
    AGENT_ROSTER: participantNames.map((name) => `- **${name}**`).join('\n'),
    AVAILABLE_AGENTS: participantNames.join(', '),
    BOARD_MEMBERS: participantNames.join(', '),
    AVAILABLE_TEAMS: availableTeamsList || '_No registered specialist teams._',
    AVAILABLE_WORKFLOWS: availableWorkflowsList || '_No registered workflows._',
    WORKSPACE_PATH: workspacePath,
    ASSIGNMENT_PATH: assignmentPath,
    OUTPUT_PATH: resolveCoordinatorOutputArtifactPath(level, assignmentPath),
    EXPERIENCE_PATH: '',
    DISCUSSION_PATH: getAssignmentLogPath(assignmentPath, 'conversation.jsonl'),
    MEMO_PATH: resolveCoordinatorOutputArtifactPath(level, assignmentPath),
    TEAM_ROOT_PATH: teamRootPath,
    TEMPLATES_PATH: path.join(teamRootPath, 'templates'),
    PROFILES_PATH: path.join(teamRootPath, 'profiles'),
    STYLE_GUIDE_PATH: path.join(teamRootPath, 'style-guide.md'),
    CONSTRAINTS: getConstraintSummary(level),
    KNOWLEDGE_BLOCK: '_No coordinator knowledge loaded._',
    EXPERIENCE_BLOCK: '_No coordinator experience loaded._',
    SKILLS_BLOCK: '_No coordinator skills loaded._',
    INPUT_FILES: ctx.inputFilesContent || '_No input files._',
    CONTEXT_FILES: ctx.inputFilesContent ? 'See INPUT_FILES section' : 'none',
    ALLOWED_TOOLS: 'Stage tools only when explicitly directed by the runtime.',
    OUTPUT_MODE: 'workflow-runtime',
    TASK_CONTENT: '_The runtime will provide the active stage instructions in the user message._',
    CLIENT_NAME: '',
    PROJECT_NAME: '',
  }

  const substitutedRuntimeHeader = substituteTemplateVars(runtimeHeader, vars)
  const stageDisciplineBlock = buildStageDisciplineBlock(level, true)
  const dynamicDelegationBlock = buildDynamicDelegationBlock(level, availableTeamsList, availableWorkflowsList)

  return eventSystemPrompt + '\n\n' + substitutedRuntimeHeader + dynamicDelegationBlock + stageDisciplineBlock
}

function buildDelegatedAutostartNoopPrompt(eventSystemPrompt: string): string {
  return (
    eventSystemPrompt + '\n\n' +
    `Delegated child runtime autostart is active for this session.\n` +
    `The runtime, not the host model, owns stage execution in this turn.\n` +
    `Do not call tools, do not inspect artifacts, and do not continue the workflow manually.\n` +
    `Reply with exactly NOOP.`
  )
}

/**
 * Whether the host may be told to stand down for this turn.
 *
 * Silencing the host is only safe while the runtime is genuinely executing the
 * stage. Keying it on `TEAM_DELEGATED_AUTOSTART` instead meant a delegated child
 * whose autostart never ran still received "Reply with exactly NOOP", so it
 * ended idle with no artifact — and the recovery attempt, spawned with the same
 * variable set, was silenced identically. A recovery attempt exists precisely
 * because the previous turn produced nothing, so it is never NOOPed.
 */
function runtimeOwnsStageExecution(
  ctx: RuntimeContext,
  level: LevelConfig,
): boolean {
  if (!shouldRuntimeAutostartLevel(level, process.env)) return false
  if (process.env.TEAM_RUNTIME_RECOVERY === '1') return false
  return ctx.delegatedAutostartOwnsStage
}

export function resolveHostWorkflowPrompt(
  eventSystemPrompt: string,
  coordinator: LoadedAgent | undefined,
  level: LevelConfig | undefined,
  ctx: RuntimeContext,
): string | undefined {
  if (!level) return undefined
  if (runtimeOwnsStageExecution(ctx, level)) {
    return buildDelegatedAutostartNoopPrompt(eventSystemPrompt)
  }
  if (coordinator) {
    return buildCoordinatorPrompt(eventSystemPrompt, coordinator, level, ctx)
  }
  return buildRuntimeWorkflowPrompt(eventSystemPrompt, level, ctx)
}

export function shouldRuntimeAutostartLevel(
  level: LevelConfig | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment.TEAM_DELEGATED_AUTOSTART === '1' && level !== undefined
}

function resolveWorkspacePath(ctx: RuntimeContext): string {
  const configuredPath = ctx.teamConfig?.workspace?.path
  if (configuredPath) return configuredPath

  if (ctx.teamRoot) return path.join(ctx.teamRoot, 'workspace')
  return 'workspace'
}

// ─── Agent Selection Protocol ─────────────────────────────────────────────────

/**
 * Build the agent-selection protocol block injected at the end of the
 * coordinator prompt for discussion-type levels.
 *
 * Returns an empty string for all other stage types.
 */
function buildAgentSelectionBlock(
  level: LevelConfig | undefined,
  agentRosterBlock: string,
  isDelegatedChild: boolean,
  isTeamChat: boolean,
): string {
  if (level?.stage.type !== STAGE_TYPE.DISCUSSION) return ''

  if (isDelegatedChild) {
    return (
      `\n\n## Delegated Child Team Protocol\n\n` +
      `This session was delegated by another team. There is no human user in this child session.\n\n` +
      `**Available agents for this discussion:**\n${agentRosterBlock}\n\n` +
      `**Required steps:**\n` +
      `1. Select the smallest appropriate roster yourself for the delegated brief.\n` +
      `   Apply soft continuity: prefer previous responders whose expertise remains relevant, add specialists for uncovered needs, and allow a completely different roster when the topic changes.\n` +
      `   Include valid agents explicitly mentioned with @ in the current user message.\n` +
      (isTeamChat
        ? `   ${TEAM_CHAT_ROSTER_SIZE_GUIDELINE}\n`
        : '') +
      `2. Call \`set_roster(agents=[...])\` without asking for external approval.\n` +
      (isTeamChat
        ? `3. Call \`create_brief(...)\` to prepare the chat context in memory. Do not create or promise a file unless the user explicitly asks for one.\n`
        : `3. Call \`create_brief(...)\` using the delegated brief as the assignment basis.\n`) +
      `4. Proceed with \`converse\` once the roster and brief are locked.\n`
    )
  }

  return (
    `\n\n## Agent Selection Protocol\n\n` +
    `If you choose to use the discussion tools, you MUST present the available agents to the user and ask for approval first.\n` +
    `If you are delegating through \`spawn_team\` instead, you may do that without this roster handshake.\n\n` +
    `**Available agents for this discussion:**\n${agentRosterBlock}\n\n` +
    `**Required steps:**\n` +
    `1. Propose which agents should participate, with a brief rationale for each (include/exclude)\n` +
    `2. Ask the user: "Are you okay with this selection?"\n` +
    `3. Wait for the user's response. Treat clear affirmative replies such as "yes", "ok", "okay", "go ahead", "looks good", "sounds good", and close variants as approval. Treat ambiguous replies as non-approval and clarify instead.\n` +
    `4. Confirm the final roster: "The following agents will participate in this discussion: [list]"\n` +
    `5. Never say or imply the user has approved until they actually reply with approval.\n` +
    `6. After the user explicitly approves the selection, call \`set_roster(agents=[...])\` once to lock the roster.\n` +
    `7. Call \`create_brief(...)\` to formalize the engagement. Synthesize everything the user told you in the conversation so far into a structured assignment brief — their problem, objectives, scope, why each agent was selected, and what deliverables they expect. This is a formal Statement of Work — write it as if a consulting firm is documenting a client engagement.\n` +
    `8. Only THEN proceed to call \`converse\` — addressing only the approved agents\n`
  )
}

function resolveCoordinatorOutputArtifactPath(
  level: LevelConfig | undefined,
  assignmentPath: string,
): string {
  if (!level || level.stage.type === STAGE_TYPE.PIPELINE) return assignmentPath

  const baseOutputPath = path.join(assignmentPath, getOutputFormat(level))
  if (!fs.existsSync(baseOutputPath)) return baseOutputPath

  const parsed = path.parse(baseOutputPath)
  let version = 2

  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${version}${parsed.ext}`)
    if (!fs.existsSync(candidate)) return candidate
    version++
  }
}

function buildArtifactVersioningBlock(
  level: LevelConfig | undefined,
  assignmentPath: string,
  outputArtifactPath: string,
): string {
  if (!level || level.stage.type === STAGE_TYPE.PIPELINE) return ''

  const canonicalArtifactPath = path.join(assignmentPath, getOutputFormat(level))
  if (canonicalArtifactPath === outputArtifactPath) return ''

  return (
    `\n\n## Existing Output Preservation\n\n` +
    `A prior output artifact already exists at \`${canonicalArtifactPath}\`.\n` +
    `Do not overwrite or replace that file.\n` +
    `Write this new revision as a separate artifact at \`${outputArtifactPath}\`.\n`
  )
}

function buildDynamicDelegationBlock(
  level: LevelConfig | undefined,
  availableTeamsList: string,
  availableWorkflowsList = '',
): string {
  if (!level?.permissions?.spawn_teams) return ''

  return (
    `\n\n## Dynamic Team Delegation\n\n` +
    `This level may delegate work to registered specialist teams using \`spawn_team\`.\n\n` +
    `**Registered teams:**\n${availableTeamsList || '_No registered specialist teams._'}\n\n` +
    (
      availableWorkflowsList
        ? `This level may also delegate to registered workflow templates using \`spawn_workflow\`.\n\n**Registered workflows:**\n${availableWorkflowsList}\n\n`
        : ''
    ) +
    `Use \`spawn_team\` when the work belongs with a specialist team rather than this coordinator.\n` +
    `${availableWorkflowsList ? `Use \`spawn_workflow\` when the request clearly needs multiple specialist teams in a declared sequence.\n` : ''}` +
    `You do not need to use \`set_roster\` or \`converse\` just to delegate via the registry.\n` +
    `After \`spawn_team\` or \`spawn_workflow\` returns, do not improvise the delegation outcome. Treat the tool result as authoritative.\n`
  )
}

function buildStageDisciplineBlock(level: LevelConfig | undefined, runtimeOwned = false): string {
  if (!level) return ''

  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
      return (
        `\n\n## Current Level Discipline\n\n` +
        `This is a routing stage.\n` +
        `${runtimeOwned ? `Routine routing progression is runtime-owned.\n` : ''}` +
        `Gather only the minimal missing intake required to choose a specialist team.\n` +
        `If the request is already clear, call \`spawn_team\` or \`spawn_workflow\` directly and stop.\n` +
        `Once either routing tool returns, the routing decision is complete for this turn.\n` +
        `If the tool succeeded, send at most one short acknowledgment.\n` +
        `If the tool failed, report the failure concisely and stop.\n` +
        `Never claim the request was routed successfully after a routing-tool error.\n` +
        `Do not start a discussion, set a roster, or create a formal brief at intake unless a different stage explicitly requires it.\n`
      )
    case STAGE_TYPE.PIPELINE:
      return (
        `\n\n## Current Level Discipline\n\n` +
        `This is a pipeline stage.\n` +
        `${runtimeOwned ? `Routine pipeline progression is runtime-owned.\n` : ''}` +
        `Use \`dispatch\` only when the active runtime instruction or a recovery path explicitly tells you to do so.\n` +
        `Your role is to monitor execution, surface blockers, and synthesize the outcome if requested.\n`
      )
    case STAGE_TYPE.CHAIN:
      return (
        `\n\n## Current Level Discipline\n\n` +
        `This is a chain stage.\n` +
        `${runtimeOwned ? `Routine chain progression is runtime-owned.\n` : ''}` +
        `Call \`handoff\` at most once when explicitly directed for this stage, then stop.\n` +
        `Do not inspect artifacts manually and do not start the next level yourself in the same turn.\n` +
        `The runtime advances levels automatically after the chain completes.\n`
      )
    case STAGE_TYPE.BROADCAST:
      return (
        `\n\n## Current Level Discipline\n\n` +
        `This is a broadcast stage.\n` +
        `${runtimeOwned ? `Routine fan-out and aggregation are runtime-owned.\n` : ''}` +
        `Call \`broadcast\` at most once when explicitly directed for this stage, then stop.\n` +
        `Do not manually re-run branches or advance the workflow yourself after aggregation.\n`
      )
    case STAGE_TYPE.REVIEW:
      return (
        `\n\n## Current Level Discipline\n\n` +
        `This is a review stage.\n` +
        `${runtimeOwned ? `Routine review looping is runtime-owned.\n` : ''}` +
        `Call \`submit_for_review()\` at most once when explicitly directed for the current review cycle, then stop.\n` +
        `Do not call chain tools here and do not try to manually read intermediate artifacts if the review tool can proceed.\n`
      )
    default:
      return ''
  }
}
import { whenDefined } from '../core/optional-properties.js'
