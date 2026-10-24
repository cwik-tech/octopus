import { whenDefined } from '../core/optional-properties.js'
import { readAgentDetail } from '../domains/agent-generator/index.js'
import {
  readAgentModelChoice,
  resolveAgentModelChoice,
  type ModelSelectionError,
  type ModelSelectionResult,
} from '../contracts/agent-model-selection.js'
import { getRuntimeDefaultModelState } from '../domains/provider/default-model-selection.js'
import {
  createMcpProviderSupportResolver,
  mcpProviderSupportReason,
  type McpProviderSupportResolver,
} from '../domains/mcp/mcp-provider-support.js'
import type { McpAgentGrantServerView } from '../domains/mcp/mcp-agent-grant-view.js'
import { normalizeMcpAgentPath } from '../domains/mcp/mcp-settings.js'
import {
  McpSettingsServiceError,
  type McpSettingsService,
} from './mcp-settings-service.js'

export type { McpAgentGrantServerView }

export interface McpAgentGrantsServiceOptions {
  readonly repoRootPath: string
  readonly settingsService: McpSettingsService
  readonly providerSupportResolver?: McpProviderSupportResolver
}

export class McpAgentGrantsServiceError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'not_found'
      | 'provider_unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'McpAgentGrantsServiceError'
  }
}

export class McpAgentGrantsService {
  private readonly providerSupportResolver: McpProviderSupportResolver

  constructor(private readonly options: McpAgentGrantsServiceOptions) {
    this.providerSupportResolver =
      options.providerSupportResolver ?? createMcpProviderSupportResolver()
  }

  async listServers(agentName: string): Promise<McpAgentGrantServerView[]> {
    const agent = this.readAgent(agentName)
    // The pair this Agent will actually run with, resolved whole by the one
    // rule every other caller uses. Filling a missing half at a time asked
    // about `codex/default` — this repository's "nothing chosen" sentinel — so
    // an Agent that had chosen nothing was judged on the Codex CLI and refused
    // a grant its real pair supports.
    const reading = readAgentModelChoice({
      ...whenDefined(agent.provider, (provider) => ({ provider })),
      ...whenDefined(agent.model, (model) => ({ model })),
    })
    // A file this reading cannot make sense of is not a reason to use the
    // application default. Half a pair contradicts the default it would be
    // completed with, so treating it as "nothing chosen" would authorize a
    // grant on a pair the Agent's own file argues against.
    //
    // The reading's own error is carried through rather than restated: it
    // already says which half is missing, and a second wording here would be a
    // worse answer written twice. Checked first, so nothing invents one.
    const selection: ModelSelectionResult = reading.error
      ? { ok: false, error: reading.error }
      : resolveAgentModelChoice(
          reading.choice ?? { mode: 'app-default' },
          getRuntimeDefaultModelState(),
        )
    const [servers, grants, support] = await Promise.all([
      this.options.settingsService.listServers(),
      this.options.settingsService.listAgentGrants(),
      // Asked only about a pair that exists. Nothing usable is not a licence to
      // substitute one, and it is not an error here either: the rows still have
      // to list, so a granted server stays visible and revocable.
      selection.ok
        ? this.providerSupportResolver({
            provider: selection.selection.provider,
            model: selection.selection.model,
          })
        : null,
    ])
    const grantedServerIds = new Set(
      grants
        .filter((grant) => grant.agentPath === agent.agentPath && grant.enabled)
        .map((grant) => grant.serverId),
    )
    const compatible = support !== null &&
      (support.state === 'supported' || support.state === 'experimental')
    // The selection's own message when there is no pair, so a person is told
    // what is actually wrong rather than being sent to look at a CLI — and the
    // broken selection is named where the error knows it. A default that cannot
    // run stays identifiable precisely so somebody can go and fix *that* one;
    // "the application default is unavailable" on its own leaves them guessing.
    const reason = support === null
      ? (selection.ok ? undefined : describeSelectionFailure(selection.error))
      : mcpProviderSupportReason(support)
    return servers
      .filter((server) => server.enabled)
      .map((server) => ({
        id: server.id,
        name: server.name,
        transport: server.transport.type,
        status: server.status,
        enabled: server.enabled,
        granted: grantedServerIds.has(server.id),
        compatible,
        ...(support?.mode ? { providerSupportMode: support.mode } : {}),
        ...(support?.reasonCode
          ? { providerSupportReasonCode: support.reasonCode }
          : {}),
        ...(reason ? { reason } : {}),
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      )
  }

  async setGrant(
    agentName: string,
    serverId: string,
    enabled: boolean,
  ): Promise<McpAgentGrantServerView> {
    const agent = this.readAgent(agentName)
    const available = await this.listServers(agentName)
    const server = available.find((candidate) => candidate.id === serverId)
    if (!server) {
      throw new McpAgentGrantsServiceError(
        'not_found',
        'Globally enabled MCP server was not found.',
      )
    }
    if (enabled && !server.compatible) {
      throw new McpAgentGrantsServiceError(
        'provider_unsupported',
        server.reason ?? 'This agent provider does not support MCP tools.',
      )
    }
    try {
      const grant = await this.options.settingsService.setAgentGrant(
        agent.agentPath,
        serverId,
        enabled,
      )
      return { ...server, granted: grant.enabled }
    } catch (error) {
      if (error instanceof McpSettingsServiceError) throw error
      throw new McpAgentGrantsServiceError(
        'invalid_request',
        'MCP grant could not be updated.',
      )
    }
  }

  async deleteAgentGrants(agentName: string): Promise<number> {
    const agentPath = requireAgentPath(agentName)
    return this.options.settingsService.deleteAgentGrants(agentPath)
  }

  private readAgent(agentName: string): {
    agentPath: string
    provider?: string
    model?: string
  } {
    const agentPath = requireAgentPath(agentName)
    try {
      const agent = readAgentDetail(this.options.repoRootPath, agentName)
      return {
        agentPath,
        ...whenDefined(agent.provider, (provider) => ({ provider })),
        ...whenDefined(agent.model, (model) => ({ model })),
      }
    } catch {
      throw new McpAgentGrantsServiceError('not_found', 'Agent was not found.')
    }
  }
}

/**
 * Why this Agent has no usable pair, naming the pair when the error knows it.
 *
 * The selection errors keep provider and model as their own fields rather than
 * in the sentence, so a caller that displays only the message drops the one
 * thing a person needs to act on. This adds them and changes nothing else — the
 * code and category stay exactly as the selection reported them.
 */
function describeSelectionFailure(error: ModelSelectionError): string {
  if (!error.provider || !error.model) return error.message
  return `${error.message} (${error.provider} / ${error.model})`
}

function requireAgentPath(agentName: string): string {
  const normalizedName = agentName.trim()
  const agentPath = normalizeMcpAgentPath(`agents/${normalizedName}`)
  if (!agentPath || normalizedName.includes('/') || normalizedName.includes('\\')) {
    throw new McpAgentGrantsServiceError(
      'invalid_request',
      'Agent name is invalid.',
    )
  }
  return agentPath
}
