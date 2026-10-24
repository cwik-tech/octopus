import { getApiBaseUrl } from "@/lib/utils/desktop";

const API_BASE = getApiBaseUrl();

export type AgentMcpGrantTransport = "stdio" | "streamable-http";
export type AgentMcpProviderSupportMode =
  | "native-tool-loop"
  | "host-tool-bridge";
export type AgentMcpGrantStatus =
  | "unvalidated"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "disabled"
  | "revoked";

export interface AgentMcpGrantServer {
  id: string;
  name: string;
  transport: AgentMcpGrantTransport;
  status: AgentMcpGrantStatus;
  enabled: boolean;
  granted: boolean;
  compatible: boolean;
  providerSupportMode?: AgentMcpProviderSupportMode;
  providerSupportReasonCode?: string;
  reason?: string;
}

export async function fetchAgentMcpGrants(
  agentName: string,
): Promise<AgentMcpGrantServer[]> {
  const payload = await request<{ servers: AgentMcpGrantServer[] }>(
    grantPath(agentName),
  );
  return payload.servers;
}

export function updateAgentMcpGrant(
  agentName: string,
  serverId: string,
  enabled: boolean,
): Promise<AgentMcpGrantServer> {
  return request(grantPath(agentName), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId, enabled }),
  });
}

function grantPath(agentName: string): string {
  return `/create/agents/${encodeURIComponent(agentName)}/mcp-grants`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
      };
      throw new Error(payload.error || payload.message || fallback);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(fallback, { cause: error });
      }
      throw error;
    }
  }
  return (await response.json()) as T;
}
