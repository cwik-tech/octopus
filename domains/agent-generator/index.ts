/**
 * Public domain surface for the agent-generator feature.
 *
 * Backend-only. The Create tab UI calls into these via the /create/agents/*
 * endpoints registered in server/api-server.ts.
 */

export { listAgents, readAgentDetail } from './list-agents.js'
export {
  isAgentFileHiddenFromUi,
  isAgentHiddenFromUi,
} from './agent-visibility.js'
export { checkAgentProviderHealth } from './provider-health.js'
export { listSkillsTree } from './list-skills.js'
export {
  runCreateAgent,
  findExistingAgentWithSkills,
  sanitizeAgentName,
} from './create-agent.js'
export { runRefineAgent } from './refine-agent.js'
export {
  commitAgent,
  savePersona,
  readPersona,
  nextAvailableAgentName,
} from './commit-agent.js'
export {
  addAgentToTeam,
  listAgentTeamOptions,
  listAgentTeamUsage,
} from './team-usage.js'
export { deleteAgent, previewAgentDelete } from './delete-agent.js'
export {
  addAgentPackageFiles,
  commitAgentPackageImport,
  previewAgentPackageImport,
  removeAgentPackageItem,
} from './package-assets.js'
export {
  addTeamBuilderAgent,
  addTeamBuilderAgents,
  createTeamBuilderTeam,
  deleteTeamBuilderTeam,
  digestTeamYaml,
  listTeamBuilderTeams,
  listPublishedTeams,
  finishTeamBuilderPublication,
  isTeamBuilding,
  discardGeneratedTeamShell,
  GeneratedTeamShellRefusal,
  readGeneratedTeamShell,
  teamPublishedBy,
  readTeamBuilderTeam,
  removeTeamBuilderAgent,
  TeamRevisionConflictError,
  updateTeamBuilderTeam,
} from './team-manager.js'
export type {
  TeamBuilderAgentAddition,
  TeamHealthRuntimeContext,
} from './team-manager.js'
export type {
  AgentSummary,
  AgentProviderHealth,
  AgentProviderHealthStatus,
  AgentDeletePreview,
  AgentDeleteResult,
  AgentPackageAddKind,
  AgentPackageFileInput,
  AgentPackageImportAction,
  AgentPackageImportChoice,
  AgentPackageImportItem,
  AgentPackageRemoveMode,
  AgentSkillUsage,
  AgentTeamOption,
  AgentTeamUsage,
  TeamBuilderDetail,
  TeamBuilderSummary,
  TeamBuilderUpsertInput,
  LegacyTeamModelSettings,
  TeamRosterAgent,
  SkillTreeNode,
  ChatTurn,
  DraftAgentRequest,
  DraftAgentResponse,
  DraftAgentSuccess,
  DraftAgentDuplicate,
  DraftAgentNeedsInput,
  CommitAgentRequest,
  CommitAgentResult,
  RefineAgentRequest,
  RefineAgentResult,
} from './types.js'
