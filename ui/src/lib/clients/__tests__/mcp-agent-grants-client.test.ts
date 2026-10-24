import { afterEach, expect, it, vi } from "vitest";

import {
  fetchAgentMcpGrants,
  updateAgentMcpGrant,
  type AgentMcpGrantServer,
} from "@/lib/clients/mcp-agent-grants-client";

const server: AgentMcpGrantServer = {
  id: "filesystem",
  name: "Filesystem",
  transport: "stdio",
  status: "connected",
  enabled: true,
  granted: false,
  compatible: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("lists and updates grants through the agent-scoped route", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      path: url.pathname,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "GET") return jsonResponse({ servers: [server] });
    return jsonResponse({ ...server, granted: true });
  }));

  await expect(fetchAgentMcpGrants("research/agent")).resolves.toEqual([server]);
  await expect(updateAgentMcpGrant("research/agent", server.id, true)).resolves.toEqual({
    ...server,
    granted: true,
  });

  expect(calls).toEqual([
    {
      path: "/api/create/agents/research%2Fagent/mcp-grants",
      method: "GET",
    },
    {
      path: "/api/create/agents/research%2Fagent/mcp-grants",
      method: "PATCH",
      body: { serverId: "filesystem", enabled: true },
    },
  ]);
});

it("surfaces a backend grant rejection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(
    { error: "Agent provider does not support MCP tools." },
    409,
  )));

  await expect(updateAgentMcpGrant("agent", "filesystem", true)).rejects.toThrow(
    "Agent provider does not support MCP tools.",
  );
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
