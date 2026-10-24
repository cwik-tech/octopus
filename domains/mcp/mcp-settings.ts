import {
  normalizeMcpCapabilityName,
  type McpCapabilityAccess,
} from '../../contracts/mcp.js'

export const MCP_SETTINGS_SCHEMA_VERSION = 1 as const
export const MCP_NEW_SERVER_ENABLED_BY_DEFAULT = true as const
export const MCP_ABSENT_AGENT_GRANT_ENABLED = false as const

export type McpTransportKind = 'stdio' | 'streamable-http'
export { normalizeMcpCapabilityName }
export type { McpCapabilityAccess }

export interface McpCapabilityAliasInput {
  readonly capability: string
  readonly access?: McpCapabilityAccess
}

export interface McpCapabilityAlias {
  readonly capability: string
  readonly access: McpCapabilityAccess
}

export type McpSecretValueInput =
  | { readonly operation: 'preserve' }
  | { readonly operation: 'replace'; readonly value: string }
  | { readonly operation: 'remove' }

export type McpSecretInputMap = Readonly<Record<string, McpSecretValueInput>>

export interface McpEncryptedSecret {
  readonly format: 'opaque-platform-ciphertext'
  readonly ciphertext: string
}

export type McpEncryptedSecretMap = Readonly<Record<string, McpEncryptedSecret>>

export interface McpStdioTransportInput {
  readonly type: 'stdio'
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Secret values must be supplied here, never embedded in command arguments. */
  readonly secretEnvironment?: McpSecretInputMap
}

export type McpOAuthAuthorizationStatus =
  | 'not-authorized'
  | 'authorization-required'
  | 'authorized'
  | 'expired'
  | 'error'

export interface McpOAuthInputMetadata {
  readonly type: 'oauth'
  readonly authorizationServerUrl?: string
  readonly clientId?: string
  readonly scopes?: readonly string[]
  readonly secretCredentials?: McpSecretInputMap
}

export type McpStreamableHttpAuthenticationInput =
  | { readonly type: 'none' }
  | { readonly type: 'secret-headers' }
  | McpOAuthInputMetadata

export interface McpStreamableHttpTransportInput {
  readonly type: 'streamable-http'
  readonly url: string
  readonly secretHeaders?: McpSecretInputMap
  readonly authentication?: McpStreamableHttpAuthenticationInput
}

export type McpTransportInput =
  | McpStdioTransportInput
  | McpStreamableHttpTransportInput

export interface McpStdioTransportSettings {
  readonly type: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly encryptedEnvironment: McpEncryptedSecretMap
}

export interface McpOAuthSettingsMetadata {
  readonly type: 'oauth'
  readonly authorizationServerUrl?: string
  readonly clientId?: string
  readonly scopes: readonly string[]
  readonly status: McpOAuthAuthorizationStatus
  readonly encryptedCredentials: McpEncryptedSecretMap
}

export type McpStreamableHttpAuthenticationSettings =
  | { readonly type: 'none' }
  | { readonly type: 'secret-headers' }
  | McpOAuthSettingsMetadata

export interface McpStreamableHttpTransportSettings {
  readonly type: 'streamable-http'
  readonly url: string
  readonly encryptedHeaders: McpEncryptedSecretMap
  readonly authentication: McpStreamableHttpAuthenticationSettings
}

export type McpTransportSettings =
  | McpStdioTransportSettings
  | McpStreamableHttpTransportSettings

export interface McpServerInput {
  readonly id?: string
  readonly name: string
  readonly enabled?: boolean
  readonly capabilityAliases?: readonly McpCapabilityAliasInput[]
  readonly transport: McpTransportInput
}

export interface NormalizedMcpServerInput {
  readonly id?: string
  readonly name: string
  readonly enabled: boolean
  readonly capabilityAliases: readonly McpCapabilityAlias[]
  readonly transport: McpTransportInput
}

export type McpConnectionStatus =
  | 'unvalidated'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'disabled'
  | 'revoked'

export interface McpNegotiatedCapabilities {
  readonly tools?: { readonly listChanged: boolean }
  readonly resources?: {
    readonly listChanged: boolean
    readonly subscribe: boolean
  }
  readonly prompts?: { readonly listChanged: boolean }
  readonly logging: boolean
}

export interface McpServerSettings {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly capabilityAliases: readonly McpCapabilityAlias[]
  readonly transport: McpTransportSettings
  /** Exact persisted stdio configuration explicitly trusted by the user. */
  readonly stdioTrustDigest?: string
  readonly status: McpConnectionStatus
  readonly capabilities: McpNegotiatedCapabilities
  readonly lastCheckedAt?: string
  readonly statusMessage?: string
}

export interface McpStdioTransportView {
  readonly type: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly environmentKeys: readonly string[]
  readonly hasSecrets: boolean
}

export interface McpStreamableHttpTransportView {
  readonly type: 'streamable-http'
  readonly url: string
  readonly headerKeys: readonly string[]
  readonly hasSecrets: boolean
  readonly authentication: McpStreamableHttpAuthenticationView
}

export interface McpOAuthViewMetadata {
  readonly type: 'oauth'
  readonly authorizationServerUrl?: string
  readonly clientId?: string
  readonly scopes: readonly string[]
  readonly status: McpOAuthAuthorizationStatus
  readonly hasCredentials: boolean
}

export type McpStreamableHttpAuthenticationView =
  | { readonly type: 'none' }
  | { readonly type: 'secret-headers' }
  | McpOAuthViewMetadata

export type McpTransportView =
  | McpStdioTransportView
  | McpStreamableHttpTransportView

export interface McpServerView {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly capabilityAliases: readonly McpCapabilityAlias[]
  readonly transport: McpTransportView
  readonly status: McpConnectionStatus
  readonly capabilities: McpNegotiatedCapabilities
  readonly lastCheckedAt?: string
  readonly statusMessage?: string
}

export interface McpAgentGrant {
  readonly agentPath: string
  readonly serverId: string
  readonly enabled: boolean
  readonly updatedAt?: string
}

export interface McpSettingsFile {
  readonly version: typeof MCP_SETTINGS_SCHEMA_VERSION
  readonly servers: readonly McpServerSettings[]
  readonly agentGrants: readonly McpAgentGrant[]
}

export function normalizeMcpServerInput(
  input: McpServerInput,
): NormalizedMcpServerInput {
  return {
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    name: input.name.trim(),
    enabled: input.enabled ?? MCP_NEW_SERVER_ENABLED_BY_DEFAULT,
    capabilityAliases: normalizeMcpCapabilityAliases(input.capabilityAliases ?? []),
    transport: normalizeTransportInput(input.transport),
  }
}

export function normalizeMcpAgentPath(agentPath: string): string | null {
  const normalized = agentPath.trim().replaceAll('\\', '/')
  if (normalized.includes('\0')) return null
  const segments = normalized.split('/')
  if (segments.length !== 2 || segments[0] !== 'agents') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[1] ?? '')) return null
  return `agents/${segments[1]}`
}

export function isMcpServerGrantedToAgent(params: {
  readonly grants: readonly McpAgentGrant[]
  readonly agentPath: string
  readonly serverId: string
}): boolean {
  const agentPath = normalizeMcpAgentPath(params.agentPath)
  if (!agentPath) return MCP_ABSENT_AGENT_GRANT_ENABLED
  const grant = params.grants.find(
    (grant) =>
      normalizeMcpAgentPath(grant.agentPath) === agentPath &&
      grant.serverId === params.serverId,
  )
  return grant?.enabled ?? MCP_ABSENT_AGENT_GRANT_ENABLED
}

export function redactMcpServer(settings: McpServerSettings): McpServerView {
  return {
    id: settings.id,
    name: settings.name,
    enabled: settings.enabled,
    capabilityAliases: [...settings.capabilityAliases],
    transport: redactTransport(settings.transport),
    status: settings.status,
    capabilities: settings.capabilities,
    ...(settings.lastCheckedAt
      ? { lastCheckedAt: settings.lastCheckedAt }
      : {}),
    ...(settings.statusMessage ? { statusMessage: settings.statusMessage } : {}),
  }
}

function normalizeTransportInput(transport: McpTransportInput): McpTransportInput {
  if (transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: transport.command.trim(),
      args: [...(transport.args ?? [])],
      ...(transport.cwd?.trim() ? { cwd: transport.cwd.trim() } : {}),
      ...(transport.secretEnvironment
        ? { secretEnvironment: { ...transport.secretEnvironment } }
        : {}),
    }
  }
  return {
    type: 'streamable-http',
    url: transport.url.trim(),
    ...(transport.secretHeaders
      ? { secretHeaders: { ...transport.secretHeaders } }
      : {}),
    authentication: normalizeHttpAuthenticationInput(
      transport.authentication,
      Boolean(transport.secretHeaders && Object.keys(transport.secretHeaders).length > 0),
    ),
  }
}

function redactTransport(transport: McpTransportSettings): McpTransportView {
  if (transport.type === 'stdio') {
    const environmentKeys = Object.keys(transport.encryptedEnvironment).sort()
    return {
      type: 'stdio',
      command: transport.command,
      args: [...transport.args],
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      environmentKeys,
      hasSecrets: environmentKeys.length > 0,
    }
  }
  const headerKeys = Object.keys(transport.encryptedHeaders).sort()
  return {
    type: 'streamable-http',
    url: transport.url,
    headerKeys,
    hasSecrets: headerKeys.length > 0,
    authentication: redactHttpAuthentication(transport.authentication),
  }
}

export function normalizeMcpCapabilityAliases(
  aliases: readonly McpCapabilityAliasInput[],
): readonly McpCapabilityAlias[] {
  const normalized = new Map<string, McpCapabilityAccess>()
  for (const alias of aliases) {
    const capability = normalizeMcpCapabilityName(alias.capability)
    if (!capability) continue
    const access = alias.access ?? 'any'
    normalized.set(capability, mergeCapabilityAccess(normalized.get(capability), access))
  }
  return [...normalized.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability, access]) => ({ capability, access }))
}

function mergeCapabilityAccess(
  current: McpCapabilityAccess | undefined,
  incoming: McpCapabilityAccess,
): McpCapabilityAccess {
  if (!current || current === incoming) return incoming
  return 'any'
}

function normalizeHttpAuthenticationInput(
  authentication: McpStreamableHttpAuthenticationInput | undefined,
  hasSecretHeaders: boolean,
): McpStreamableHttpAuthenticationInput {
  if (!authentication) return { type: hasSecretHeaders ? 'secret-headers' : 'none' }
  if (authentication.type !== 'oauth') return authentication
  return {
    type: 'oauth',
    ...(authentication.authorizationServerUrl?.trim()
      ? { authorizationServerUrl: authentication.authorizationServerUrl.trim() }
      : {}),
    ...(authentication.clientId?.trim() ? { clientId: authentication.clientId.trim() } : {}),
    scopes: [...new Set((authentication.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))].sort(),
    ...(authentication.secretCredentials
      ? { secretCredentials: { ...authentication.secretCredentials } }
      : {}),
  }
}

function redactHttpAuthentication(
  authentication: McpStreamableHttpAuthenticationSettings,
): McpStreamableHttpAuthenticationView {
  if (authentication.type !== 'oauth') return authentication
  return {
    type: 'oauth',
    ...(authentication.authorizationServerUrl
      ? { authorizationServerUrl: authentication.authorizationServerUrl }
      : {}),
    ...(authentication.clientId ? { clientId: authentication.clientId } : {}),
    scopes: [...authentication.scopes],
    status: authentication.status,
    hasCredentials: Object.keys(authentication.encryptedCredentials).length > 0,
  }
}
