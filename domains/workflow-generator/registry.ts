/**
 * Registry loader for the workflow generator.
 *
 * Reads `teams.yaml` (the team registry) and each referenced
 * `teams/<name>/team.yaml` to build the catalog of teams + agents the
 * architect can compose into workflow steps.
 *
 * The `workflow-architect` team is filtered out — it is itself a design-time
 * team, not a runtime building block, and must never be proposed as a step.
 *
 * Internal-only entries (those tagged `internal`) are also filtered out.
 */

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseYaml, type YamlObject, type YamlValue } from '../../core/yaml-parser.js'
import { parseWorkflowTemplate } from '../../workflows/loader.js'
import type {
  AgentEntry,
  LevelEntry,
  TeamEntry,
  WorkflowTemplateEntry,
  WorkflowGeneratorRegistry,
} from './workflow-draft.js'
import { isAgentFileHiddenFromUi } from '../agent-generator/agent-visibility.js'

interface CacheEntry {
  registry: WorkflowGeneratorRegistry
  teamsYamlMtimeMs: number
  workflowRegistryMtimeMs: number
  teamYamlMtimes: Record<string, number>
  agentFileMtimes: Record<string, number>
}

let cache: { key: string; entry: CacheEntry } | null = null

const ARCHITECT_TEAM_ID = 'workflow-architect'

export function loadRegistry(repoRoot: string): WorkflowGeneratorRegistry {
  const teamsYamlPath = path.join(repoRoot, 'teams.yaml')
  const cacheKey = teamsYamlPath

  let teamsMtime = 0
  try {
    teamsMtime = fs.statSync(teamsYamlPath).mtimeMs
  } catch {
    return { teams: [] }
  }
  const workflowRegistryPath = path.join(repoRoot, 'workflows', 'registry.yaml')
  const workflowRegistryMtime = statMtime(workflowRegistryPath)

  if (
    cache &&
    cache.key === cacheKey &&
    cache.entry.teamsYamlMtimeMs === teamsMtime &&
    cache.entry.workflowRegistryMtimeMs === workflowRegistryMtime
  ) {
    if (
      allFilesUnchanged(cache.entry.teamYamlMtimes) &&
      allFilesUnchanged(cache.entry.agentFileMtimes)
    ) {
      return cache.entry.registry
    }
  }

  const raw = readYamlSafe(teamsYamlPath)
  const teams: TeamEntry[] = []
  const teamYamlMtimes: Record<string, number> = {}
  const agentFileMtimes: Record<string, number> = {}

  for (const [teamId, value] of Object.entries(raw)) {
    if (teamId === ARCHITECT_TEAM_ID) continue
    if (!isObject(value)) continue
    const tags = parseStringList(value.tags)
    if (tags.includes('internal')) continue

    const teamPath = typeof value.team_path === 'string'
      ? path.resolve(path.dirname(teamsYamlPath), value.team_path)
      : null
    const teamYamlPath = teamPath ? path.join(teamPath, 'team.yaml') : null

    let teamYaml: YamlObject | null = null
    if (teamYamlPath && fs.existsSync(teamYamlPath)) {
      try {
        teamYamlMtimes[teamYamlPath] = fs.statSync(teamYamlPath).mtimeMs
      } catch {
        // ignore
      }
      teamYaml = readYamlSafe(teamYamlPath)
    }

    const agents = teamYaml
      ? extractAgents(
          teamYaml.agents,
          teamYamlPath,
          path.resolve(repoRoot),
          agentFileMtimes,
        )
      : []
    const { hasDiscussion, hasReview, levelIds, levels } = teamYaml
      ? extractLevelInfo(teamYaml.levels)
      : { hasDiscussion: false, hasReview: false, levelIds: [], levels: [] }

    teams.push({
      id: teamId,
      ...whenDefined(typeof value.description === 'string' ? value.description.trim() : undefined, (definedValue) => ({ description: definedValue })),
      ...whenDefined(tags.length > 0 ? tags : undefined, (definedValue) => ({ tags: definedValue })),
      ...whenDefined(typeof value.input_artifact === 'string' ? value.input_artifact : undefined, (definedValue) => ({ default_input_artifact: definedValue })),
      ...whenDefined(typeof value.output_artifact === 'string' ? value.output_artifact : undefined, (definedValue) => ({ default_output_artifact: definedValue })),
      has_discussion_level: hasDiscussion,
      has_review_level: hasReview,
      level_ids: levelIds,
      levels,
      agents,
    })
  }

  const registry: WorkflowGeneratorRegistry = {
    teams,
    workflow_templates: loadWorkflowTemplates(workflowRegistryPath),
  }
  cache = {
    key: cacheKey,
    entry: {
      registry,
      teamsYamlMtimeMs: teamsMtime,
      workflowRegistryMtimeMs: workflowRegistryMtime,
      teamYamlMtimes,
      agentFileMtimes,
    },
  }
  return registry
}

function statMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function allFilesUnchanged(mtimes: Record<string, number>): boolean {
  for (const [file, mtime] of Object.entries(mtimes)) {
    try {
      if (fs.statSync(file).mtimeMs !== mtime) return false
    } catch {
      return false
    }
  }
  return true
}

function readYamlSafe(filePath: string): YamlObject {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = parseYaml(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
    return {}
  } catch {
    return {}
  }
}

function extractAgents(
  value: YamlValue | undefined,
  teamYamlPath: string | null,
  repoRoot: string,
  agentFileMtimes: Record<string, number>,
): AgentEntry[] {
  if (!Array.isArray(value)) return []
  const agents: AgentEntry[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const name = typeof item.name === 'string' ? item.name : ''
    if (!name) continue
    const role = typeof item.role === 'string' ? item.role.replace(/\s+/g, ' ').trim() : ''
    const absoluteAgentFile = typeof item.agent_file === 'string' && teamYamlPath
      ? path.resolve(path.dirname(teamYamlPath), item.agent_file)
      : undefined
    if (absoluteAgentFile) {
      agentFileMtimes[absoluteAgentFile] = statMtime(absoluteAgentFile)
      if (isAgentFileHiddenFromUi(absoluteAgentFile)) continue
    }
    const agentFile = absoluteAgentFile
      ? toRepoRelativePath(absoluteAgentFile, repoRoot)
      : undefined
    agents.push({
      name,
      role,
      ...whenDefined(typeof item.tier === 'string' ? item.tier : undefined, (definedValue) => ({ tier: definedValue })),
      tools: parseStringList(item.tools),
      ...whenDefined(agentFile, (definedValue) => ({ agent_file: definedValue })),
    })
  }
  return agents
}

function toRepoRelativePath(filePath: string, repoRoot: string): string | undefined {
  const relative = path.relative(repoRoot, filePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined
  }
  return relative.split(path.sep).join('/')
}

function extractLevelInfo(value: YamlValue | undefined): {
  hasDiscussion: boolean
  hasReview: boolean
  levelIds: string[]
  levels: LevelEntry[]
} {
  if (!Array.isArray(value)) {
    return { hasDiscussion: false, hasReview: false, levelIds: [], levels: [] }
  }
  let hasDiscussion = false
  let hasReview = false
  const levelIds: string[] = []
  const levels: LevelEntry[] = []
  for (const level of value) {
    if (!isObject(level)) continue
    const id = typeof level.id === 'string' ? level.id : ''
    if (id) levelIds.push(id)
    const stage = isObject(level.stage) ? level.stage : null
    if (!stage) continue
    const stageType = typeof stage.type === 'string' ? stage.type : ''
    if (stageType === 'discussion') hasDiscussion = true
    if (stageType === 'review') hasReview = true
    if (!id || !stageType) continue
    const config = isObject(stage.config) ? stage.config : {}
    levels.push({
      id,
      ...whenDefined(typeof level.name === 'string' ? level.name : undefined, (definedValue) => ({ name: definedValue })),
      stage_type: stageType,
      ...whenDefined(typeof stage.coordinator === 'string' ? stage.coordinator : undefined, (definedValue) => ({ coordinator: definedValue })),
      participants: parseStringList(stage.participants),
      sequence: parseStringList(stage.sequence),
      ...whenDefined(typeof stage.producer === 'string' ? stage.producer : undefined, (definedValue) => ({ producer: definedValue })),
      ...whenDefined(typeof stage.reviewer === 'string' ? stage.reviewer : undefined, (definedValue) => ({ reviewer: definedValue })),
      ...whenDefined(numberValue(config.min_rounds), (definedValue) => ({ min_rounds: definedValue })),
      ...whenDefined(numberValue(config.max_rounds), (definedValue) => ({ max_rounds: definedValue })),
      ...whenDefined(numberValue(config.min_successful_participants), (definedValue) => ({ min_successful_participants: definedValue })),
      ...whenDefined(numberValue(config.max_iterations), (definedValue) => ({ max_iterations: definedValue })),
      ...whenDefined(extractOutputFormat(config.output) ??
        extractCompletionArtifact(config.output_contract), (definedValue) => ({ output_format: definedValue })),
    })
  }
  return { hasDiscussion, hasReview, levelIds, levels }
}

function loadWorkflowTemplates(filePath: string): WorkflowTemplateEntry[] {
  if (!fs.existsSync(filePath)) return []
  const raw = readYamlSafe(filePath)
  const templates: WorkflowTemplateEntry[] = []
  for (const [id, value] of Object.entries(raw)) {
    if (!isObject(value)) continue
    const templatePath =
      typeof value.template_path === 'string'
        ? path.resolve(path.dirname(filePath), value.template_path)
        : null
    const parsedTemplate = templatePath ? readWorkflowTemplateSafe(templatePath) : null
    templates.push({
      id,
      ...whenDefined(typeof value.description === 'string' ? value.description.trim() : undefined, (description) => ({ description })),
      ...whenDefined(typeof value.template_path === 'string' ? value.template_path : undefined, (template_path) => ({ template_path })),
      tags: parseStringList(value.tags),
      capabilities: parseStringList(value.capabilities),
      ...whenDefined(parsedTemplate?.mcp_requirements, (mcp_requirements) => ({ mcp_requirements })),
      ...whenDefined(parsedTemplate?.input?.artifact, (input_artifact) => ({ input_artifact })),
      ...whenDefined(parsedTemplate?.output.from_step && parsedTemplate.output.artifact
          ? `${parsedTemplate.output.from_step}:${parsedTemplate.output.artifact}`
          : undefined, (output) => ({ output })),
      ...whenDefined(parsedTemplate?.steps.map((step) => ({
        id: step.id,
        type: step.type,
        ...whenDefined(step.team, (team) => ({ team })),
        ...whenDefined(step.agent, (agent) => ({ agent })),
        ...whenDefined(step.prompt, (prompt) => ({ prompt })),
        ...whenDefined(step.stage_type, (stage_type) => ({ stage_type })),
        result_artifact: step.result_artifact,
        ...whenDefined(step.requested_result_type, (requested_result_type) => ({ requested_result_type })),
        ...whenDefined(step.mcp_requirements, (mcp_requirements) => ({ mcp_requirements })),
        ...whenDefined(step.handoff
          ? `${step.handoff.from_step}:${step.handoff.from_artifact} -> ${step.handoff.to_artifact}`
          : undefined, (handoff) => ({ handoff })),
      })), (steps) => ({ steps })),
    })
  }
  return templates
}

function readWorkflowTemplateSafe(filePath: string) {
  try {
    return parseWorkflowTemplate(filePath).template
  } catch {
    return null
  }
}

function extractOutputFormat(value: YamlValue | undefined): string | undefined {
  if (!isObject(value)) return undefined
  if (typeof value.format !== 'string') return undefined
  return typeof value.path === 'string' && value.path
    ? `${value.path}/${value.format}`
    : value.format
}

function extractCompletionArtifact(
  value: YamlValue | undefined,
): string | undefined {
  if (!isObject(value)) return undefined
  return typeof value.completion_artifact === 'string'
    ? value.completion_artifact
    : undefined
}

function numberValue(value: YamlValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseStringList(value: YamlValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter(Boolean)
}

function isObject(value: unknown): value is YamlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
