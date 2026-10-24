import { getApiBaseUrl } from "@/lib/utils/desktop";
import type { SessionFile } from "@/lib/models/session-model";

const API_BASE = getApiBaseUrl();

export type McpResourceDisposition =
  | "text"
  | "binary"
  | "blocked"
  | "unknown";

export interface McpResourceDescriptor {
  id: string;
  serverId: string;
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string | undefined;
  disposition: McpResourceDisposition;
}

export interface McpResourceListOptions {
  serverId?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface McpResourceListResult {
  resources: McpResourceDescriptor[];
  nextCursor?: string;
}

export interface McpResourceServerOption {
  id: string;
  name: string;
}

export interface McpResourceImportManifestContent {
  id: string;
  sourceUri: string;
  mimeType: string;
  kind: "text" | "binary";
  byteLength: number;
  sha256: string;
  storedPath: string;
  materializedInputFilename: string;
}

export interface McpResourceImportManifest {
  version: 1;
  snapshotId: string;
  sessionId: string;
  capturedAt: string;
  server: {
    id: string;
    name: string;
  };
  resource: {
    id: string;
    uri: string;
    name: string;
  };
  totalBytes: number;
  contents: McpResourceImportManifestContent[];
}

export interface McpResourceImportInput {
  serverId: string;
  uri: string;
  requestedInputBaseName?: string;
}

export interface McpResourceImportResult {
  files: SessionFile[];
  import: McpResourceImportManifest;
}

export interface McpResourceImportsResult {
  imports: McpResourceImportManifest[];
}

export interface McpResourcesClient {
  listServers(signal?: AbortSignal): Promise<McpResourceServerOption[]>;
  listResources(
    sessionId: string,
    options?: McpResourceListOptions,
  ): Promise<McpResourceListResult>;
  listImports(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<McpResourceImportsResult>;
  importResource(
    sessionId: string,
    input: McpResourceImportInput,
    signal?: AbortSignal,
  ): Promise<McpResourceImportResult>;
}

export class McpResourcesClientError extends Error {
  readonly status: number;
  readonly code?: string | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    options?: {
      code?: string;
      retryable?: boolean | undefined;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "McpResourcesClientError";
    this.status = status;
    this.code = options?.code;
    this.retryable = options?.retryable ?? false;
  }
}

export function listMcpResources(
  sessionId: string,
  options: McpResourceListOptions = {},
): Promise<McpResourceListResult> {
  const query = new URLSearchParams();
  if (options.serverId) query.set("serverId", options.serverId);
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return request(
    `${resourcePath(sessionId)}${suffix}`,
    options.signal ? { signal: options.signal } : undefined,
  );
}

export async function listMcpResourceServers(
  signal?: AbortSignal,
): Promise<McpResourceServerOption[]> {
  const payload = await request<
    McpResourceServerView[] | { servers: McpResourceServerView[] }
  >("/settings/mcps", signal ? { signal } : undefined);
  const servers = Array.isArray(payload) ? payload : payload.servers;
  return servers
    .filter((server) => (
      server.enabled
      && server.status === "connected"
      && Boolean(server.capabilities.resources)
    ))
    .map((server) => ({ id: server.id, name: server.name }));
}

export function listMcpResourceImports(
  sessionId: string,
  signal?: AbortSignal,
): Promise<McpResourceImportsResult> {
  return request(
    `${resourcePath(sessionId)}/imports`,
    signal ? { signal } : undefined,
  );
}

export function importMcpResource(
  sessionId: string,
  input: McpResourceImportInput,
  signal?: AbortSignal,
): Promise<McpResourceImportResult> {
  return request(`${resourcePath(sessionId)}/imports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

export const mcpResourcesClient: McpResourcesClient = {
  listServers: listMcpResourceServers,
  listResources: listMcpResources,
  listImports: listMcpResourceImports,
  importResource: importMcpResource,
};

interface McpResourceServerView {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  capabilities: {
    resources?: {
      listChanged: boolean;
      subscribe: boolean;
    };
  };
}

function resourcePath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/mcp-resources`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
        code?: string;
        retryable?: boolean;
      };
      throw new McpResourcesClientError(
        payload.error || payload.message || fallback,
        response.status,
        {
          ...(payload.code ? { code: payload.code } : {}),
          retryable: payload.retryable,
        },
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new McpResourcesClientError(fallback, response.status, {
          cause: error,
        });
      }
      throw error;
    }
  }
  return (await response.json()) as T;
}
