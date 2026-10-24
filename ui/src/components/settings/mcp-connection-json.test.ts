import { describe, expect, it } from "vitest";

import { parseMcpConnectionJson } from "@/components/settings/mcp-connection-json";

describe("parseMcpConnectionJson", () => {
  it("imports a one-server mcpServers stdio snippet without trusting the command", () => {
    const result = parseMcpConnectionJson(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/shared files"],
          cwd: "/tmp",
          env: {
            API_TOKEN: "secret-token",
            REGION: "us-east-1",
          },
        },
      },
    }));

    if (!result.ok) throw new Error(result.error);
    const { draft, ...imported } = result;
    expect(imported).toEqual({
      ok: true,
      importedName: "filesystem",
      source: "mcpServers",
      secretCount: 2,
    });
    expect(draft).toMatchObject({
      name: "filesystem",
      transportType: "stdio",
      command: "npx",
      argsText: "-y\n@modelcontextprotocol/server-filesystem\n/tmp/shared files",
      cwd: "/tmp",
      stdioTrustAcknowledged: false,
    });
    expect(draft.originalSecretKeys).toEqual([]);
    expect(draft.secrets).toEqual([
      { id: "json-import-1", key: "API_TOKEN", value: "secret-token" },
      { id: "json-import-2", key: "REGION", value: "us-east-1" },
    ]);
  });

  it("imports arguments exactly without shell splitting", () => {
    const result = parseMcpConnectionJson(JSON.stringify({
      name: "Local helper",
      type: "stdio",
      command: "npx",
      args: ["--label", "two words"],
    }));

    expect(result).toMatchObject({
      ok: true,
      importedName: "Local helper",
      source: "direct",
      draft: {
        name: "Local helper",
        transportType: "stdio",
        command: "npx",
        argsText: "--label\ntwo words",
        stdioTrustAcknowledged: false,
      },
    });
  });

  it("imports a servers-wrapped Streamable HTTP snippet and turns headers into secrets", () => {
    const result = parseMcpConnectionJson(JSON.stringify({
      servers: {
        "public-data": {
          type: "http",
          url: "https://data.example.test/mcp",
          headers: {
            Authorization: "Bearer example-token",
          },
        },
      },
      inputs: [],
    }));

    expect(result).toMatchObject({
      ok: true,
      importedName: "public-data",
      source: "servers",
      secretCount: 1,
      draft: {
        name: "public-data",
        transportType: "streamable-http",
        url: "https://data.example.test/mcp",
        authentication: "secret-headers",
        originalSecretKeys: [],
        secrets: [
          { id: "json-import-1", key: "Authorization", value: "Bearer example-token" },
        ],
      },
    });
  });

  it("imports the current application nested transport shape", () => {
    const result = parseMcpConnectionJson(JSON.stringify({
      name: "Nested remote",
      enabled: true,
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
        authentication: { type: "secret-headers" },
        secretHeaders: { "X-API-Key": "key-value" },
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      importedName: "Nested remote",
      source: "direct",
      secretCount: 1,
      draft: {
        transportType: "streamable-http",
        authentication: "secret-headers",
        url: "https://example.test/mcp",
        secrets: [{ key: "X-API-Key", value: "key-value" }],
      },
    });
  });

  it("imports a nested stdio transport and its secretEnvironment values", () => {
    const result = parseMcpConnectionJson(JSON.stringify({
      name: "Nested local",
      transport: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        secretEnvironment: { DATABASE_URL: "postgres://local/test" },
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      importedName: "Nested local",
      secretCount: 1,
      draft: {
        transportType: "stdio",
        command: "node",
        argsText: "server.mjs",
        stdioTrustAcknowledged: false,
        secrets: [{ key: "DATABASE_URL", value: "postgres://local/test" }],
      },
    });
  });

  it("uses a safe editable name when a direct object has no name", () => {
    const result = parseMcpConnectionJson(JSON.stringify({
      command: "node",
      args: ["server.mjs"],
    }));

    expect(result).toMatchObject({
      ok: true,
      importedName: "Imported MCP",
      draft: { name: "Imported MCP" },
    });
  });

  it.each([
    ["malformed JSON", "{ bad", "Enter valid JSON."],
    ["an array root", "[]", "MCP JSON must describe one server, not an array."],
    ["a null root", "null", "MCP JSON must be an object."],
    [
      "both wrapper formats",
      JSON.stringify({ mcpServers: {}, servers: {} }),
      "MCP JSON must use either mcpServers or servers, not both.",
    ],
    [
      "an empty wrapper",
      JSON.stringify({ mcpServers: {} }),
      "mcpServers must contain exactly one server.",
    ],
    [
      "a multi-server wrapper",
      JSON.stringify({ mcpServers: { one: {}, two: {} } }),
      "mcpServers must contain exactly one server.",
    ],
    [
      "a non-object wrapped server",
      JSON.stringify({ servers: { demo: "npx demo" } }),
      "The demo server configuration must be an object.",
    ],
  ])("rejects %s", (_label, value, error) => {
    expect(parseMcpConnectionJson(value)).toEqual({ ok: false, error });
  });

  it.each([
    [
      "a shell-like command string",
      { command: "npx -y vendor-server" },
      "stdio command must contain only the executable. Put each argument in args.",
    ],
    [
      "string args",
      { command: "npx", args: "-y vendor-server" },
      "stdio args must be an array of strings.",
    ],
    [
      "non-string args",
      { command: "npx", args: ["-y", 42] },
      "stdio args must be an array of strings.",
    ],
    [
      "non-string environment values",
      { command: "npx", env: { PORT: 3000 } },
      "Environment variables values must all be strings.",
    ],
    [
      "non-string HTTP header values",
      { url: "https://example.test/mcp", headers: { Authorization: null } },
      "HTTP headers values must all be strings.",
    ],
    [
      "SSE transport",
      { type: "sse", url: "https://example.test/sse" },
      "SSE transport is not supported. Use stdio or Streamable HTTP.",
    ],
    [
      "OAuth authentication",
      {
        type: "streamable-http",
        url: "https://example.test/mcp",
        authentication: { type: "oauth" },
      },
      "OAuth MCP connections are not supported yet. Use headers instead.",
    ],
    [
      "an unsupported transport",
      { type: "websocket", url: "wss://example.test/mcp" },
      "Transport \"websocket\" is not supported. Use stdio or Streamable HTTP.",
    ],
    [
      "ambiguous transport fields",
      { command: "node", url: "https://example.test/mcp" },
      "MCP JSON is ambiguous because it contains both command and url.",
    ],
  ])("rejects %s", (_label, value, error) => {
    expect(parseMcpConnectionJson(JSON.stringify(value))).toEqual({ ok: false, error });
  });
});
