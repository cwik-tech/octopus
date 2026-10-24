import type { LevelConfig, TeamConfig } from '../../core/types.js'
import { parseMarkdownArtifact } from '../runtime/artifacts.js'
import { deriveEffectiveStageContractsForTeam } from '../stage/stage-contracts.js'

export interface DelegatedRoutingAutostartPlan {
  outputArtifact: string
  systemPrompt: string
  userMessage: string
}

function extractUserRequest(markdown: string): string {
  const body = parseMarkdownArtifact(markdown).body.trim() || markdown.trim()
  const userMessages = [...body.matchAll(/(?:^|\n)USER:\s*([\s\S]*?)(?=\n\n(?:USER|ASSISTANT):|\n##\s+|$)/g)]
    .map((match) => match[1]?.trim())
    .filter((message): message is string => Boolean(message))
  return userMessages.join('\n\n') || body || 'No delegated request text was provided.'
}

export function buildDelegatedRoutingAutostartPlan(
  teamConfig: TeamConfig,
  level: LevelConfig,
  delegatedBrief: string,
  availableTeams: string[],
  outputArtifactOverride?: string,
  options: { humanQuestions?: boolean } = {},
): DelegatedRoutingAutostartPlan {
  const contracts = deriveEffectiveStageContractsForTeam(teamConfig, level.id)
  const configuredOutput = level.stage.type === 'routing'
    ? level.stage.config.output.path
      ? `${level.stage.config.output.path}/${level.stage.config.output.format}`
      : level.stage.config.output.format
    : undefined
  const outputArtifact = outputArtifactOverride?.trim()
    || contracts.output.completion_artifact
    || configuredOutput
    || 'routing-decision.md'
  const request = extractUserRequest(delegatedBrief)

  return {
    outputArtifact,
    systemPrompt: [
      'You produce a routing and clarification artifact for an already-started workflow step.',
      options.humanQuestions
        ? 'Use the managed question tool only for necessary missing facts. Do not spawn teams or wait for routine approval.'
        : 'Do not ask the user questions, call tools, spawn teams, or wait for approval.',
      'Treat missing angle, audience, and output-format details as non-blocking.',
      'Choose sensible defaults, state them explicitly, and preserve the original request.',
      'Return Markdown only, without YAML frontmatter.',
    ].join('\n'),
    userMessage: [
      '# Delegated request',
      '',
      request,
      '',
      '# Available specialist teams',
      '',
      availableTeams.length > 0 ? availableTeams.map((team) => `- ${team}`).join('\n') : '- None registered',
      '',
      '# Required artifact content',
      '',
      '- Summarize the request and its intended outcome.',
      '- Record reasonable defaults for every missing detail.',
      '- Recommend the best specialist team or next workflow stage.',
      '- Mark the request ready to proceed.',
    ].join('\n'),
  }
}
