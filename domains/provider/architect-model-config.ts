/** Provider-owned workflow architect model configuration. */

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseYaml, type YamlObject } from '../../core/yaml-parser.js'
import {
  readAgentModelChoice,
  resolveAgentModelChoice,
  type ModelSelection,
  type ModelSelectionError,
} from '../../contracts/agent-model-selection.js'
import { getRuntimeDefaultModelState } from './default-model-selection.js'
import {
  parseAgentFrontmatter,
  readAgentProviderOptions,
} from '../../parsers/load-agent.js'
import { readThinkingLevel, type ThinkingLevel } from '../../core/types.js'
import { getRuntimeDefaultEffort } from './default-effort-selection.js'

export interface WorkflowArchitectConfig {
  /** Empty when the architect's own selection could not be resolved. */
  model: string
  provider: string
  /**
   * The reasoning level the Agent declared, defaulting to `medium`.
   *
   * The Architect is an Agent, so its own file decides this rather than a
   * caller. Note that `callModel` currently forwards it to CLI adapters only.
   */
  thinking: ThinkingLevel
  /**
   * The Agent's own provider settings, read by the same parser every other
   * surface uses so one path cannot accept what another refuses.
   */
  providerOptions: Record<string, string | number | boolean>
  /** Why those settings could not be used at all, if they could not. */
  providerOptionsError?: string
  systemPrompt: string
  /** Where the pair came from, so the Create surface can disclose default use. */
  selection: ModelSelection | null
  /**
   * Why the architect has no pair of its own. Reported rather than thrown, so
   * a caller who supplies an explicit ad hoc choice for one authoring turn is
   * not blocked by the architect's own unresolved configuration.
   */
  selectionError?: ModelSelectionError
}

export class WorkflowArchitectNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowArchitectNotConfiguredError'
  }
}

/**
 * Reads the workflow-architect team config and returns the model/provider it
 * declares plus the agent's markdown system prompt body.
 */
export function loadArchitectConfig(repoRoot: string): WorkflowArchitectConfig {
  const teamYamlPath = path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml')
  if (!fs.existsSync(teamYamlPath)) {
    throw new WorkflowArchitectNotConfiguredError(
      `workflow-architect team.yaml not found at ${teamYamlPath}`,
    )
  }

  let teamYaml: YamlObject
  try {
    teamYaml = parseYaml(fs.readFileSync(teamYamlPath, 'utf8'))
  } catch (error) {
    throw new WorkflowArchitectNotConfiguredError(
      `Failed to parse workflow-architect team.yaml: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const agentsBlock = teamYaml.agents
  const firstAgent = Array.isArray(agentsBlock) && agentsBlock.length > 0 ? agentsBlock[0] : null
  if (!firstAgent || typeof firstAgent !== 'object' || Array.isArray(firstAgent)) {
    throw new WorkflowArchitectNotConfiguredError(
      'workflow-architect team.yaml must declare agents[0]',
    )
  }
  const agentFileRel = (firstAgent as YamlObject).agent_file
  if (typeof agentFileRel !== 'string' || !agentFileRel) {
    throw new WorkflowArchitectNotConfiguredError(
      'workflow-architect agents[0].agent_file is required',
    )
  }

  const agentFilePath = path.resolve(path.dirname(teamYamlPath), agentFileRel)
  if (!fs.existsSync(agentFilePath)) {
    throw new WorkflowArchitectNotConfiguredError(
      `Failed to read agent prompt at ${agentFilePath}: file not found`,
    )
  }
  // The architect is an agent like any other: it runs with its own declared
  // pair, or with the one application default, and its prompt is the file's
  // body. Its frontmatter is configuration, so it never enters the prompt.
  let frontmatter: Record<string, string>
  let systemPrompt: string
  try {
    ;({ frontmatter, body: systemPrompt } = parseAgentFrontmatter(agentFilePath))
  } catch (error) {
    throw new WorkflowArchitectNotConfiguredError(
      `Failed to read agent prompt at ${agentFilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const reading = readAgentModelChoice({
    provider: frontmatter.provider,
    model: frontmatter.model,
  })
  const resolved = reading.choice
    ? resolveAgentModelChoice(reading.choice, getRuntimeDefaultModelState())
    : ({ ok: false, error: reading.error } as const)
  const selection = resolved.ok ? resolved.selection : null
  // §4.3 gives an Agent its own settings, and this Architect is one. Read with
  // the same parser the Agent loader and the other Architect use.
  const providerOptions = readAgentProviderOptions(frontmatter.provider_options)
  return {
    model: selection?.model ?? '',
    provider: selection?.provider ?? '',
    thinking: readThinkingLevel(frontmatter.thinking, getRuntimeDefaultEffort()),
    providerOptions: providerOptions.options,
    ...whenDefined(providerOptions.diagnostics[0], (diagnostic) => ({
      providerOptionsError: diagnostic.message,
    })),
    systemPrompt,
    selection,
    ...(resolved.ok || !resolved.error ? {} : { selectionError: resolved.error }),
  }
}
