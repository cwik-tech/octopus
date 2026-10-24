import { afterEach, expect, it, vi } from "vitest";

import {
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  McpSettingsClientError,
  reconnectMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
  validateMcpServer,
  type McpServerInput,
  type McpServerView,
} from "@/lib/clients/mcp-settings-client";

const server: McpServerView = {
  id: "stdio-server",
  name: "Local tools",
  enabled: true,
  capabilityAliases: [],
  transport: {
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
    environmentKeys: [],
    hasSecrets: false,
  },
  status: "unvalidated",
  capabilities: { logging: false },
};

const input: McpServerInput = {
  name: "Local tools",
  transport: {
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses conventional list, create, update, toggle, validate, reconnect, and delete routes", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET") {
      return jsonResponse({ servers: [server] });
    }
    return jsonResponse(method === "PUT" ? server : { server });
  }));

  expect(await fetchMcpServers()).toEqual([server]);
  expect(await createMcpServer(input)).toEqual(server);
  expect(await updateMcpServer("server/id", input)).toEqual(server);
  expect(await setMcpServerEnabled("server/id", false)).toEqual(server);
  expect(await validateMcpServer("server/id", {
    stdioTrustAcknowledged: true,
  })).toEqual(server);
  expect(await reconnectMcpServer("server/id")).toEqual(server);
  await expect(deleteMcpServer("server/id")).resolves.toBeUndefined();

  expect(calls.map(({ url, method }) => ({
    path: new URL(url, "http://localhost").pathname,
    method,
  }))).toEqual([
    { path: "/api/settings/mcps", method: "GET" },
    { path: "/api/settings/mcps", method: "POST" },
    { path: "/api/settings/mcps/server%2Fid", method: "PUT" },
    { path: "/api/settings/mcps/server%2Fid", method: "PATCH" },
    { path: "/api/settings/mcps/server%2Fid/validate", method: "POST" },
    { path: "/api/settings/mcps/server%2Fid/reconnect", method: "POST" },
    { path: "/api/settings/mcps/server%2Fid", method: "DELETE" },
  ]);
  expect(calls[2]?.body).toEqual(input);
  expect(calls[3]?.body).toEqual({ enabled: false });
  expect(calls[4]?.body).toEqual({ stdioTrustAcknowledged: true });
});

it("surfaces the backend error without leaking response parsing details", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
    { error: "MCP server is disabled." },
    409,
  )));

  await expect(validateMcpServer("disabled")).rejects.toThrow(
    "MCP server is disabled.",
  );
});

it("preserves the redacted server returned with a failed validation", async () => {
  const authorizationRequired: McpServerView = {
    ...server,
    status: "error",
    statusMessage: "Authorization required.",
  };
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
    {
      error: "Authorization required.",
      server: authorizationRequired,
    },
    409,
  )));

  await expect(validateMcpServer("oauth")).rejects.toMatchObject({
    name: "McpSettingsClientError",
    message: "Authorization required.",
    status: 409,
    server: authorizationRequired,
  } satisfies Partial<McpSettingsClientError>);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
