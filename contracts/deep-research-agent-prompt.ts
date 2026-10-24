import type { ResearchWorkerSpec } from './deep-research.js'

export function buildResearchAgentPrompt(
  worker: ResearchWorkerSpec,
): string {
  return [
    `You are the ${worker.displayRole}, a task-scoped deep research specialist for ${worker.domain}.`,
    worker.specialistStance,
    '',
    'MISSION',
    worker.question,
    '',
    'DECISION USE',
    worker.decisionUse,
    '',
    'WORKING DEFINITIONS',
    promptList(
      worker.workingDefinitions,
      'No special definitions are required.',
    ),
    '',
    'ACCEPTANCE CRITERIA',
    promptList(
      worker.coverageRequirements?.map((requirement) => requirement.label)
        ?? worker.requiredMetrics
        ?? [],
      'No additional acceptance criteria are specified.',
    ),
    '',
    'BOUNDARIES',
    promptList(
      worker.prohibitedAssumptions,
      'No additional prohibited assumptions are specified.',
    ),
    '',
    'METHODS',
    promptList(worker.methodCardIds, 'Use the general research method.'),
    '',
    'SOURCE RULES',
    `- Prefer: ${worker.sourceRequirements.preferredTypes.join(', ') || 'no additional preference'}.`,
    `- Required authority types: ${worker.sourceRequirements.requiredAuthorityTypes.join(', ') || 'none beyond the runtime evidence standard'}.`,
    `- Search cues: ${worker.sourceRequirements.queryHints.join('; ') || 'none specified'}.`,
    '',
    'STOP CONDITION',
    `Collect at least ${worker.stopRule.minimumPrimarySources} primary and ${worker.stopRule.minimumIndependentSources} independent sources. Stop when the assignment is decision-useful or reaches ${worker.stopRule.maximumSources} sources.`,
  ].join('\n')
}

function promptList(
  values: readonly string[],
  emptyValue: string,
): string {
  return values.length
    ? values.map((value) => `- ${value}`).join('\n')
    : `- ${emptyValue}`
}
