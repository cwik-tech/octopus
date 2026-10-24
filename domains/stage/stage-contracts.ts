import { whenDefined } from '../../core/optional-properties.js'
import * as path from 'node:path'
import { STAGE_TYPE } from '../../core/constants.js'
import type {
  LevelConfig,
  OutputConfig,
  StageArtifactContract,
  StageInputContract,
  StageOutputContract,
  TeamConfig,
  WorkflowTemplateConfig,
} from '../../core/types.js'

export interface EffectiveStageContracts {
  input: StageInputContract
  output: StageOutputContract
}

export interface EffectiveWorkflowTemplateContracts {
  entry_level: string | undefined
  input: StageInputContract
  output: StageOutputContract
  capabilities?: string[]
  invocation_modes?: Array<'user' | 'external' | 'team'>
  user_facing?: boolean
}

function dedupeArtifacts(artifacts: StageArtifactContract[] | undefined): StageArtifactContract[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined
  const seen = new Set<string>()
  const deduped: StageArtifactContract[] = []
  for (const artifact of artifacts) {
    if (!artifact.path || seen.has(artifact.path)) continue
    seen.add(artifact.path)
    deduped.push(artifact)
  }
  return deduped.length > 0 ? deduped : undefined
}

function getConfiguredOutput(level: LevelConfig): OutputConfig | undefined {
  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
    case STAGE_TYPE.DISCUSSION:
    case STAGE_TYPE.CHAIN:
    case STAGE_TYPE.BROADCAST:
    case STAGE_TYPE.REVIEW:
      return level.stage.config.output
    case STAGE_TYPE.PIPELINE:
      return undefined
  }
}

function resolveConfiguredArtifactPath(output: OutputConfig | undefined): string | undefined {
  if (!output?.format) return undefined
  if (!output.path) return output.format
  return path.join(output.path, output.format)
}

function getDeclaredOutputContract(level: LevelConfig): StageOutputContract | undefined {
  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
    case STAGE_TYPE.DISCUSSION:
    case STAGE_TYPE.PIPELINE:
    case STAGE_TYPE.CHAIN:
    case STAGE_TYPE.BROADCAST:
    case STAGE_TYPE.REVIEW:
      return level.stage.config.output_contract
  }
}

function getDeclaredInputContract(level: LevelConfig): StageInputContract | undefined {
  switch (level.stage.type) {
    case STAGE_TYPE.ROUTING:
    case STAGE_TYPE.DISCUSSION:
    case STAGE_TYPE.PIPELINE:
    case STAGE_TYPE.CHAIN:
    case STAGE_TYPE.BROADCAST:
    case STAGE_TYPE.REVIEW:
      return level.stage.config.input_contract
  }
}

export function deriveEffectiveStageContracts(
  levels: LevelConfig[],
  currentLevelId: string,
): EffectiveStageContracts {
  const currentIndex = levels.findIndex((level) => level.id === currentLevelId)
  if (currentIndex === -1) {
    return { input: {}, output: {} }
  }

  const currentLevel = levels[currentIndex]
  if (!currentLevel) return { input: {}, output: {} }
  const previousLevel = currentIndex > 0 ? levels[currentIndex - 1] : undefined

  const declaredInput = getDeclaredInputContract(currentLevel)
  const declaredOutput = getDeclaredOutputContract(currentLevel)
  const configuredOutput = getConfiguredOutput(currentLevel)
  const previousConfiguredOutput = previousLevel ? getConfiguredOutput(previousLevel) : undefined
  const configuredOutputArtifactPath = resolveConfiguredArtifactPath(configuredOutput)
  const previousOutputArtifactPath = resolveConfiguredArtifactPath(previousConfiguredOutput)

  const inputArtifacts = dedupeArtifacts([
    ...(declaredInput?.artifacts ?? []),
    ...(previousOutputArtifactPath
      ? [{ path: previousOutputArtifactPath, required: true, description: 'Previous level output artifact' }]
      : []),
  ])

  const outputArtifacts = dedupeArtifacts([
    ...(declaredOutput?.artifacts ?? []),
    ...(configuredOutputArtifactPath
      ? [{ path: configuredOutputArtifactPath, required: true, description: 'Stage output artifact' }]
      : []),
  ])

  const completionArtifact = declaredOutput?.completion_artifact ?? configuredOutputArtifactPath

  return {
    input: {
      ...whenDefined(inputArtifacts, (artifacts) => ({ artifacts })),
      ...whenDefined(declaredInput?.structured, (structured) => ({ structured })),
    },
    output: {
      ...whenDefined(outputArtifacts, (artifacts) => ({ artifacts })),
      ...whenDefined(declaredOutput?.structured, (structured) => ({ structured })),
      ...whenDefined(completionArtifact, (completion_artifact) => ({ completion_artifact })),
    },
  }
}

function getEntryLevelId(teamConfig: TeamConfig): string | undefined {
  return teamConfig.workflow?.entry_level ?? teamConfig.levels[0]?.id
}

function getTerminalLevelInfo(teamConfig: TeamConfig): {
  terminalLevelId: string | undefined
  terminalArtifactGateArtifact: string | undefined
} {
  const terminalArtifactGate = teamConfig.gates.find(
    (gate) => gate.to === 'done' && gate.condition.type === 'artifact_exists',
  )

  return {
    terminalLevelId: terminalArtifactGate?.from ?? teamConfig.levels[teamConfig.levels.length - 1]?.id,
    terminalArtifactGateArtifact:
      terminalArtifactGate?.condition.type === 'artifact_exists' ? terminalArtifactGate.condition.artifact : undefined,
  }
}

export function deriveEffectiveStageContractsForTeam(
  teamConfig: TeamConfig,
  currentLevelId: string,
): EffectiveStageContracts {
  const workflow: WorkflowTemplateConfig | undefined = teamConfig.workflow
  const derived = deriveEffectiveStageContracts(teamConfig.levels, currentLevelId)
  const entryLevelId = getEntryLevelId(teamConfig)
  const { terminalLevelId, terminalArtifactGateArtifact } = getTerminalLevelInfo(teamConfig)

  return {
    input: currentLevelId === entryLevelId
      ? mergeInputContracts(workflow?.input_contract, derived.input)
      : derived.input,
    output: currentLevelId === terminalLevelId
      ? {
          ...mergeOutputContracts(workflow?.output_contract, derived.output),
          ...whenDefined(
            workflow?.output_contract?.completion_artifact ??
            terminalArtifactGateArtifact ??
            derived.output.completion_artifact,
            (completion_artifact) => ({ completion_artifact }),
          ),
        }
      : derived.output,
  }
}

function mergeInputContracts(
  declared: StageInputContract | undefined,
  derived: StageInputContract,
): StageInputContract {
  return {
    ...whenDefined(dedupeArtifacts([
      ...(declared?.artifacts ?? []),
      ...(derived.artifacts ?? []),
    ]), (artifacts) => ({ artifacts })),
    ...whenDefined(declared?.structured ?? derived.structured, (structured) => ({ structured })),
  }
}

function mergeOutputContracts(
  declared: StageOutputContract | undefined,
  derived: StageOutputContract,
): StageOutputContract {
  return {
    ...whenDefined(dedupeArtifacts([
      ...(declared?.artifacts ?? []),
      ...(derived.artifacts ?? []),
    ]), (artifacts) => ({ artifacts })),
    ...whenDefined(declared?.structured ?? derived.structured, (structured) => ({ structured })),
    ...whenDefined(declared?.completion_artifact ?? derived.completion_artifact, (completion_artifact) => ({ completion_artifact })),
  }
}

export function deriveEffectiveWorkflowTemplateContracts(
  teamConfig: TeamConfig,
): EffectiveWorkflowTemplateContracts {
  const workflow: WorkflowTemplateConfig | undefined = teamConfig.workflow
  const entryLevelId = getEntryLevelId(teamConfig)
  const { terminalLevelId, terminalArtifactGateArtifact } = getTerminalLevelInfo(teamConfig)

  const derivedEntryContracts = entryLevelId
    ? deriveEffectiveStageContractsForTeam(teamConfig, entryLevelId)
    : { input: {}, output: {} }
  const derivedTerminalContracts = terminalLevelId
    ? deriveEffectiveStageContractsForTeam(teamConfig, terminalLevelId)
    : { input: {}, output: {} }

  const outputCompletionArtifact =
    workflow?.output_contract?.completion_artifact ??
    terminalArtifactGateArtifact ??
    derivedTerminalContracts.output.completion_artifact

  return {
    entry_level: entryLevelId,
    input: derivedEntryContracts.input,
    output: {
      ...derivedTerminalContracts.output,
      ...whenDefined(outputCompletionArtifact, (completion_artifact) => ({ completion_artifact })),
    },
    ...whenDefined(workflow?.capabilities, (definedValue) => ({ capabilities: definedValue })),
    ...whenDefined(workflow?.invocation_modes, (definedValue) => ({ invocation_modes: definedValue })),
    ...whenDefined(workflow?.user_facing, (definedValue) => ({ user_facing: definedValue })),
  }
}
