import {
  newMcpServerDraft,
  type McpSecretRow,
  type McpServerDraft,
} from "@/components/settings/mcp-connection-draft";

export type McpConnectionJsonSource = "direct" | "mcpServers" | "servers";

export type McpConnectionJsonParseResult =
  | {
      ok: true;
      draft: McpServerDraft;
      importedName: string;
      source: McpConnectionJsonSource;
      secretCount: number;
    }
  | { ok: false; error: string };

type JsonObject = Record<string, unknown>;

class McpConnectionJsonParseError extends Error {}

/**
 * Parses the common MCP snippets published by vendors without interpreting a
 * command as shell text. Commands and arguments always remain separate values.
 */
export function parseMcpConnectionJson(value: string): McpConnectionJsonParseResult {
  try {
    const parsed = parseJson(value);
    const { server, source, wrapperName } = unwrapServer(parsed);
    const importedName = readImportedName(server, wrapperName);
    const transport = readTransport(server);
    const draft = transport.kind === "stdio"
      ? stdioDraft(importedName, transport.value)
      : httpDraft(importedName, transport.value);

    return {
      ok: true,
      draft,
      importedName,
      source,
      secretCount: draft.secrets.length,
    };
  } catch (error) {
    if (error instanceof McpConnectionJsonParseError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "This MCP JSON could not be imported." };
  }
}

function parseJson(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    fail("Enter valid JSON.");
  }
  if (Array.isArray(parsed)) {
    fail("MCP JSON must describe one server, not an array.");
  }
  return requireObject(parsed, "MCP JSON must be an object.");
}

function unwrapServer(root: JsonObject): {
  server: JsonObject;
  source: McpConnectionJsonSource;
  wrapperName?: string;
} {
  const hasMcpServers = hasOwn(root, "mcpServers");
  const hasServers = hasOwn(root, "servers");
  if (hasMcpServers && hasServers) {
    fail("MCP JSON must use either mcpServers or servers, not both.");
  }
  if (!hasMcpServers && !hasServers) {
    return { server: root, source: "direct" };
  }

  const wrapperKey = hasMcpServers ? "mcpServers" : "servers";
  const wrapper = requireObject(
    root[wrapperKey],
    `${wrapperKey} must be an object containing one server.`,
  );
  const entries = Object.entries(wrapper);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) {
    fail(`${wrapperKey} must contain exactly one server.`);
  }
  const [wrapperName, serverValue] = entry;
  if (!wrapperName.trim()) {
    fail(`${wrapperKey} must use a non-empty server name.`);
  }
  const server = requireObject(
    serverValue,
    `The ${wrapperName} server configuration must be an object.`,
  );
  return {
    server,
    source: wrapperKey,
    wrapperName: wrapperName.trim(),
  };
}

function readImportedName(server: JsonObject, wrapperName?: string): string {
  const configuredName = readOptionalString(server, "name", "Server name");
  return configuredName?.trim() || wrapperName || "Imported MCP";
}

function readTransport(server: JsonObject): {
  kind: "stdio" | "streamable-http";
  value: JsonObject;
} {
  const rawTransport = server.transport;
  let value = server;
  let declaredType: string | undefined;

  if (rawTransport !== undefined) {
    if (typeof rawTransport === "string") {
      declaredType = rawTransport;
    } else {
      value = requireObject(rawTransport, "transport must be an object.");
    }
  }

  const nestedType = readOptionalString(value, "type", "Transport type");
  if (declaredType && nestedType && normalizeType(declaredType) !== normalizeType(nestedType)) {
    fail("MCP JSON declares conflicting transport types.");
  }
  declaredType ??= nestedType;
  rejectUnsupportedAuthentication(value);

  if (declaredType) {
    const normalized = normalizeType(declaredType);
    if (normalized === "sse") {
      fail("SSE transport is not supported. Use stdio or Streamable HTTP.");
    }
    if (normalized === "stdio") return { kind: "stdio", value };
    if (normalized === "streamable-http" || normalized === "http") {
      return { kind: "streamable-http", value };
    }
    fail(`Transport "${declaredType}" is not supported. Use stdio or Streamable HTTP.`);
  }

  const hasCommand = hasOwn(value, "command");
  const hasUrl = hasOwn(value, "url");
  if (hasCommand && hasUrl) {
    fail("MCP JSON is ambiguous because it contains both command and url.");
  }
  if (hasCommand) return { kind: "stdio", value };
  if (hasUrl) return { kind: "streamable-http", value };
  fail("MCP JSON needs either a stdio command or a Streamable HTTP url.");
}

function stdioDraft(name: string, transport: JsonObject): McpServerDraft {
  if (
    hasOwn(transport, "url")
    || hasOwn(transport, "headers")
    || hasOwn(transport, "secretHeaders")
    || hasOwn(transport, "authentication")
  ) {
    fail("A stdio MCP cannot define Streamable HTTP fields.");
  }
  const command = readRequiredString(transport, "command", "stdio command");
  if (/\s/.test(command) && !looksLikeAbsolutePath(command)) {
    fail("stdio command must contain only the executable. Put each argument in args.");
  }
  const args = readStringArray(transport, "args", "stdio args");
  const cwd = readOptionalString(transport, "cwd", "Working directory") ?? "";
  const environment = readOneSecretMap(
    transport,
    "env",
    "secretEnvironment",
    "Environment variables",
  );

  return {
    ...newMcpServerDraft(),
    name,
    transportType: "stdio",
    command,
    argsText: args.join("\n"),
    cwd,
    secrets: secretRows(environment),
    originalSecretKeys: [],
    stdioTrustAcknowledged: false,
  };
}

function httpDraft(name: string, transport: JsonObject): McpServerDraft {
  if (
    hasOwn(transport, "command")
    || hasOwn(transport, "args")
    || hasOwn(transport, "env")
    || hasOwn(transport, "secretEnvironment")
    || hasOwn(transport, "cwd")
  ) {
    fail("A Streamable HTTP MCP cannot define stdio command fields.");
  }
  const url = readRequiredString(transport, "url", "Streamable HTTP url");
  validateHttpUrl(url);
  const headers = readOneSecretMap(
    transport,
    "headers",
    "secretHeaders",
    "HTTP headers",
  );
  const authentication = readAuthenticationType(transport);
  if (authentication === "none" && Object.keys(headers).length > 0) {
    fail("HTTP headers require Secret headers authentication, not None.");
  }

  return {
    ...newMcpServerDraft(),
    name,
    transportType: "streamable-http",
    url,
    authentication: authentication === "secret-headers" || Object.keys(headers).length > 0
      ? "secret-headers"
      : "none",
    secrets: secretRows(headers),
    originalSecretKeys: [],
  };
}

function rejectUnsupportedAuthentication(transport: JsonObject): void {
  const authentication = readAuthenticationType(transport);
  if (authentication === "oauth") {
    fail("OAuth MCP connections are not supported yet. Use headers instead.");
  }
  if (
    hasOwn(transport, "oauth")
    || hasOwn(transport, "authorizationServerUrl")
    || hasOwn(transport, "clientId")
  ) {
    fail("OAuth MCP connections are not supported yet. Use headers instead.");
  }
  if (authentication && authentication !== "none" && authentication !== "secret-headers") {
    fail(`Authentication "${authentication}" is not supported. Use headers instead.`);
  }
}

function readAuthenticationType(transport: JsonObject): string | undefined {
  const authentication = transport.authentication;
  if (authentication === undefined) return undefined;
  if (typeof authentication === "string") return authentication.trim().toLowerCase();
  const record = requireObject(authentication, "authentication must be a string or object.");
  return readRequiredString(record, "type", "Authentication type").toLowerCase();
}

function readStringArray(record: JsonObject, key: string, label: string): string[] {
  const value = record[key];
  if (value === undefined) return [];
  const strings = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  if (!Array.isArray(value) || strings.length !== value.length) {
    fail(`${label} must be an array of strings.`);
  }
  return strings;
}

function readOneSecretMap(
  record: JsonObject,
  primaryKey: string,
  alternateKey: string,
  label: string,
): Record<string, string> {
  if (hasOwn(record, primaryKey) && hasOwn(record, alternateKey)) {
    fail(`${label} must use either ${primaryKey} or ${alternateKey}, not both.`);
  }
  const key = hasOwn(record, primaryKey) ? primaryKey : alternateKey;
  const value = record[key];
  if (value === undefined) return {};
  const secretMap = requireObject(value, `${label} must be an object of string values.`);
  const entries = Object.entries(secretMap);
  if (entries.some(([secretKey]) => !secretKey.trim())) {
    fail(`${label} cannot contain an empty key.`);
  }
  if (entries.some(([, secretValue]) => typeof secretValue !== "string")) {
    fail(`${label} values must all be strings.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function secretRows(secrets: Record<string, string>): McpSecretRow[] {
  return Object.entries(secrets).map(([key, value], index) => ({
    id: `json-import-${index + 1}`,
    key,
    value,
  }));
}

function readRequiredString(record: JsonObject, key: string, label: string): string {
  const value = readOptionalString(record, key, label);
  if (!value?.trim()) fail(`${label} must be a non-empty string.`);
  return value;
}

function readOptionalString(
  record: JsonObject,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${label} must be a string.`);
  return value;
}

function validateHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("Streamable HTTP url must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("Streamable HTTP url must use http or https.");
  }
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function looksLikeAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function requireObject(value: unknown, message: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message);
  return value as JsonObject;
}

function hasOwn(record: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function fail(message: string): never {
  throw new McpConnectionJsonParseError(message);
}
