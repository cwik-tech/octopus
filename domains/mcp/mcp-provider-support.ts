import {
  CONFIGURED_PROVIDER_PREFIX,
  type LocalCliAgentView,
  type ProviderConnectionView,
  type ProviderSettingsSnapshot,
} from '../provider/provider-settings.js'
import type { McpProviderSupport } from './mcp-runtime.js'

export interface McpProviderTarget {
  readonly provider: string
  readonly model?: string
}

export interface McpProviderResolution extends McpProviderSupport {
  /** Concrete model selected for a provider-owned alias such as `default`. */
  readonly resolvedModel?: string
}

export type McpProviderSupportResolver = (
  target: McpProviderTarget,
) => McpProviderResolution | Promise<McpProviderResolution>

export interface McpProviderConnectionReader {
  listConnections(): Promise<ProviderConnectionView[]>
  listCliAgents?(forceRefresh?: boolean): Promise<LocalCliAgentView[]>
  snapshot?(refreshCli?: boolean): Promise<ProviderSettingsSnapshot>
}

const OPENAI_COMPATIBLE_TOOL_PROVIDERS = new Set([
  'openai',
  'openrouter',
  'deepseek',
  'kimi',
  'xai',
  'lm-studio',
])

const CLI_HOST_TOOL_BRIDGE_PROVIDERS = new Set([
  'codex',
  'claude',
  'kimi-cli',
])

/** Static capability only; readiness and enabled-model checks still run at dispatch. */
export function hasMcpProviderAdapter(provider: string): boolean {
  return provider.startsWith(CONFIGURED_PROVIDER_PREFIX) || OPENAI_COMPATIBLE_TOOL_PROVIDERS.has(provider) ||
    CLI_HOST_TOOL_BRIDGE_PROVIDERS.has(provider)
}

export function createMcpProviderSupportResolver(
  connectionReader?: McpProviderConnectionReader,
): McpProviderSupportResolver {
  return async (target) => {
    const provider = target.provider.trim()
    if (!provider) return unsupported(provider, 'provider_missing')

    if (provider.startsWith(CONFIGURED_PROVIDER_PREFIX)) {
      return resolveConfiguredProviderSupport(
        provider,
        target.model,
        connectionReader,
      )
    }

    if (OPENAI_COMPATIBLE_TOOL_PROVIDERS.has(provider)) {
      return {
        provider,
        state: 'supported',
        mode: 'native-tool-loop',
      }
    }

    if (CLI_HOST_TOOL_BRIDGE_PROVIDERS.has(provider)) {
      return resolveCliProviderSupport(
        provider,
        target.model,
        connectionReader,
      )
    }

    return unsupported(provider, 'provider_adapter_unavailable')
  }
}

export function mcpProviderSupportReason(support: McpProviderSupport): string | undefined {
  if (support.state === 'supported' || support.state === 'experimental') {
    return undefined
  }
  switch (support.reasonCode) {
    case 'provider_missing':
      return 'This agent has no configured provider.'
    case 'configured_provider_unavailable':
      return 'The configured AI provider no longer exists.'
    case 'configured_provider_disabled':
      return 'Enable this agent’s AI provider before granting MCP access.'
    case 'configured_provider_disconnected':
      return 'Reconnect this agent’s AI provider before granting MCP access.'
    case 'configured_model_unavailable':
      return 'Enable this agent’s configured model before granting MCP access.'
    case 'cli_unavailable':
      return `${cliProviderLabel(support.provider)} is not installed or is not available on PATH.`
    case 'cli_disabled':
      return `Enable ${cliProviderLabel(support.provider)} in AI Providers before granting MCP access.`
    case 'cli_model_unavailable':
      return `Enable this agent’s configured ${cliProviderLabel(support.provider)} model before granting MCP access.`
    case 'cli_mcp_bridge_unavailable':
      return `${cliProviderLabel(support.provider)} could not be checked for secure MCP support. Refresh AI Providers and try again.`
    case 'cli_mcp_config_unsupported':
      return `Update ${cliProviderLabel(support.provider)} to a version that supports isolated MCP configuration.`
    case 'cli_tool_isolation_unsupported':
      return `${cliProviderLabel(support.provider)} cannot safely isolate Pipeline MCP tools from its other executable tools.`
    default:
      return 'This agent provider does not yet support the parent MCP tool loop.'
  }
}

async function resolveCliProviderSupport(
  provider: string,
  model: string | undefined,
  connectionReader: McpProviderConnectionReader | undefined,
): Promise<McpProviderResolution> {
  if (!connectionReader?.listCliAgents) {
    return unsupported(provider, 'cli_mcp_bridge_unavailable')
  }
  let cliAgents: LocalCliAgentView[]
  try {
    cliAgents = await connectionReader.listCliAgents(false)
  } catch {
    return unsupported(provider, 'cli_mcp_bridge_unavailable')
  }
  const agent = cliAgents.find((candidate) => candidate.id === provider)
  if (!agent?.available) return unsupported(provider, 'cli_unavailable')
  if (!agent.enabled) return unsupported(provider, 'cli_disabled')
  const normalizedModel = model?.trim()
  const resolvedModel = normalizedModel === 'default'
    ? await resolveCliDefaultModel(provider, agent, connectionReader)
    : normalizedModel
  if (
    normalizedModel === 'default' &&
    !resolvedModel
  ) {
    return unsupported(provider, 'cli_model_unavailable')
  }
  if (
    resolvedModel &&
    !agent.models.some(
      (candidate) => candidate.id === resolvedModel && candidate.enabled,
    )
  ) {
    return unsupported(provider, 'cli_model_unavailable')
  }
  if (!agent.mcpBridge?.supported) {
    return unsupported(
      provider,
      agent.mcpBridge?.reasonCode ?? 'cli_mcp_bridge_unavailable',
    )
  }
  return {
    provider,
    state: 'supported',
    mode: 'host-tool-bridge',
    ...(resolvedModel && resolvedModel !== normalizedModel
      ? { resolvedModel }
      : {}),
  }
}

async function resolveCliDefaultModel(
  provider: string,
  agent: LocalCliAgentView,
  connectionReader: McpProviderConnectionReader,
): Promise<string | undefined> {
  if (agent.models.some(
    (candidate) => candidate.id === 'default' && candidate.enabled,
  )) {
    return 'default'
  }
  if (!connectionReader.snapshot) return undefined
  let snapshot: ProviderSettingsSnapshot
  try {
    snapshot = await connectionReader.snapshot(false)
  } catch {
    return undefined
  }
  const selection = snapshot.defaultModel
  if (
    !selection ||
    selection.provider !== provider ||
    selection.model === 'default'
  ) {
    return undefined
  }
  return agent.models.some(
    (candidate) => candidate.id === selection.model && candidate.enabled,
  )
    ? selection.model
    : undefined
}

async function resolveConfiguredProviderSupport(
  provider: string,
  model: string | undefined,
  connectionReader: McpProviderConnectionReader | undefined,
): Promise<McpProviderSupport> {
  if (!connectionReader) {
    return unsupported(provider, 'configured_provider_unavailable')
  }
  const connectionId = provider.slice(CONFIGURED_PROVIDER_PREFIX.length)
  const connection = (await connectionReader.listConnections()).find(
    (candidate) => candidate.id === connectionId,
  )
  if (!connection) return unsupported(provider, 'configured_provider_unavailable')
  if (!connection.enabled) return unsupported(provider, 'configured_provider_disabled')
  if (connection.status !== 'connected') {
    return unsupported(provider, 'configured_provider_disconnected')
  }
  const normalizedModel = model?.trim()
  if (
    normalizedModel &&
    !connection.models.some(
      (candidate) => candidate.id === normalizedModel && candidate.enabled,
    )
  ) {
    return unsupported(provider, 'configured_model_unavailable')
  }
  return {
    provider,
    state: 'supported',
    mode: 'native-tool-loop',
  }
}

function unsupported(provider: string, reasonCode: string): McpProviderSupport {
  return {
    provider,
    state: 'unsupported',
    reasonCode,
  }
}

function cliProviderLabel(provider: string): string {
  switch (provider) {
    case 'codex':
      return 'Codex CLI'
    case 'claude':
      return 'Claude Code'
    case 'kimi-cli':
      return 'Kimi Code CLI'
    default:
      return 'This CLI provider'
  }
}
