import { afterEach, expect, it, vi } from "vitest";

import {
  McpInteractionsClientError,
  listMcpInteractions,
  respondToMcpInteraction,
} from "@/lib/clients/mcp-interactions-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("lists pending interactions and posts exact response bodies to encoded routes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    if (init?.method === "POST") {
      return jsonResponse({ interaction: approval({ status: "approved-run" }) });
    }
    return jsonResponse({ interactions: [approval()], truncated: false });
  }));

  await expect(listMcpInteractions("session/one")).resolves.toMatchObject({
    interactions: [{ kind: "approval", status: "pending" }],
    truncated: false,
  });
  await expect(respondToMcpInteraction(
    "session/one",
    "interaction/one",
    { kind: "approval", decision: "approve", scope: "run" },
  )).resolves.toMatchObject({ status: "approved-run" });

  expect(calls[0]?.url).toBe("/api/sessions/session%2Fone/mcp-interactions");
  expect(calls[0]?.init).toBeUndefined();
  expect(calls[1]?.url).toBe(
    "/api/sessions/session%2Fone/mcp-interactions/interaction%2Fone/respond",
  );
  expect(calls[1]?.init).toMatchObject({
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
    kind: "approval",
    decision: "approve",
    scope: "run",
  });
});

it("sends form values only in the elicitation response body", async () => {
  let capturedInit: RequestInit | undefined;
  const fetchMock = vi.fn(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    expect(String(input)).toContain("/mcp-interactions/");
    capturedInit = init;
    return jsonResponse({ interaction: formElicitation({ status: "accepted" }) });
  });
  vi.stubGlobal("fetch", fetchMock);

  await respondToMcpInteraction("session-1", "interaction-1", {
    kind: "elicitation",
    action: "accept",
    values: { query: "quarterly revenue", limit: 5, includeDrafts: false },
  });

  expect(JSON.parse(String(capturedInit?.body))).toEqual({
    kind: "elicitation",
    action: "accept",
    values: { query: "quarterly revenue", limit: 5, includeDrafts: false },
  });
});

it("returns sanitized backend error metadata", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
    error: "This request was already resolved.",
    code: "conflict",
  }, 409)));

  const error: unknown = await listMcpInteractions("session-1").catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(McpInteractionsClientError);
  expect(error).toMatchObject({
    message: "This request was already resolved.",
    status: 409,
    code: "conflict",
  });
});

function approval(overrides: Record<string, unknown> = {}) {
  return {
    kind: "approval",
    interactionId: "interaction-1",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath: "agents/researcher.md",
    serverId: "documents",
    toolCallId: "tool-call-1",
    namespacedToolName: "mcp__documents__search",
    toolRisk: "mutating",
    argumentNames: ["query"],
    status: "pending",
    createdAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:05:00.000Z",
    ...overrides,
  };
}

function formElicitation(overrides: Record<string, unknown> = {}) {
  return {
    kind: "elicitation",
    mode: "form",
    interactionId: "interaction-1",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath: "agents/researcher.md",
    serverId: "documents",
    toolCallId: "tool-call-1",
    namespacedToolName: "mcp__documents__search",
    message: "Choose search options",
    schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    status: "pending",
    createdAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:05:00.000Z",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
