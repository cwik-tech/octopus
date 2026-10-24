/**
 * Team Runtime — Artifact Contracts
 *
 * Canonical YAML frontmatter schema and helpers for runtime-owned markdown
 * artifacts. The filename remains configurable, but the runtime standardizes
 * the metadata envelope around those files so downstream parsers can rely on
 * stable fields during handoffs and validation.
 */

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ParsedMarkdownArtifact } from '../../contracts/artifacts.js'
import { writeFileAtomicSync } from '../../core/file-mutation.js'
import { resolveRelativePathInside } from '../../core/path-safety.js'
import { publishEngineEvent } from './runtime-events.js'

export type { ParsedMarkdownArtifact }

export type RuntimeArtifactType =
  | 'brief'
  | 'handoff'
  | 'draft'
  | 'review-feedback'
  | 'result'
  | 'report'
  | 'contract'
  | 'validation'
  | 'minutes'

type FrontmatterScalar = string | number | boolean
type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[]

export interface RuntimeArtifactMetadata {
  artifact_type: RuntimeArtifactType
  artifact_role?: 'input' | 'intermediate' | 'final' | 'wrapper'
  schema_version: number
  created_at: string
  filename: string
  path: string
  session_id?: string
  root_session_id?: string
  parent_session_id?: string
  from?: string
  to?: string
  team?: string
  agent?: string
  agent_id?: string
  agent_display_name?: string
  activity_scope_id?: string
  level?: string
  stage_type?: string
  status?: string
  title?: string
  role?: string
  step?: number
  iteration?: number
  task_id?: string
  sprint_id?: string
  source_task_file?: string
  reviewed?: string
  verdict?: string
  supersedes?: string
}

export interface RuntimeArtifactWrittenEventInput {
  outputDir: string
  relativePath: string
  artifactType: string
  artifactRole?: RuntimeArtifactMetadata['artifact_role']
  createdAt?: string
  sessionId?: string
  rootSessionId?: string
  parentSessionId?: string
  team?: string
  level?: string
  stageType?: string
  agentId?: string
  agentName?: string
  agentBaseName?: string
  activityScopeId?: string
  emitterName?: string
  status?: string
  title?: string
}

function toYamlScalar(value: FrontmatterScalar): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function isFrontmatterScalar(value: unknown): value is FrontmatterScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isFrontmatterValue(value: unknown): value is FrontmatterValue {
  return isFrontmatterScalar(value) || (Array.isArray(value) && value.every(isFrontmatterScalar))
}

function serializeFrontmatter(metadata: RuntimeArtifactMetadata): string {
  const lines = ['---']

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue
    if (!isFrontmatterValue(value)) continue

    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => toYamlScalar(item)).join(', ')}]`)
      continue
    }

    lines.push(`${key}: ${toYamlScalar(value)}`)
  }

  lines.push('---', '')
  return lines.join('\n')
}

export function withArtifactFrontmatter(
  metadata: RuntimeArtifactMetadata,
  body: string,
): string {
  return `${serializeFrontmatter(metadata)}${body.trimEnd()}\n`
}

export function buildArtifactMetadata(params: {
  filePath: string
  rootDir: string
  artifactType: RuntimeArtifactType
  artifactRole?: RuntimeArtifactMetadata['artifact_role']
  createdAt?: string
  sessionId?: string
  rootSessionId?: string
  parentSessionId?: string
  from?: string
  to?: string
  team?: string
  agent?: string
  agentId?: string
  agentDisplayName?: string
  activityScopeId?: string
  level?: string
  stageType?: string
  status?: string
  title?: string
  role?: string
  step?: number
  iteration?: number
  taskId?: string
  sprintId?: string
  sourceTaskFile?: string
  reviewed?: string
  verdict?: string
  supersedes?: string
}): RuntimeArtifactMetadata {
  const relativePath = path.relative(params.rootDir, params.filePath) || path.basename(params.filePath)

  return {
    artifact_type: params.artifactType,
    ...whenDefined(params.artifactRole, (artifact_role) => ({ artifact_role })),
    schema_version: 1,
    created_at: params.createdAt ?? new Date().toISOString(),
    filename: path.basename(params.filePath),
    path: relativePath,
    ...whenDefined(params.sessionId, (session_id) => ({ session_id })),
    ...whenDefined(params.rootSessionId, (root_session_id) => ({ root_session_id })),
    ...whenDefined(params.parentSessionId, (parent_session_id) => ({ parent_session_id })),
    ...whenDefined(params.from, (from) => ({ from })),
    ...whenDefined(params.to, (to) => ({ to })),
    ...whenDefined(params.team, (team) => ({ team })),
    ...whenDefined(params.agent, (agent) => ({ agent })),
    ...whenDefined(params.agentId, (agent_id) => ({ agent_id })),
    ...whenDefined(params.agentDisplayName, (agent_display_name) => ({ agent_display_name })),
    ...whenDefined(params.activityScopeId, (activity_scope_id) => ({ activity_scope_id })),
    ...whenDefined(params.level, (level) => ({ level })),
    ...whenDefined(params.stageType, (stage_type) => ({ stage_type })),
    ...whenDefined(params.status, (status) => ({ status })),
    ...whenDefined(params.title, (title) => ({ title })),
    ...whenDefined(params.role, (role) => ({ role })),
    ...whenDefined(params.step, (step) => ({ step })),
    ...whenDefined(params.iteration, (iteration) => ({ iteration })),
    ...whenDefined(params.taskId, (task_id) => ({ task_id })),
    ...whenDefined(params.sprintId, (sprint_id) => ({ sprint_id })),
    ...whenDefined(params.sourceTaskFile, (source_task_file) => ({ source_task_file })),
    ...whenDefined(params.reviewed, (reviewed) => ({ reviewed })),
    ...whenDefined(params.verdict, (verdict) => ({ verdict })),
    ...whenDefined(params.supersedes, (supersedes) => ({ supersedes })),
  }
}

export function writeMarkdownArtifact(
  filePath: string,
  body: string,
  metadata: RuntimeArtifactMetadata,
): void {
  writeFileAtomicSync(filePath, withArtifactFrontmatter(metadata, body))
  publishMarkdownArtifactWrittenEvent(filePath, metadata)
}

/** Publish the canonical artifact event after an atomic writer has committed. */
export function publishMarkdownArtifactWrittenEvent(
  filePath: string,
  metadata: RuntimeArtifactMetadata,
): void {
  const relativeArtifactPath = metadata.path.split(/[\\/]/).join(path.sep)
  const outputDir = filePath.endsWith(relativeArtifactPath)
    ? filePath.slice(0, filePath.length - relativeArtifactPath.length).replace(/[\\/]$/, '')
    : path.dirname(filePath)
  publishEngineEvent(outputDir, {
    timestamp: metadata.created_at,
    category: 'artifact',
    type: 'artifact.written',
    ...whenDefined(metadata.session_id, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(metadata.root_session_id, (definedValue) => ({ root_run_id: definedValue })),
    ...whenDefined(metadata.parent_session_id, (definedValue) => ({ parent_run_id: definedValue })),
    assignment_path: outputDir,
    team: metadata.team ?? null,
    level_id: metadata.level ?? null,
    stage_type: metadata.stage_type ?? null,
    payload: {
      artifact_type: metadata.artifact_type,
      artifact_role: metadata.artifact_role,
      filename: metadata.filename,
      path: metadata.path,
      status: metadata.status,
      title: metadata.title,
      ...(metadata.agent_display_name
        ? { agent_name: metadata.agent_display_name }
        : metadata.agent
          ? { agent_name: metadata.agent }
          : {}),
      ...(metadata.agent_id ? { agent_id: metadata.agent_id } : {}),
      ...(metadata.agent ? { agent_base_name: metadata.agent } : {}),
      ...(metadata.activity_scope_id
        ? { activity_scope_id: metadata.activity_scope_id }
        : {}),
    },
  })
}

/**
 * Publish an artifact event for an already-committed runtime-owned file.
 *
 * JSON evidence and other machine artifacts do not carry Markdown
 * frontmatter, so they cannot use `publishMarkdownArtifactWrittenEvent`.
 * This helper applies the same event contract after proving that the supplied
 * relative path names a regular, non-symlinked file inside the assignment.
 */
export function publishRuntimeArtifactWrittenEvent(
  input: RuntimeArtifactWrittenEventInput,
): void {
  const outputDir = path.resolve(input.outputDir)
  const artifactPath = resolveRelativePathInside(outputDir, input.relativePath)
  if (!artifactPath) {
    throw new Error(`Runtime artifact path is unsafe: ${input.relativePath}`)
  }

  let outputDirRealPath: string
  let artifactRealPath: string
  let artifactStats: fs.Stats
  try {
    outputDirRealPath = fs.realpathSync(outputDir)
    artifactRealPath = fs.realpathSync(artifactPath)
    artifactStats = fs.lstatSync(artifactPath)
  } catch {
    throw new Error(`Runtime artifact does not exist: ${input.relativePath}`)
  }
  if (
    outputDirRealPath !== outputDir ||
    artifactRealPath !== artifactPath ||
    artifactStats.isSymbolicLink() ||
    !artifactStats.isFile()
  ) {
    throw new Error(`Runtime artifact must be a contained regular file: ${input.relativePath}`)
  }

  publishEngineEvent(outputDir, {
    timestamp: input.createdAt ?? new Date().toISOString(),
    category: 'artifact',
    type: 'artifact.written',
    ...whenDefined(input.sessionId, (definedValue) => ({ run_id: definedValue })),
    ...whenDefined(input.rootSessionId, (definedValue) => ({ root_run_id: definedValue })),
    ...whenDefined(input.parentSessionId, (definedValue) => ({ parent_run_id: definedValue })),
    assignment_path: outputDir,
    team: input.team ?? null,
    level_id: input.level ?? null,
    stage_type: input.stageType ?? null,
    payload: {
      artifact_type: input.artifactType,
      artifact_role: input.artifactRole,
      filename: path.basename(artifactPath),
      path: input.relativePath,
      status: input.status,
      title: input.title,
      ...(input.agentName ? { agent_name: input.agentName } : {}),
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.agentBaseName
        ? { agent_base_name: input.agentBaseName }
        : {}),
      ...(input.activityScopeId
        ? { activity_scope_id: input.activityScopeId }
        : {}),
      ...(input.emitterName ? { emitter_name: input.emitterName } : {}),
    },
  })
}

export function parseMarkdownArtifact(content: string): ParsedMarkdownArtifact {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { metadata: {}, body: content, hasFrontmatter: false }
  }
  const frontmatterSource = match[1]
  const body = match[2]
  if (frontmatterSource === undefined || body === undefined) {
    return { metadata: {}, body: content, hasFrontmatter: false }
  }

  const metadata: Record<string, string> = {}
  for (const rawLine of frontmatterSource.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1)
    }
    metadata[key] = value
  }

  return { metadata, body, hasFrontmatter: true }
}

export function readMarkdownArtifact(filePath: string): ParsedMarkdownArtifact {
  return parseMarkdownArtifact(fs.readFileSync(filePath, 'utf-8'))
}

export function stripArtifactFrontmatter(content: string): string {
  return parseMarkdownArtifact(content).body
}

export function resolveRuntimeOwnedArtifactContent(
  bodyOrAgentText: string,
  artifactPath?: string,
): string {
  if (artifactPath && fs.existsSync(artifactPath)) {
    const artifactContent = fs.readFileSync(artifactPath, 'utf-8')
    const stripped = stripArtifactFrontmatter(artifactContent).trim()
    if (stripped) return stripped
  }

  const strippedBody = stripArtifactFrontmatter(bodyOrAgentText).trim()
  return strippedBody || bodyOrAgentText.trim()
}
