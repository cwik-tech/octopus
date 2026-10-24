import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { parseYaml, type YamlObject, type YamlValue } from '../core/yaml-parser.js'
import { normalizeMcpWorkflowRequirements } from '../contracts/mcp-workflow-capabilities.js'
import type { TeamRuntimeOverrides } from '../core/types.js'
import { BUILTIN_TRANSFORM_EXECUTOR } from './artifact-contracts.js'
import type {
  WorkflowOutputArtifact,
  WorkflowRegistryEntry,
  WorkflowStep,
  WorkflowTemplate,
} from './types.js'

export interface WorkflowRegistryParseResult {
  entries: WorkflowRegistryEntry[]
  errors: string[]
  warnings: string[]
}

export interface WorkflowTemplateParseResult {
  template: WorkflowTemplate | null
  errors: string[]
}

function str(val: YamlValue | undefined, fallback = ''): string {
  if (val == null) return fallback
  return String(val)
}

function parseStringList(val: YamlValue | undefined): string[] | undefined {
  if (!Array.isArray(val)) return undefined
  return val.map((item) => String(item)).filter(Boolean)
}

function isYamlObject(value: YamlValue | undefined): value is YamlObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseArtifactHandoffs(
  value: YamlValue | undefined,
): WorkflowStep['context_handoffs'] {
  if (!Array.isArray(value)) return undefined
  return value.map((entry) => {
    const handoff = entry as YamlObject
    return {
      from_step: str(handoff.from_step),
      from_artifact: str(handoff.from_artifact),
      to_artifact: str(handoff.to_artifact),
    }
  })
}

function parseWordOptions(
  value: YamlValue | undefined,
  scope: string,
  errors: string[],
): WorkflowStep['word'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const word = value as YamlObject
  const allowedKeys = new Set([
    'profile',
    'table_of_contents',
    'render_mermaid',
    'mermaid_failure',
  ])
  for (const key of Object.keys(word)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${scope}.word.${key} is not supported`)
    }
  }
  const booleanValue = (
    key: 'table_of_contents' | 'render_mermaid',
  ): boolean | undefined => {
    const input = word[key]
    if (input === undefined) return undefined
    if (typeof input === 'boolean') return input
    errors.push(`${scope}.word.${key} must be a boolean`)
    return undefined
  }
  const stringValue = (
    key: 'profile' | 'mermaid_failure',
  ): string | undefined => {
    const input = word[key]
    if (input === undefined) return undefined
    if (typeof input === 'string' && input.trim()) return input.trim()
    errors.push(`${scope}.word.${key} must be a non-empty string`)
    return undefined
  }
  return {
    ...whenDefined(stringValue('profile'), (profile) => ({ profile })),
    ...whenDefined(booleanValue('table_of_contents'), (table_of_contents) => ({ table_of_contents })),
    ...whenDefined(booleanValue('render_mermaid'), (render_mermaid) => ({ render_mermaid })),
    ...whenDefined(parseMermaidFailure(stringValue('mermaid_failure'), scope, errors), (mermaid_failure) => ({ mermaid_failure })),
  }
}

function parseMermaidFailure(
  value: string | undefined,
  scope: string,
  errors: string[],
): 'error' | 'keep-code' | undefined {
  if (value === undefined || value === 'error' || value === 'keep-code') return value
  errors.push(`${scope}.word.mermaid_failure must be error or keep-code`)
  return undefined
}

function parseExcelOptions(
  value: YamlValue | undefined,
  scope: string,
  errors: string[],
): WorkflowStep['excel'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const excel = value as YamlObject
  const allowedKeys = new Set(['profile', 'template'])
  for (const key of Object.keys(excel)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${scope}.excel.${key} is not supported`)
    }
  }
  const stringValue = (key: 'profile' | 'template'): string | undefined => {
    const input = excel[key]
    if (input === undefined) return undefined
    if (typeof input === 'string' && input.trim()) return input.trim()
    errors.push(`${scope}.excel.${key} must be a non-empty string`)
    return undefined
  }
  const profile = stringValue('profile')
  const template = stringValue('template')
  if (profile !== undefined && template !== undefined) {
    errors.push(`${scope}.excel cannot set both profile and template`)
  }
  return {
    ...whenDefined(profile, (presentProfile) => ({ profile: presentProfile })),
    ...whenDefined(template, (presentTemplate) => ({ template: presentTemplate })),
  }
}

function parseOutputArtifacts(
  val: YamlValue | undefined,
): WorkflowOutputArtifact[] | undefined {
  if (!Array.isArray(val)) return undefined
  return val.map((item) => {
    const artifact = item as YamlObject
    return {
      ...whenDefined(artifact.from_step ? str(artifact.from_step) : undefined, (from_step) => ({ from_step })),
      artifact: str(artifact.artifact),
      ...whenDefined(artifact.media_type ? str(artifact.media_type) : undefined, (media_type) => ({ media_type })),
      ...whenDefined(artifact.label ? str(artifact.label) : undefined, (label) => ({ label })),
    }
  })
}

function parseOutputArtifactGlobs(
  val: YamlValue | undefined,
): WorkflowTemplate['output']['secondary_artifact_globs'] {
  if (!Array.isArray(val)) return undefined
  return val.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    return {
      ...whenDefined(item.from_step ? str(item.from_step) : undefined, (from_step) => ({ from_step })),
      glob: str(item.glob),
      ...whenDefined(item.media_type ? str(item.media_type) : undefined, (media_type) => ({ media_type })),
      ...whenDefined(item.label ? str(item.label) : undefined, (label) => ({ label })),
    }
  })
}

function resolvePath(baseDir: string, p: string): string {
  if (!p) return p
  if (p.startsWith('~')) return path.join(homedir(), p.slice(1))
  if (path.isAbsolute(p)) return p
  return path.resolve(baseDir, p)
}

export function parseWorkflowRegistry(filePath: string): WorkflowRegistryParseResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { entries: [], errors: [`Cannot read workflow registry file: ${filePath}`], warnings: [] }
  }

  const raw = parseYaml(content)
  const baseDir = path.dirname(path.resolve(filePath))
  const entries: WorkflowRegistryEntry[] = []
  const errors: string[] = []
  const warnings: string[] = []

  for (const [name, value] of Object.entries(raw)) {
    const entry = value as YamlObject
    const templatePath = resolvePath(baseDir, str(entry.template_path, ''))
    if (!templatePath) {
      errors.push(`Workflow registry entry '${name}': template_path is required`)
      continue
    }
    if (!fs.existsSync(templatePath)) {
      warnings.push(`Workflow registry entry '${name}': template_path does not exist at parse time: ${templatePath}`)
    }

    entries.push({
      name,
      ...whenDefined(entry.description ? str(entry.description) : undefined, (definedValue) => ({ description: definedValue })),
      template_path: templatePath,
      ...whenDefined(parseStringList(entry.tags), (definedValue) => ({ tags: definedValue })),
      ...whenDefined(parseStringList(entry.capabilities), (definedValue) => ({ capabilities: definedValue })),
    })
  }

  return { entries, errors, warnings }
}

function parseStep(
  raw: YamlValue,
  scope: string,
  errors: string[],
): WorkflowStep {
  const value = raw as YamlObject
  const type = str(value.type, 'team') as WorkflowStep['type']
  const isHumanInput = type === 'human-in-the-loop'
  const wordOptions = parseWordOptions(value.word, scope, errors)
  if (value.word !== undefined && !wordOptions) {
    errors.push(`${scope}.word must be an object`)
  }
  const excelOptions = parseExcelOptions(value.excel, scope, errors)
  if (value.excel !== undefined && !excelOptions) {
    errors.push(`${scope}.excel must be an object`)
  }
  const mcpRequirements = normalizeMcpWorkflowRequirements(
    value.mcp_requirements,
    `${scope}.mcp_requirements`,
  )
  errors.push(...mcpRequirements.errors)
  const common = {
    id: str(value.id),
    type,
    input_artifact: str(value.input_artifact, 'incoming-brief.md'),
    result_artifact: str(value.result_artifact),
    ...whenDefined(value.handoff
      ? {
          from_step: str((value.handoff as YamlObject).from_step),
          from_artifact: str((value.handoff as YamlObject).from_artifact),
          to_artifact: str((value.handoff as YamlObject).to_artifact),
        }
      : undefined, (handoff) => ({ handoff })),
  }
  const authoredExecutionFields = {
    ...whenDefined(value.team ? str(value.team) : undefined, (team) => ({ team })),
    ...whenDefined(value.agent ? str(value.agent) : undefined, (agent) => ({ agent })),
    ...whenDefined(value.transform
      ? str(value.transform) as WorkflowStep['transform']
      : undefined, (transform) => ({ transform })),
    ...whenDefined(wordOptions, (word) => ({ word })),
    ...whenDefined(excelOptions, (excel) => ({ excel })),
    ...whenDefined(value.stage_type
      ? str(value.stage_type) as WorkflowStep['stage_type']
      : undefined, (stage_type) => ({ stage_type })),
    ...whenDefined(parseStringList(value.result_artifacts), (result_artifacts) => ({ result_artifacts })),
    ...whenDefined(parseStringList(value.result_artifact_globs), (result_artifact_globs) => ({ result_artifact_globs })),
    ...whenDefined(parseStringList(value.optional_result_artifact_globs), (optional_result_artifact_globs) => ({ optional_result_artifact_globs })),
    ...whenDefined(value.requested_result_type ? str(value.requested_result_type) : undefined, (requested_result_type) => ({ requested_result_type })),
    ...whenDefined(value.brief_prefix ? str(value.brief_prefix) : undefined, (brief_prefix) => ({ brief_prefix })),
    ...whenDefined(value.brief_suffix ? str(value.brief_suffix) : undefined, (brief_suffix) => ({ brief_suffix })),
    ...whenDefined(value.include_initial_brief != null
      ? String(value.include_initial_brief).toLowerCase() === 'true'
      : undefined, (include_initial_brief) => ({ include_initial_brief })),
    ...(mcpRequirements.requirements
      ? { mcp_requirements: mcpRequirements.requirements }
      : {}),
    ...whenDefined(value.runtime_overrides ? (value.runtime_overrides as TeamRuntimeOverrides) : undefined, (runtime_overrides) => ({ runtime_overrides })),
    ...whenDefined(value.recovery_policy
      ? str(value.recovery_policy) as WorkflowStep['recovery_policy']
      : undefined, (recovery_policy) => ({ recovery_policy })),
    ...whenDefined(parseArtifactHandoffs(value.context_handoffs), (context_handoffs) => ({ context_handoffs })),
    ...whenDefined(value.provenance_handoff
      ? {
          from_step: str((value.provenance_handoff as YamlObject).from_step),
          from_artifact: str((value.provenance_handoff as YamlObject).from_artifact),
          ...((value.provenance_handoff as YamlObject)
            .evidence_graph_artifact
            ? {
                evidence_graph_artifact: str(
                  (value.provenance_handoff as YamlObject)
                    .evidence_graph_artifact,
                ),
              }
            : {}),
          ...((value.provenance_handoff as YamlObject).audit_artifact
            ? {
                audit_artifact: str(
                  (value.provenance_handoff as YamlObject).audit_artifact,
                ),
              }
            : {}),
        }
      : undefined, (provenance_handoff) => ({ provenance_handoff })),
  }
  if (isHumanInput) {
    return {
      ...common,
      ...authoredExecutionFields,
      ...whenDefined(value.prompt ? str(value.prompt) : undefined, (prompt) => ({ prompt })),
    }
  }
  return {
    ...common,
    ...authoredExecutionFields,
    team: str(
      value.team,
      type === 'transform' ? BUILTIN_TRANSFORM_EXECUTOR : '',
    ),
    recovery_policy: authoredExecutionFields.recovery_policy ?? (
      type === 'transform' ? 'idempotent' : 'manual'
    ),
  }
}

export function parseWorkflowTemplate(filePath: string): WorkflowTemplateParseResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { template: null, errors: [`Cannot read workflow template: ${filePath}`] }
  }

  return parseWorkflowTemplateYaml(content, filePath)
}

export function parseWorkflowTemplateYaml(
  content: string,
  sourcePath = '<inline-workflow>',
): WorkflowTemplateParseResult {
  const raw = parseYaml(content)
  const workflow = (raw.workflow ?? raw) as YamlObject
  const stepsRaw = workflow.steps
  const errors: string[] = []

  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return { template: null, errors: [`Workflow template '${sourcePath}' must declare at least one step`] }
  }

  const workflowId = str(
    workflow.id,
    path.basename(sourcePath, path.extname(sourcePath)),
  )
  const workflowScope = `Workflow template '${sourcePath}'`
  const mcpRequirements = normalizeMcpWorkflowRequirements(
    workflow.mcp_requirements,
    `${workflowScope}.mcp_requirements`,
  )
  errors.push(...mcpRequirements.errors)
  const output = isYamlObject(workflow.output) ? workflow.output : undefined

  const template: WorkflowTemplate = {
    id: workflowId,
    ...whenDefined(workflow.description ? str(workflow.description) : undefined, (definedValue) => ({ description: definedValue })),
    ...whenDefined(parseStringList(workflow.matches), (definedValue) => ({ matches: definedValue })),
    ...(mcpRequirements.requirements
      ? { mcp_requirements: mcpRequirements.requirements }
      : {}),
    ...whenDefined(workflow.input ? { artifact: str((workflow.input as YamlObject).artifact, 'incoming-request.md') } : undefined, (definedValue) => ({ input: definedValue })),
    steps: stepsRaw.map((step, index) =>
      parseStep(step, `${workflowScope}.steps[${index}]`, errors),
    ),
    output: {
      from_step: str(output?.from_step),
      artifact: str(output?.artifact),
      ...whenDefined(parseOutputArtifacts(output?.secondary_artifacts), (secondary_artifacts) => ({ secondary_artifacts })),
      ...whenDefined(parseOutputArtifactGlobs(output?.primary_artifact_globs), (primary_artifact_globs) => ({ primary_artifact_globs })),
      ...whenDefined(parseOutputArtifactGlobs(output?.secondary_artifact_globs), (secondary_artifact_globs) => ({ secondary_artifact_globs })),
    },
    on_blocked: workflow.on_blocked ? str(workflow.on_blocked) as 'stop' | 'escalate_to_user' : 'stop',
    on_failed: workflow.on_failed ? str(workflow.on_failed) as 'stop' | 'escalate_to_user' : 'stop',
  }

  if (!template.output.from_step) errors.push(`Workflow template '${sourcePath}': output.from_step is required`)
  if (!template.output.artifact) errors.push(`Workflow template '${sourcePath}': output.artifact is required`)

  for (const step of template.steps) {
    if (!step.id) errors.push(`Workflow template '${sourcePath}': every step needs an id`)
    if (step.type !== 'team' && step.type !== 'agent' && step.type !== 'transform' && step.type !== 'human-in-the-loop') {
      errors.push(`Workflow template '${sourcePath}': step '${step.id || '?'}' type must be 'team', 'agent', 'transform', or 'human-in-the-loop'`)
    }
    if (step.type !== 'transform' && step.type !== 'human-in-the-loop' && !step.team) {
      errors.push(`Workflow template '${sourcePath}': step '${step.id || '?'}' needs team`)
    }
    if (step.type === 'agent' && !step.agent) {
      errors.push(`Workflow template '${sourcePath}': agent step '${step.id || '?'}' needs agent`)
    }
    if (step.type === 'transform' && !step.transform) {
      errors.push(`Workflow template '${sourcePath}': transform step '${step.id || '?'}' needs transform`)
    }
    if (!step.result_artifact) errors.push(`Workflow template '${sourcePath}': step '${step.id || '?'}' needs result_artifact`)
  }

  return errors.length > 0 ? { template: null, errors } : { template, errors: [] }
}
