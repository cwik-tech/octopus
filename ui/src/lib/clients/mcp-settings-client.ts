import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type McpTransportKind = "stdio" | "streamable-http";
export type McpConnectionStatus =
  | "unvalidated"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "disabled"
  | "revoked";
export type McpOAuthStatus =
  | "not-authorized"
  | "authorization-required"
  | "authorized"
  | "expired"
  | "error";

export type McpSecretValueInput =
  | { operation: "preserve" }
  | { operation: "replace"; value: string }
  | { operation: "remove" };

export type McpSecretInputMap = Record<string, McpSecretValueInput>;

export interface McpCapabilityAlias {
  capability: string;
  access: "read" | "write" | "any";
}

export interface McpNegotiatedCapabilities {
  tools?: { listChanged: boolean };
  resources?: { listChanged: boolean; subscribe: boolean };
  prompts?: { listChanged: boolean };
  logging: boolean;
}

export interface McpStdioTransportView {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  environmentKeys: string[];
  hasSecrets: boolean;
}

export type McpHttpAuthenticationView =
  | { type: "none" }
  | { type: "secret-headers" }
  | {
      type: "oauth";
      authorizationServerUrl?: string;
      clientId?: string;
      scopes: string[];
      status: McpOAuthStatus;
      hasCredentials: boolean;
    };

export interface McpHttpTransportView {
  type: "streamable-http";
  url: string;
  headerKeys: string[];
  hasSecrets: boolean;
  authentication: McpHttpAuthenticationView;
}

export type McpTransportView = McpStdioTransportView | McpHttpTransportView;

export interface McpServerView {
  id: string;
  name: string;
  enabled: boolean;
  capabilityAliases: McpCapabilityAlias[];
  transport: McpTransportView;
  status: McpConnectionStatus;
  capabilities: McpNegotiatedCapabilities;
  lastCheckedAt?: string;
  statusMessage?: string;
}

export interface McpStdioTransportInput {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  secretEnvironment?: McpSecretInputMap;
}

export type McpHttpAuthenticationInput =
  | { type: "none" }
  | { type: "secret-headers" }
  | {
      type: "oauth";
      authorizationServerUrl?: string;
      clientId?: string;
      scopes: string[];
    };

export interface McpHttpTransportInput {
  type: "streamable-http";
  url: string;
  secretHeaders?: McpSecretInputMap;
  authentication: McpHttpAuthenticationInput;
}

export interface McpServerInput {
  name: string;
  enabled?: boolean;
  capabilityAliases?: McpCapabilityAlias[];
  transport: McpStdioTransportInput | McpHttpTransportInput;
}

type McpServerEnvelope = McpServerView | { server: McpServerView };

export class McpSettingsClientError extends Error {
  readonly status: number;
  readonly server?: McpServerView | undefined;

  constructor(
    message: string,
    status: number,
    server?: McpServerView,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpSettingsClientError";
    this.status = status;
    this.server = server;
  }
}

export async function fetchMcpServers(): Promise<McpServerView[]> {
  const payload = await request<McpServerView[] | { servers: McpServerView[] }>(
    "/settings/mcps",
  );
  return Array.isArray(payload) ? payload : payload.servers;
}

export async function createMcpServer(
  input: McpServerInput,
): Promise<McpServerView> {
  return unwrapServer(await request<McpServerEnvelope>("/settings/mcps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function updateMcpServer(
  serverId: string,
  input: McpServerInput,
): Promise<McpServerView> {
  return unwrapServer(await request<McpServerEnvelope>(
    `/settings/mcps/${encodeURIComponent(serverId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ));
}

export async function setMcpServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<McpServerView> {
  return unwrapServer(await request<McpServerEnvelope>(
    `/settings/mcps/${encodeURIComponent(serverId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  ));
}

export async function validateMcpServer(
  serverId: string,
  options: { stdioTrustAcknowledged?: boolean } = {},
): Promise<McpServerView> {
  return unwrapServer(await request<McpServerEnvelope>(
    `/settings/mcps/${encodeURIComponent(serverId)}/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    },
  ));
}

export async function reconnectMcpServer(
  serverId: string,
): Promise<McpServerView> {
  return unwrapServer(await request<McpServerEnvelope>(
    `/settings/mcps/${encodeURIComponent(serverId)}/reconnect`,
    { method: "POST" },
  ));
}

export function deleteMcpServer(serverId: string): Promise<void> {
  return request(`/settings/mcps/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
  });
}

function unwrapServer(payload: McpServerEnvelope): McpServerView {
  return "server" in payload ? payload.server : payload;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        server?: McpServerView;
      };
      throw new McpSettingsClientError(
        payload.error || payload.message || fallback,
        response.status,
        payload.server,
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new McpSettingsClientError(fallback, response.status, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
