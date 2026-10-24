import type { McpProviderSupportMode } from './mcp-runtime.js'
import type { McpConnectionStatus, McpTransportKind } from './mcp-settings.js'

/**
 * One globally enabled MCP connection as the Agent Tools tab shows it: its
 * identity, state, this Agent's grant, and whether the Agent's pair can use it.
 *
 * Deliberately carries no connection configuration. Commands, arguments,
 * working directories, URLs, header and environment names, OAuth metadata and
 * every secret stay in `McpServerSettings`, so this is the only MCP shape that
 * may be described to a model.
 */
export interface McpAgentGrantServerView {
  readonly id: string
  readonly name: string
  readonly transport: McpTransportKind
  readonly status: McpConnectionStatus
  readonly enabled: boolean
  readonly granted: boolean
  readonly compatible: boolean
  readonly providerSupportMode?: McpProviderSupportMode
  readonly providerSupportReasonCode?: string
  readonly reason?: string
}
