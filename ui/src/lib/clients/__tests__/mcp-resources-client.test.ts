import { afterEach, expect, it, vi } from "vitest";

import {
  McpResourcesClientError,
  importMcpResource,
  listMcpResourceImports,
  listMcpResources,
  listMcpResourceServers,
  type McpResourceImportManifest,
} from "@/lib/clients/mcp-resources-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the session resource routes with encoded filters and import bodies", async () => {
  const manifest = importManifest();
  const calls: Array<{
    method: string;
    path: string;
    query: string;
    body?: unknown;
  }> = [];
  vi.stubGlobal("fetch", vi.fn(async (
    request: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(request), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method === "POST") {
      return jsonResponse({
        files: [{
          name: "report.txt",
          size: 6,
          uploadedAt: manifest.capturedAt,
          parseStatus: "pending",
        }],
        import: manifest,
      }, 201);
    }
    if (url.pathname.endsWith("/settings/mcps")) {
      return jsonResponse({
        servers: [
          settingsServer(),
          settingsServer({ id: "offline", status: "disconnected" }),
          settingsServer({ id: "tools-only", capabilities: {} }),
          settingsServer({ id: "disabled", enabled: false }),
        ],
      });
    }
    if (url.pathname.endsWith("/imports")) {
      return jsonResponse({ imports: [manifest] });
    }
    return jsonResponse({
      resources: [{
        id: "resource-1",
        serverId: "server/one",
        serverName: "Documents",
        uri: "docs://reports/one",
        name: "Report",
        disposition: "text",
      }],
      nextCursor: "next/page",
    });
  }));

  await expect(listMcpResourceServers()).resolves.toEqual([
    { id: "documents", name: "Documents" },
  ]);
  await expect(listMcpResources("session/one", {
    serverId: "server/one",
    cursor: "next/page",
    limit: 25,
  })).resolves.toMatchObject({ nextCursor: "next/page" });
  await expect(listMcpResourceImports("session/one")).resolves.toEqual({
    imports: [manifest],
  });
  await expect(importMcpResource("session/one", {
    serverId: "server/one",
    uri: "docs://reports/one",
    requestedInputBaseName: "quarterly-report",
  })).resolves.toMatchObject({ import: manifest });

  expect(calls).toEqual([
    {
      method: "GET",
      path: "/api/settings/mcps",
      query: "",
    },
    {
      method: "GET",
      path: "/api/sessions/session%2Fone/mcp-resources",
      query: "?serverId=server%2Fone&cursor=next%2Fpage&limit=25",
    },
    {
      method: "GET",
      path: "/api/sessions/session%2Fone/mcp-resources/imports",
      query: "",
    },
    {
      method: "POST",
      path: "/api/sessions/session%2Fone/mcp-resources/imports",
      query: "",
      body: {
        serverId: "server/one",
        uri: "docs://reports/one",
        requestedInputBaseName: "quarterly-report",
      },
    },
  ]);
});

function settingsServer(overrides: Record<string, unknown> = {}) {
  return {
    id: "documents",
    name: "Documents",
    enabled: true,
    status: "connected",
    capabilities: {
      resources: { listChanged: false, subscribe: false },
    },
    ...overrides,
  };
}

it("preserves sanitized backend error metadata", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
    error: "The MCP server did not respond.",
    code: "timeout",
    retryable: true,
  }, 504)));

  const error: unknown = await listMcpResources("session-1").catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(McpResourcesClientError);
  expect(error).toMatchObject({
    message: "The MCP server did not respond.",
    status: 504,
    code: "timeout",
    retryable: true,
  });
});

function importManifest(): McpResourceImportManifest {
  return {
    version: 1,
    snapshotId: "snapshot-1",
    sessionId: "session/one",
    capturedAt: "2026-07-12T12:00:00.000Z",
    server: { id: "server/one", name: "Documents" },
    resource: {
      id: "resource-1",
      uri: "docs://reports/one",
      name: "Report",
    },
    totalBytes: 6,
    contents: [{
      id: "content-1",
      sourceUri: "docs://reports/one",
      mimeType: "text/plain",
      kind: "text",
      byteLength: 6,
      sha256: "a".repeat(64),
      storedPath: "contents/00-report.txt",
      materializedInputFilename: "report.txt",
    }],
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
