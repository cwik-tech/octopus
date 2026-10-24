import {
  type McpCapabilityAlias,
  type McpHttpAuthenticationInput,
  type McpSecretInputMap,
  type McpServerInput,
  type McpServerView,
  type McpTransportKind,
} from "@/lib/clients/mcp-settings-client";

export type McpAuthenticationChoice = "none" | "secret-headers" | "oauth";

export interface McpSecretRow {
  id: string;
  key: string;
  value: string;
}

export interface McpCapabilityAliasDraft extends McpCapabilityAlias {
  id: string;
}

export interface McpServerDraft {
  id?: string;
  name: string;
  transportType: McpTransportKind;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  authentication: McpAuthenticationChoice;
  authorizationServerUrl: string;
  clientId: string;
  scopesText: string;
  secrets: McpSecretRow[];
  originalSecretKeys: string[];
  capabilityAliases: McpCapabilityAliasDraft[];
  stdioTrustAcknowledged: boolean;
}

let nextStoredSecretRowId = 1;
let nextCapabilityAliasRowId = 1;

export function newMcpServerDraft(): McpServerDraft {
  return {
    name: "",
    transportType: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    url: "",
    authentication: "none",
    authorizationServerUrl: "",
    clientId: "",
    scopesText: "",
    secrets: [],
    originalSecretKeys: [],
    capabilityAliases: [],
    stdioTrustAcknowledged: false,
  };
}

export function mcpServerDraftFromServer(server: McpServerView): McpServerDraft {
  if (server.transport.type === "stdio") {
    return {
      ...newMcpServerDraft(),
      id: server.id,
      name: server.name,
      transportType: "stdio",
      command: server.transport.command,
      argsText: server.transport.args.join("\n"),
      cwd: server.transport.cwd ?? "",
      secrets: secretRows(server.transport.environmentKeys),
      originalSecretKeys: [...server.transport.environmentKeys],
      capabilityAliases: capabilityAliasDrafts(server.capabilityAliases),
    };
  }
  const authentication = server.transport.authentication;
  return {
    ...newMcpServerDraft(),
    id: server.id,
    name: server.name,
    transportType: "streamable-http",
    url: server.transport.url,
    authentication: authentication.type,
    authorizationServerUrl:
      authentication.type === "oauth" ? authentication.authorizationServerUrl ?? "" : "",
    clientId: authentication.type === "oauth" ? authentication.clientId ?? "" : "",
    scopesText: authentication.type === "oauth" ? authentication.scopes.join("\n") : "",
    secrets: secretRows(server.transport.headerKeys),
    originalSecretKeys: [...server.transport.headerKeys],
    capabilityAliases: capabilityAliasDrafts(server.capabilityAliases),
  };
}

export function validateMcpServerDraft(draft: McpServerDraft): string | null {
  if (!draft.name.trim()) return "Connection name is required.";
  if (draft.transportType === "stdio" && !draft.command.trim()) {
    return "stdio command is required.";
  }
  if (draft.transportType === "stdio" && !draft.stdioTrustAcknowledged) {
    return "Acknowledge that validation will run this command locally.";
  }
  if (draft.transportType === "streamable-http") {
    let parsed: URL;
    try {
      parsed = new URL(draft.url);
    } catch {
      return "A valid Streamable HTTP URL is required.";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Streamable HTTP URL must use http or https.";
    }
    if (parsed.search) {
      return "Streamable HTTP URL cannot include query parameters. Use Secret headers instead.";
    }
  }
  if (draft.authentication === "oauth") {
    return "OAuth MCP connections are not supported yet. Choose None or Secret headers.";
  }
  if (draft.authentication === "secret-headers" || draft.transportType === "stdio") {
    const seen = new Set<string>();
    for (const row of draft.secrets) {
      const key = row.key.trim();
      const comparisonKey = draft.transportType === "streamable-http"
        ? key.toLowerCase()
        : key;
      if (!key) return "Every secret row needs a key.";
      if (seen.has(comparisonKey)) return "Secret keys must be unique.";
      seen.add(comparisonKey);
      if (!row.value && !draft.originalSecretKeys.includes(key)) {
        return `Enter a value for ${key}.`;
      }
    }
  }
  if (draft.capabilityAliases.length > 64) {
    return "A connection can declare at most 64 workflow capabilities.";
  }
  const seenCapabilities = new Set<string>();
  for (const alias of draft.capabilityAliases) {
    const capability = normalizeCapability(alias.capability);
    if (!capability) {
      return "Every workflow capability needs a lowercase semantic name such as web.search.";
    }
    if (seenCapabilities.has(capability)) {
      return `Workflow capability ${capability} is listed more than once.`;
    }
    seenCapabilities.add(capability);
  }
  return null;
}

export function mcpServerInputFromDraft(draft: McpServerDraft): McpServerInput {
  if (draft.transportType === "stdio") {
    const secretEnvironment = secretPatch(
      draft.secrets,
      draft.originalSecretKeys,
    );
    return {
      name: draft.name.trim(),
      enabled: true,
      capabilityAliases: capabilityAliasInputs(draft.capabilityAliases),
      transport: {
        type: "stdio",
        command: draft.command.trim(),
        args: argumentLines(draft.argsText),
        ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
        ...(Object.keys(secretEnvironment).length > 0 ? { secretEnvironment } : {}),
      },
    };
  }

  const authentication: McpHttpAuthenticationInput =
    draft.authentication === "oauth"
      ? {
          type: "oauth",
          ...(draft.authorizationServerUrl.trim()
            ? { authorizationServerUrl: draft.authorizationServerUrl.trim() }
            : {}),
          ...(draft.clientId.trim() ? { clientId: draft.clientId.trim() } : {}),
          scopes: lines(draft.scopesText),
        }
      : { type: draft.authentication };
  const secretHeaders = draft.authentication === "secret-headers"
    ? secretPatch(draft.secrets, draft.originalSecretKeys)
    : secretPatch([], draft.originalSecretKeys);
  return {
    name: draft.name.trim(),
    enabled: true,
    capabilityAliases: capabilityAliasInputs(draft.capabilityAliases),
    transport: {
      type: "streamable-http",
      url: draft.url.trim(),
      authentication,
      ...(Object.keys(secretHeaders).length > 0 ? { secretHeaders } : {}),
    },
  };
}

function secretRows(keys: string[]): McpSecretRow[] {
  return keys.map((key) => ({
    id: `stored-${nextStoredSecretRowId++}`,
    key,
    value: "",
  }));
}

export function newCapabilityAliasDraft(): McpCapabilityAliasDraft {
  return {
    id: `capability-${nextCapabilityAliasRowId++}`,
    capability: "",
    access: "read",
  };
}

function capabilityAliasDrafts(
  aliases: readonly McpCapabilityAlias[],
): McpCapabilityAliasDraft[] {
  return aliases.map((alias) => ({
    id: `capability-${nextCapabilityAliasRowId++}`,
    ...alias,
  }));
}

function capabilityAliasInputs(
  aliases: readonly McpCapabilityAliasDraft[],
): McpCapabilityAlias[] {
  return aliases.map(({ capability, access }) => ({
    capability: normalizeCapability(capability) ?? capability.trim(),
    access,
  }));
}

function normalizeCapability(value: string): string | null {
  const capability = value.trim().toLowerCase();
  if (!capability || capability.length > 160) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(capability) ? capability : null;
}

function secretPatch(rows: McpSecretRow[], originalKeys: string[]): McpSecretInputMap {
  const patch: McpSecretInputMap = Object.fromEntries(
    originalKeys.map((key) => [key, { operation: "remove" as const }]),
  );
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    patch[key] = row.value
      ? { operation: "replace", value: row.value }
      : { operation: "preserve" };
  }
  return patch;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function argumentLines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}
