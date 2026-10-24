import * as path from 'node:path'

import type { RegistryEntry, TeamConfig } from '../core/types.js'
import { deriveEffectiveWorkflowTemplateContracts } from '../domains/stage/stage-contracts.js'
import { normalizeMcpWorkflowRequirements } from '../contracts/mcp-workflow-capabilities.js'
import type { WorkflowStep, WorkflowTemplate } from './types.js'
import { parseTeamConfig } from '../parsers/team-config.js'
import { STAGE_TYPE } from '../core/constants.js'
import {
  BUILTIN_TRANSFORM_EXECUTOR,
  workflowOutputArtifacts,
  workflowStepResultArtifacts,
} from './artifact-contracts.js'
import { loadWordProfile } from '../domains/word-generation/word-profiles.js'
import { loadExcelProfile } from '../domains/excel-generation/excel-profiles.js'

const WORKFLOW_STAGE_TYPES = new Set(Object.values(STAGE_TYPE))

/** True when a Workflow requires an interactive human response after launch. */
export function workflowRequiresHumanInput(template: WorkflowTemplate): boolean {
  return template.steps.some((step) => step.type === 'human-in-the-loop')
}

function levelOutputArtifact(
  level: TeamConfig['levels'][number],
): string {
  if (level.stage.type === STAGE_TYPE.PIPELINE) {
    return level.stage.config.output_contract?.completion_artifact ?? 'report.md'
  }
  const output = level.stage.config.output
  return output.path ? `${output.path}/${output.format}` : output.format
}

function normalizedArtifactRef(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function validateArtifactRef(
  workflowId: string,
  label: string,
  value: string,
): string | null {
  const normalized = normalizedArtifactRef(value)
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    return `Workflow '${workflowId}': ${label} must be a safe assignment-relative artifact path`
  }
  return null
}

function validateArtifactGlob(
  workflowId: string,
  label: string,
  value: string,
): string | null {
  const normalized = normalizedArtifactRef(value)
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((segment) =>
      segment === '..' || segment === '.' || (segment.includes('*') && segment !== '*'),
    )
  ) {
    return `Workflow '${workflowId}': ${label} must be a safe assignment-relative file glob`
  }
  if (!normalized.split('/').includes('*')) {
    return `Workflow '${workflowId}': ${label} must include a '*' path segment`
  }
  return null
}

export function validateWorkflowTemplate(
  template: WorkflowTemplate,
  teamRegistry: Map<string, RegistryEntry>,
): string[] {
  const errors: string[] = []
  const stepIds = new Set<string>()
  const priorSteps = new Map<string, WorkflowStep>()
  errors.push(
    ...normalizeMcpWorkflowRequirements(
      template.mcp_requirements,
      `Workflow '${template.id}': mcp_requirements`,
    ).errors,
  )

  for (const [stepIndex, step] of template.steps.entries()) {
    errors.push(
      ...normalizeMcpWorkflowRequirements(
        step.mcp_requirements,
        `Workflow '${template.id}': step '${step.id}' mcp_requirements`,
      ).errors,
    )
    if (stepIds.has(step.id)) {
      errors.push(`Workflow '${template.id}': duplicate step id '${step.id}'`)
    }
    if (step.type !== 'team' && step.type !== 'agent' && step.type !== 'transform' && step.type !== 'human-in-the-loop') {
      errors.push(
        `Workflow '${template.id}': step '${step.id}' type must be 'team', 'agent', 'transform', or 'human-in-the-loop'`,
      )
    }
    if (step.type === 'human-in-the-loop') {
      if (stepIndex === 0) {
        errors.push(`Workflow '${template.id}': human-in-the-loop step '${step.id}' cannot be the first step`)
      }
      if (stepIndex === template.steps.length - 1) {
        errors.push(`Workflow '${template.id}': human-in-the-loop step '${step.id}' cannot be the final step`)
      }
      const successor = template.steps[stepIndex + 1]
      if (successor && successor.type !== 'team' && successor.type !== 'agent') {
        errors.push(
          `Workflow '${template.id}': human-in-the-loop step '${step.id}' must be followed by a team or agent step`,
        )
      }
      if (!step.handoff) {
        errors.push(`Workflow '${template.id}': human-in-the-loop step '${step.id}' requires a handoff from the reviewed artifact`)
      }
      if (!step.result_artifact.toLowerCase().endsWith('.json')) {
        errors.push(`Workflow '${template.id}': human-in-the-loop step '${step.id}' result_artifact must be JSON`)
      }
      const incompatibleFields: Array<[string, unknown]> = [
        ['team', step.team],
        ['agent', step.agent],
        ['transform', step.transform],
        ['word', step.word],
        ['excel', step.excel],
        ['stage_type', step.stage_type],
        ['result_artifacts', step.result_artifacts],
        ['requested_result_type', step.requested_result_type],
        ['brief_prefix', step.brief_prefix],
        ['brief_suffix', step.brief_suffix],
        ['include_initial_brief', step.include_initial_brief],
        ['mcp_requirements', step.mcp_requirements],
        ['runtime_overrides', step.runtime_overrides],
        ['recovery_policy', step.recovery_policy],
        ['context_handoffs', step.context_handoffs],
        ['provenance_handoff', step.provenance_handoff],
      ]
      for (const [field, value] of incompatibleFields) {
        if (value !== undefined) {
          errors.push(
            `Workflow '${template.id}': human-in-the-loop step '${step.id}' must not declare ${field}`,
          )
        }
      }
    }
    if (step.stage_type && !WORKFLOW_STAGE_TYPES.has(step.stage_type)) {
      errors.push(
        `Workflow '${template.id}': step '${step.id}' references unknown stage type '${step.stage_type}'`,
      )
    }
    if (step.type === 'team' && step.agent) {
      errors.push(`Workflow '${template.id}': team step '${step.id}' must not declare agent`)
    }
    if (step.type === 'agent' && !step.agent) {
      errors.push(`Workflow '${template.id}': agent step '${step.id}' must declare agent`)
    }
    if (step.type === 'agent' && !step.stage_type) {
      errors.push(`Workflow '${template.id}': agent step '${step.id}' must declare stage_type`)
    }
    if (step.type === 'transform') {
      if ((step.mcp_requirements?.length ?? 0) > 0) {
        errors.push(
          `Workflow '${template.id}': transform step '${step.id}' must not declare mcp_requirements`,
        )
      }
      if (step.team !== BUILTIN_TRANSFORM_EXECUTOR) {
        errors.push(
          `Workflow '${template.id}': transform step '${step.id}' must use the built-in transform executor`,
        )
      }
      if (
        step.transform !== 'markdown_to_docx' &&
        step.transform !== 'generate_word' &&
        step.transform !== 'generate_excel'
      ) {
        errors.push(
          `Workflow '${template.id}': transform step '${step.id}' must declare transform 'generate_word', 'generate_excel', or compatibility alias 'markdown_to_docx'`,
        )
      }
      if (step.agent || step.stage_type || step.runtime_overrides) {
        errors.push(
          `Workflow '${template.id}': transform step '${step.id}' must not declare agent, stage_type, or runtime_overrides`,
        )
      }
      if (step.context_handoffs?.length) {
        errors.push(
          `Workflow '${template.id}': transform step '${step.id}' must not declare context_handoffs`,
        )
      }
      if ((step.recovery_policy ?? 'idempotent') !== 'idempotent') {
        errors.push(
          `Workflow '${template.id}': transform step '${step.id}' recovery_policy must be 'idempotent'`,
        )
      }
      const transformArtifacts = workflowStepResultArtifacts(step)
      const isExcelTransform = step.transform === 'generate_excel'
      const transformLabel = isExcelTransform ? 'Excel' : 'Word'
      const documentExtension = isExcelTransform ? '.xlsx' : '.docx'
      const templateInput = isExcelTransform && step.excel?.template !== undefined
      const sourceExtension = templateInput ? '.json' : '.md'
      if (
        step.transform === 'markdown_to_docx' &&
        !step.result_artifact.toLowerCase().endsWith('.md')
      ) {
        errors.push(
          `Workflow '${template.id}': markdown_to_docx step '${step.id}' primary result_artifact must be Markdown`,
        )
      }
      if (!transformArtifacts.some((artifact) => artifact.toLowerCase().endsWith(documentExtension))) {
        errors.push(
          `Workflow '${template.id}': ${transformLabel} transform step '${step.id}' must declare a ${documentExtension.slice(1).toUpperCase()} result artifact`,
        )
      }
      const unsupportedTransformArtifact = transformArtifacts.find((artifact) => {
        const extension = path.extname(artifact).toLowerCase()
        const isPublicationAudit =
          extension === '.json' &&
          normalizedArtifactRef(artifact) ===
            normalizedArtifactRef(
              step.provenance_handoff?.audit_artifact ?? '',
            )
        return (
          extension !== sourceExtension &&
          extension !== documentExtension &&
          !isPublicationAudit
        )
      })
      if (unsupportedTransformArtifact) {
        errors.push(
          `Workflow '${template.id}': ${transformLabel} transform step '${step.id}' cannot produce '${unsupportedTransformArtifact}'`,
        )
      }
      const transformInput = step.handoff?.from_artifact ?? step.input_artifact
      if (!transformInput.toLowerCase().endsWith(sourceExtension)) {
        errors.push(
          `Workflow '${template.id}': ${transformLabel} transform step '${step.id}' input artifact must be ${templateInput ? 'JSON template data' : 'Markdown'}`,
        )
      }
      if (
        step.word?.mermaid_failure !== undefined &&
        step.word.mermaid_failure !== 'error' &&
        step.word.mermaid_failure !== 'keep-code'
      ) {
        errors.push(
          `Workflow '${template.id}': Word transform step '${step.id}' mermaid_failure must be 'error' or 'keep-code'`,
        )
      }
      if (step.word?.profile) {
        try {
          loadWordProfile(step.word.profile)
        } catch (error) {
          errors.push(
            `Workflow '${template.id}': Word transform step '${step.id}' ${
              error instanceof Error ? error.message : 'uses an invalid profile'
            }`,
          )
        }
      }
      if (isExcelTransform && step.word) {
        errors.push(
          `Workflow '${template.id}': Excel transform step '${step.id}' must not declare word options`,
        )
      }
      if (!isExcelTransform && step.excel) {
        errors.push(
          `Workflow '${template.id}': Word transform step '${step.id}' must not declare excel options`,
        )
      }
      if (step.excel?.profile) {
        try {
          loadExcelProfile(step.excel.profile)
        } catch (error) {
          errors.push(
            `Workflow '${template.id}': Excel transform step '${step.id}' ${
              error instanceof Error ? error.message : 'uses an invalid profile'
            }`,
          )
        }
      }
    } else if (step.type !== 'human-in-the-loop') {
      if (step.word) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' word options are only supported on transform steps`,
        )
      }
      if (step.excel) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' excel options are only supported on transform steps`,
        )
      }
      if (step.provenance_handoff) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' provenance_handoff is only supported on transform steps`,
        )
      }
      if (step.context_handoffs?.length && step.type !== 'team') {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' context_handoffs are only supported on team steps`,
        )
      }
      const teamName = step.team
      const entry = teamName === undefined ? undefined : teamRegistry.get(teamName)
      if (teamName === undefined || !entry) {
        errors.push(`Workflow '${template.id}': step '${step.id}' references unknown team '${step.team}'`)
      } else if (entry.type !== 'team') {
        errors.push(`Workflow '${template.id}': step '${step.id}' references registry entry '${step.team}' which is not a team`)
      } else {
        const parsedTeam = parseTeamConfig(`${entry.team_path}/team.yaml`)
        if (parsedTeam.config) {
          // Validation reads the team config directly rather than through the
          // delegated resolver, so it is its own boundary. A team that is still
          // being assembled has no roster to run and cannot satisfy its own
          // completion gate; admitting it here reported no errors at all and
          // left the failure to run time.
          if (parsedTeam.config.team?.building === true) {
            errors.push(
              `Workflow '${template.id}': step '${step.id}' team '${step.team}' ` +
                `is still being built and cannot be run yet`,
            )
          }
          const selectedLevel = step.type === 'team' && step.stage_type
            ? parsedTeam.config.levels.find(
                (level) => level.stage.type === step.stage_type,
              )
            : undefined
          if (step.type === 'team' && step.stage_type && !selectedLevel) {
            errors.push(
              `Workflow '${template.id}': step '${step.id}' team '${step.team}' ` +
                `does not provide a '${step.stage_type}' stage`,
            )
          }
          if (
            step.type === 'agent' &&
            step.agent &&
            !parsedTeam.config.agents.some(
              (agent) => agent.type === 'agent' && agent.name === step.agent,
            )
          ) {
            errors.push(
              `Workflow '${template.id}': step '${step.id}' references unknown agent ` +
                `'${step.agent}' on team '${step.team}'`,
            )
          }
          const completionArtifact = step.type === 'agent'
            ? step.result_artifact
            : selectedLevel
              ? levelOutputArtifact(selectedLevel)
              : deriveEffectiveWorkflowTemplateContracts(
                  parsedTeam.config,
                ).output.completion_artifact
          if (
            completionArtifact &&
            normalizedArtifactRef(step.result_artifact) !==
              normalizedArtifactRef(completionArtifact)
          ) {
            errors.push(
              `Workflow '${template.id}': step '${step.id}' result_artifact ` +
                `'${step.result_artifact}' does not match team '${step.team}' ` +
                `completion artifact '${completionArtifact}'`,
            )
          }
          errors.push(
            ...validateStepRuntimeOverrides(
              template.id,
              step.id,
              teamName,
              parsedTeam.config,
              step.runtime_overrides,
            ),
          )
        } else {
          errors.push(
            `Workflow '${template.id}': step '${step.id}' cannot load team ` +
              `'${step.team}' configuration: ${parsedTeam.errors.join('; ') || 'team config could not be loaded'}`,
          )
        }
      }
    }

    const resultArtifacts = workflowStepResultArtifacts(step)
    if (resultArtifacts.length !== 1 + (step.result_artifacts?.filter(Boolean).length ?? 0)) {
      errors.push(
        `Workflow '${template.id}': step '${step.id}' result artifacts must be unique`,
      )
    }
    for (const [label, artifactRef] of [
      [`step '${step.id}' input_artifact`, step.input_artifact],
      ...resultArtifacts.map((artifactRef, artifactIndex) => [
        artifactIndex === 0
          ? `step '${step.id}' result_artifact`
          : `step '${step.id}' result_artifacts[${artifactIndex - 1}]`,
        artifactRef,
      ] as const),
    ] as const) {
      const artifactError = validateArtifactRef(template.id, label, artifactRef)
      if (artifactError) errors.push(artifactError)
    }
    for (const [globIndex, artifactGlob] of (step.result_artifact_globs ?? []).entries()) {
      const globError = validateArtifactGlob(
        template.id,
        `step '${step.id}' result_artifact_globs[${globIndex}]`,
        artifactGlob,
      )
      if (globError) errors.push(globError)
    }
    for (const [globIndex, artifactGlob] of (step.optional_result_artifact_globs ?? []).entries()) {
      const globError = validateArtifactGlob(
        template.id,
        `step '${step.id}' optional_result_artifact_globs[${globIndex}]`,
        artifactGlob,
      )
      if (globError) errors.push(globError)
    }

    if (!['safe_retry', 'idempotent', 'manual', 'never_retry'].includes(step.recovery_policy ?? 'manual')) {
      errors.push(
        `Workflow '${template.id}': step '${step.id}' recovery_policy must be ` +
          `'safe_retry', 'idempotent', 'manual', or 'never_retry'`,
      )
    }

    if (step.handoff && !stepIds.has(step.handoff.from_step)) {
      errors.push(
        `Workflow '${template.id}': step '${step.id}' handoff references prior step '${step.handoff.from_step}' that does not exist earlier in the workflow`,
      )
    } else if (step.handoff) {
      const sourceStep = priorSteps.get(step.handoff.from_step)
      const fromError = validateArtifactRef(
        template.id,
        `step '${step.id}' handoff.from_artifact`,
        step.handoff.from_artifact,
      )
      const toError = validateArtifactRef(
        template.id,
        `step '${step.id}' handoff.to_artifact`,
        step.handoff.to_artifact,
      )
      if (fromError) errors.push(fromError)
      if (toError) errors.push(toError)
      const fromArtifact = step.handoff.from_artifact
      if (
        sourceStep &&
        !workflowStepResultArtifacts(sourceStep).some(
          (artifact) =>
            normalizedArtifactRef(fromArtifact) ===
            normalizedArtifactRef(artifact),
        )
      ) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' handoff.from_artifact ` +
          `'${step.handoff.from_artifact}' does not match an artifact declared by step '${sourceStep.id}'`,
        )
      }
      if (
        normalizedArtifactRef(step.handoff.to_artifact) !== normalizedArtifactRef(step.input_artifact)
      ) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' handoff.to_artifact ` +
          `'${step.handoff.to_artifact}' does not match input_artifact '${step.input_artifact}'`,
        )
      }
    }

    const contextDestinations = new Set<string>()
    for (const [contextIndex, contextHandoff] of (
      step.context_handoffs ?? []
    ).entries()) {
      if (!stepIds.has(contextHandoff.from_step)) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' context_handoffs[${contextIndex}] ` +
            `references prior step '${contextHandoff.from_step}' that does not exist earlier in the workflow`,
        )
        continue
      }
      const sourceStep = priorSteps.get(contextHandoff.from_step)
      const fromError = validateArtifactRef(
        template.id,
        `step '${step.id}' context_handoffs[${contextIndex}].from_artifact`,
        contextHandoff.from_artifact,
      )
      const toError = validateArtifactRef(
        template.id,
        `step '${step.id}' context_handoffs[${contextIndex}].to_artifact`,
        contextHandoff.to_artifact,
      )
      if (fromError) errors.push(fromError)
      if (toError) errors.push(toError)
      const normalizedDestination = normalizedArtifactRef(
        contextHandoff.to_artifact,
      )
      if (contextDestinations.has(normalizedDestination)) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' context_handoffs must have unique destinations`,
        )
      }
      contextDestinations.add(normalizedDestination)
      if (
        sourceStep &&
        !workflowStepResultArtifacts(sourceStep).some(
          (artifact) =>
            normalizedArtifactRef(contextHandoff.from_artifact) ===
            normalizedArtifactRef(artifact),
        )
      ) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' context_handoffs[${contextIndex}].from_artifact ` +
            `'${contextHandoff.from_artifact}' does not match an artifact declared by step '${sourceStep.id}'`,
        )
      }
    }

    if (step.provenance_handoff && !stepIds.has(step.provenance_handoff.from_step)) {
      errors.push(
        `Workflow '${template.id}': step '${step.id}' provenance_handoff references prior step ` +
          `'${step.provenance_handoff.from_step}' that does not exist earlier in the workflow`,
      )
    } else if (step.provenance_handoff) {
      const sourceStep = priorSteps.get(step.provenance_handoff.from_step)
      const artifactError = validateArtifactRef(
        template.id,
        `step '${step.id}' provenance_handoff.from_artifact`,
        step.provenance_handoff.from_artifact,
      )
      if (artifactError) errors.push(artifactError)
      if (!step.provenance_handoff.from_artifact.toLowerCase().endsWith('.md')) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' provenance_handoff.from_artifact must be Markdown`,
        )
      }
      const fromArtifact = step.provenance_handoff.from_artifact
      if (
        sourceStep &&
        !workflowStepResultArtifacts(sourceStep).some(
          (artifact) =>
            normalizedArtifactRef(fromArtifact) ===
            normalizedArtifactRef(artifact),
        )
      ) {
        errors.push(
          `Workflow '${template.id}': step '${step.id}' provenance_handoff.from_artifact ` +
            `'${step.provenance_handoff.from_artifact}' does not match an artifact declared by step '${sourceStep.id}'`,
        )
      }
      if (step.provenance_handoff.evidence_graph_artifact) {
        const graphArtifact = step.provenance_handoff.evidence_graph_artifact
        const graphError = validateArtifactRef(
          template.id,
          `step '${step.id}' provenance_handoff.evidence_graph_artifact`,
          graphArtifact,
        )
        if (graphError) errors.push(graphError)
        if (!graphArtifact.toLowerCase().endsWith('.json')) {
          errors.push(
            `Workflow '${template.id}': step '${step.id}' provenance_handoff.evidence_graph_artifact must be JSON`,
          )
        }
        if (
          sourceStep &&
          !workflowStepResultArtifacts(sourceStep).some(
            (artifact) =>
              normalizedArtifactRef(graphArtifact) ===
              normalizedArtifactRef(artifact),
          )
        ) {
          errors.push(
            `Workflow '${template.id}': step '${step.id}' provenance_handoff.evidence_graph_artifact ` +
              `'${graphArtifact}' does not match an artifact declared by step '${sourceStep.id}'`,
          )
        }
      }
      if (step.provenance_handoff.audit_artifact) {
        const auditArtifact = step.provenance_handoff.audit_artifact
        const auditError = validateArtifactRef(
          template.id,
          `step '${step.id}' provenance_handoff.audit_artifact`,
          auditArtifact,
        )
        if (auditError) errors.push(auditError)
        if (!auditArtifact.toLowerCase().endsWith('.json')) {
          errors.push(
            `Workflow '${template.id}': step '${step.id}' provenance_handoff.audit_artifact must be JSON`,
          )
        }
        if (
          !workflowStepResultArtifacts(step).some(
            (artifact) =>
              normalizedArtifactRef(auditArtifact) ===
              normalizedArtifactRef(artifact),
          )
        ) {
          errors.push(
            `Workflow '${template.id}': step '${step.id}' provenance_handoff.audit_artifact ` +
              `'${auditArtifact}' must be declared as a result artifact`,
          )
        }
      }
    }
    stepIds.add(step.id)
    priorSteps.set(step.id, step)
  }

  if (!stepIds.has(template.output.from_step)) {
    errors.push(`Workflow '${template.id}': output.from_step '${template.output.from_step}' does not reference a declared step`)
  } else {
    const sourceStep = priorSteps.get(template.output.from_step)
    if (
      sourceStep &&
      !workflowStepResultArtifacts(sourceStep).some(
        (artifact) =>
          normalizedArtifactRef(template.output.artifact) ===
          normalizedArtifactRef(artifact),
      )
    ) {
      errors.push(
        `Workflow '${template.id}': output.artifact '${template.output.artifact}' does not match ` +
        `the artifacts declared by step '${sourceStep.id}'`,
      )
    }
  }

  const outputError = validateArtifactRef(template.id, 'output.artifact', template.output.artifact)
  if (outputError) errors.push(outputError)

  const outputKeys = new Set<string>()
  for (const outputArtifact of workflowOutputArtifacts(template)) {
    const sourceStep = priorSteps.get(outputArtifact.from_step)
    if (!sourceStep) {
      errors.push(
        `Workflow '${template.id}': output artifact '${outputArtifact.artifact}' references unknown step '${outputArtifact.from_step}'`,
      )
      continue
    }
    const artifactError = validateArtifactRef(
      template.id,
      `output artifact '${outputArtifact.artifact}'`,
      outputArtifact.artifact,
    )
    if (artifactError) errors.push(artifactError)
    if (!workflowStepResultArtifacts(sourceStep).some(
      (artifact) => normalizedArtifactRef(artifact) === normalizedArtifactRef(outputArtifact.artifact),
    )) {
      errors.push(
        `Workflow '${template.id}': output artifact '${outputArtifact.artifact}' is not declared by step '${outputArtifact.from_step}'`,
      )
    }
    const outputKey = `${outputArtifact.from_step}:${normalizedArtifactRef(outputArtifact.artifact)}`
    if (outputKeys.has(outputKey)) {
      errors.push(
        `Workflow '${template.id}': duplicate published output artifact '${outputArtifact.artifact}' from step '${outputArtifact.from_step}'`,
      )
    }
    outputKeys.add(outputKey)
  }

  for (const [globIndex, outputArtifact] of (
    [...(template.output.primary_artifact_globs ?? []), ...(template.output.secondary_artifact_globs ?? [])]
  ).entries()) {
    const fromStep = outputArtifact.from_step ?? template.output.from_step
    const sourceStep = priorSteps.get(fromStep)
    if (!sourceStep) {
      errors.push(
        `Workflow '${template.id}': output artifact glob '${outputArtifact.glob}' references unknown step '${fromStep}'`,
      )
      continue
    }
    const globError = validateArtifactGlob(
      template.id,
      `output.artifact_globs[${globIndex}].glob`,
      outputArtifact.glob,
    )
    if (globError) errors.push(globError)
    const declaredOutputGlobs = [
      ...(sourceStep.result_artifact_globs ?? []),
      ...(sourceStep.optional_result_artifact_globs ?? []),
    ]
    if (!declaredOutputGlobs.some(
      (declared) => normalizedArtifactRef(declared) === normalizedArtifactRef(outputArtifact.glob),
    )) {
      errors.push(
        `Workflow '${template.id}': output artifact glob '${outputArtifact.glob}' is not declared by step '${fromStep}'`,
      )
    }
  }

  if (!['stop', 'escalate_to_user'].includes(template.on_blocked ?? 'stop')) {
    errors.push(`Workflow '${template.id}': on_blocked must be 'stop' or 'escalate_to_user'`)
  }
  if (!['stop', 'escalate_to_user'].includes(template.on_failed ?? 'stop')) {
    errors.push(`Workflow '${template.id}': on_failed must be 'stop' or 'escalate_to_user'`)
  }

  return errors
}

function validateStepRuntimeOverrides(
  workflowId: string,
  stepId: string,
  teamId: string,
  teamConfig: TeamConfig,
  runtimeOverrides: WorkflowTemplate['steps'][number]['runtime_overrides'],
): string[] {
  if (!runtimeOverrides?.levels) return []

  const errors: string[] = []
  const agentNames = new Set(teamConfig.agents.map((agent) => agent.name))
  for (const [levelId, override] of Object.entries(runtimeOverrides.levels)) {
    const level = teamConfig.levels.find((candidate) => candidate.id === levelId)
    if (!level) {
      errors.push(
        `Workflow '${workflowId}': step '${stepId}' runtime_overrides references unknown level '${levelId}' on team '${teamId}'`,
      )
      continue
    }

    if (override.discussion) {
      if (level.stage.type !== 'discussion') {
        errors.push(
          `Workflow '${workflowId}': step '${stepId}' runtime_overrides level '${levelId}' declares discussion settings, but team '${teamId}' level is type '${level.stage.type}'`,
        )
      } else {
        const missingParticipants = (override.discussion.participants ?? []).filter(
          (participant) => !agentNames.has(participant),
        )
        if (missingParticipants.length > 0) {
          errors.push(
            `Workflow '${workflowId}': step '${stepId}' runtime_overrides level '${levelId}' references unknown discussion participants on team '${teamId}': ${missingParticipants.join(', ')}`,
          )
        }
      }
    }

    if (override.review && level.stage.type !== 'review') {
      errors.push(
        `Workflow '${workflowId}': step '${stepId}' runtime_overrides level '${levelId}' declares review settings, but team '${teamId}' level is type '${level.stage.type}'`,
      )
    }
  }

  return errors
}
