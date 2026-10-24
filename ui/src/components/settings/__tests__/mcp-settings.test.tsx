import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { McpSettings } from "@/components/settings/mcp-settings";
import type {
  McpServerInput,
  McpServerView,
} from "@/lib/clients/mcp-settings-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows honest statuses and supports reconnect, one-step enable, and confirmed delete", async () => {
  const api = installMcpApi([
    stdioServer({ id: "pending", name: "Pending", status: "unvalidated" }),
    stdioServer({ id: "connected", name: "Connected tools", status: "connected" }),
    stdioServer({ id: "disabled", name: "Disabled tools", enabled: false, status: "disabled" }),
    oauthServer(),
  ]);
  const user = userEvent.setup();
  render(<McpSettings />);

  const pending = await serverRow("pending");
  expect(within(pending).getByText("Unvalidated")).toBeInTheDocument();
  expect(within(pending).getByRole("switch", { name: "Enable Pending" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(within(await serverRow("connected")).getByText("Connected")).toBeInTheDocument();
  expect(within(await serverRow("disabled")).getByText("Disabled")).toBeInTheDocument();
  expect(within(await serverRow("oauth")).getByText("Authorization required")).toBeInTheDocument();

  await user.click(within(await serverRow("connected")).getByRole("button", { name: "Reconnect" }));
  await waitFor(() => {
    expect(api.calls.some((call) =>
      call.method === "POST" && call.path.endsWith("/connected/reconnect"),
    )).toBe(true);
  });

  const callCountBeforeEnable = api.calls.length;
  await user.click(within(await serverRow("disabled")).getByRole("switch", {
    name: "Enable Disabled tools",
  }));
  await waitFor(() => {
    const row = document.querySelector('[data-mcp-server="disabled"]');
    expect(row).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("Connected"))
      .toBeInTheDocument();
  });
  const enableCalls = api.calls.slice(callCountBeforeEnable);
  expect(enableCalls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  expect(enableCalls.some((call) => call.path.endsWith("/validate"))).toBe(false);

  await user.click(within(await serverRow("pending")).getByRole("button", {
    name: "Delete Pending",
  }));
  expect(within(pending).getByRole("button", { name: "Confirm delete" })).toBeInTheDocument();
  await user.click(within(pending).getByRole("button", { name: "Confirm delete" }));
  await waitFor(() => {
    expect(document.querySelector('[data-mcp-server="pending"]')).not.toBeInTheDocument();
  });
  expect(api.calls.some((call) =>
    call.method === "DELETE" && call.path.endsWith("/pending"),
  )).toBe(true);
});

it("saves structured stdio fields and never restores submitted secret values", async () => {
  const api = installMcpApi([]);
  const user = userEvent.setup();
  render(<McpSettings />);

  await user.click(await screen.findByRole("button", { name: "Add connection" }));
  expect(screen.queryByText(
    "Put credentials in Secret environment variables below, not command arguments.",
  )).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Name"), "Filesystem tools");
  await user.type(screen.getByLabelText("Command"), "node");
  fireEvent.change(screen.getByLabelText("Arguments, one per line"), {
    target: { value: "server.mjs\n--read-only" },
  });
  await user.type(screen.getByLabelText("Working directory (optional)"), "/tmp");
  await user.click(screen.getByRole("button", { name: "Add capability" }));
  await user.type(screen.getByLabelText("Workflow capability 1"), "Documents.Read");
  await user.selectOptions(
    screen.getByLabelText("Workflow capability access 1"),
    "any",
  );
  await user.click(screen.getByRole("button", { name: "Add secret" }));
  await user.type(screen.getByLabelText("Secret environment variables key 1"), "API_TOKEN");
  await user.type(screen.getByLabelText("Secret environment variables value 1"), "super-secret");
  const saveButton = screen.getByRole("button", { name: "Save & Validate" });
  expect(saveButton).toBeDisabled();
  await user.click(screen.getByRole("checkbox", {
    name: "I trust this command and understand validation will run it locally on this computer.",
  }));
  expect(saveButton).toBeEnabled();
  await user.click(saveButton);

  expect(await screen.findByText("Filesystem tools saved and connected.")).toBeInTheDocument();
  const createCall = api.calls.find((call) =>
    call.method === "POST" && call.path.endsWith("/settings/mcps"),
  );
  expect(createCall?.body).toEqual({
    name: "Filesystem tools",
    enabled: true,
    capabilityAliases: [
      { capability: "documents.read", access: "any" },
    ],
    transport: {
      type: "stdio",
      command: "node",
      args: ["server.mjs", "--read-only"],
      cwd: "/tmp",
      secretEnvironment: {
        API_TOKEN: { operation: "replace", value: "super-secret" },
      },
    },
  });
  const validateCall = api.calls.find((call) =>
    call.method === "POST" && call.path.endsWith("/validate"),
  );
  expect(validateCall?.body).toEqual({ stdioTrustAcknowledged: true });
  expect(screen.queryByDisplayValue("super-secret")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("super-secret");

  await user.click(screen.getByRole("button", { name: "Edit Filesystem tools" }));
  const storedValue = screen.getByLabelText("Secret environment variables value 1");
  expect(storedValue).toHaveValue("");
  expect(storedValue).toHaveAttribute("type", "password");
  expect(screen.getByRole("checkbox", {
    name: "I trust this command and understand validation will run it locally on this computer.",
  })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Save & Validate" })).toBeDisabled();
});

it("imports provider JSON into reviewable fields before saving", async () => {
  const api = installMcpApi([]);
  const user = userEvent.setup();
  render(<McpSettings />);

  await user.click(await screen.findByRole("button", { name: "Add connection" }));
  await user.click(screen.getByRole("button", { name: "Paste JSON" }));
  expect(screen.getByText(/Claude\/Cursor/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("MCP configuration JSON"), {
    target: { value: "{ invalid" },
  });
  await user.click(screen.getByRole("button", { name: "Apply JSON" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter valid JSON.");

  fireEvent.change(screen.getByLabelText("MCP configuration JSON"), {
    target: {
      value: JSON.stringify({
        mcpServers: {
          "mcp-docs": {
            type: "streamable-http",
            url: "https://modelcontextprotocol.io/mcp",
          },
        },
      }),
    },
  });
  await user.click(screen.getByRole("button", { name: "Apply JSON" }));

  expect(screen.getByRole("status")).toHaveTextContent(
    "mcp-docs imported from JSON. Review the fields, then save and validate.",
  );
  expect(screen.getByLabelText("Name")).toHaveValue("mcp-docs");
  expect(screen.getByLabelText("MCP transport")).toHaveValue("streamable-http");
  expect(screen.getByLabelText("MCP URL")).toHaveValue(
    "https://modelcontextprotocol.io/mcp",
  );
  expect(screen.getByText(/Most connections can leave this section empty/))
    .toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Save & Validate" }));
  expect(await screen.findByText("mcp-docs saved and connected.")).toBeInTheDocument();
  const createCall = api.calls.find((call) =>
    call.method === "POST" && call.path.endsWith("/settings/mcps"),
  );
  expect(createCall?.body).toEqual({
    name: "mcp-docs",
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: "streamable-http",
      url: "https://modelcontextprotocol.io/mcp",
      authentication: { type: "none" },
    },
  });
});

it("explains manual MCP fields with accessible information tooltips", async () => {
  installMcpApi([]);
  const user = userEvent.setup();
  render(<McpSettings />);

  await user.click(await screen.findByRole("button", { name: "Add connection" }));
  const commandHelp = screen.getByRole("button", { name: "Help: local command" });
  await user.hover(commandHelp);
  expect(await screen.findByText(/executable that starts the local MCP server/))
    .toBeInTheDocument();
  await user.unhover(commandHelp);

  const argumentsHelp = screen.getByRole("button", {
    name: "Help: command arguments",
  });
  await user.hover(argumentsHelp);
  expect(await screen.findByText(/Everything after the command, in the same order/))
    .toBeInTheDocument();
  await user.unhover(argumentsHelp);

  const environmentHelp = screen.getByRole("button", {
    name: "Help: environment secrets",
  });
  await user.hover(environmentHelp);
  expect(await screen.findByText(/values are encrypted and are not placed in command arguments/))
    .toBeInTheDocument();
  await user.unhover(environmentHelp);

  await user.selectOptions(screen.getByLabelText("MCP transport"), "streamable-http");
  expect(screen.getByRole("button", { name: "Help: remote endpoint" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Help: HTTP authentication choice" }))
    .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Help: workflow matching" }))
    .toBeInTheDocument();
});

it("rejects invalid or duplicate workflow capability aliases before saving", async () => {
  const api = installMcpApi([]);
  const user = userEvent.setup();
  render(<McpSettings />);

  await user.click(await screen.findByRole("button", { name: "Add connection" }));
  await user.type(screen.getByLabelText("Name"), "Capability fixture");
  await user.type(screen.getByLabelText("Command"), "node");
  await user.click(screen.getByRole("checkbox", {
    name: "I trust this command and understand validation will run it locally on this computer.",
  }));
  await user.click(screen.getByRole("button", { name: "Add capability" }));
  await user.type(screen.getByLabelText("Workflow capability 1"), "https://secret.example");
  await user.click(screen.getByRole("button", { name: "Save & Validate" }));
  expect(await screen.findByText(/lowercase semantic name/i)).toBeInTheDocument();

  await user.clear(screen.getByLabelText("Workflow capability 1"));
  await user.type(screen.getByLabelText("Workflow capability 1"), "web.search");
  await user.click(screen.getByRole("button", { name: "Add capability" }));
  await user.type(screen.getByLabelText("Workflow capability 2"), "WEB.SEARCH");
  await user.click(screen.getByRole("button", { name: "Save & Validate" }));
  expect(await screen.findByText(/listed more than once/i)).toBeInTheDocument();
  expect(api.calls.some((call) =>
    call.method === "POST" && call.path.endsWith("/settings/mcps"),
  )).toBe(false);
});

it("preserves and replaces redacted HTTP headers, then removes them when auth changes", async () => {
  const api = installMcpApi([httpHeaderServer()]);
  const user = userEvent.setup();
  render(<McpSettings />);

  await user.click(await screen.findByRole("button", { name: "Edit Remote headers" }));
  expect(screen.getByLabelText("Secret headers value 1")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Add secret" }));
  await user.type(screen.getByLabelText("Secret headers key 2"), "X-Token");
  await user.type(screen.getByLabelText("Secret headers value 2"), "new-token");
  await user.click(screen.getByRole("button", { name: "Save & Validate" }));
  await screen.findByText("Remote headers saved and connected.");

  const firstUpdate = api.calls.find((call) => call.method === "PUT");
  expect((firstUpdate?.body as McpServerInput).transport).toMatchObject({
    type: "streamable-http",
    authentication: { type: "secret-headers" },
    secretHeaders: {
      authorization: { operation: "preserve" },
      "X-Token": { operation: "replace", value: "new-token" },
    },
  });
  expect(screen.queryByDisplayValue("new-token")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit Remote headers" }));
  await user.selectOptions(screen.getByLabelText("HTTP authentication"), "none");
  await user.click(screen.getByRole("button", { name: "Save & Validate" }));
  await waitFor(() => expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(2));
  const secondUpdate = api.calls.filter((call) => call.method === "PUT")[1];
  expect((secondUpdate?.body as McpServerInput).transport).toMatchObject({
    type: "streamable-http",
    authentication: { type: "none" },
    secretHeaders: {
      authorization: { operation: "remove" },
      "X-Token": { operation: "remove" },
    },
  });
});

it("keeps OAuth unavailable until authorization is implemented and preserves existing metadata honestly", async () => {
  const api = installMcpApi([oauthServer()]);
  const user = userEvent.setup();
  render(<McpSettings />);

  await user.click(await screen.findByRole("button", { name: "Add connection" }));
  await user.selectOptions(screen.getByLabelText("MCP transport"), "streamable-http");
  const oauthOption = screen.getByRole("option", { name: "OAuth (coming later)" });
  expect(oauthOption).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Edit OAuth server" }));
  expect(screen.getByLabelText("HTTP authentication")).toHaveValue("oauth");
  expect(screen.getByText(/Existing OAuth metadata is preserved/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save & Validate" }));
  expect(await screen.findByText(
    "OAuth MCP connections are not supported yet. Choose None or Secret headers.",
  )).toBeInTheDocument();
  expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
});

async function serverRow(id: string): Promise<HTMLElement> {
  const row = await waitFor(() => {
    const element = document.querySelector(`[data-mcp-server="${id}"]`);
    expect(element).toBeInTheDocument();
    return element as HTMLElement;
  });
  return row;
}

interface RecordedCall {
  path: string;
  method: string;
  body?: unknown;
}

function installMcpApi(initialServers: McpServerView[]) {
  let servers = [...initialServers];
  let nextId = 1;
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request), "http://localhost");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });

    if (method === "GET" && path.endsWith("/settings/mcps")) {
      return jsonResponse({ servers });
    }
    if (method === "POST" && path.endsWith("/settings/mcps")) {
      const server = viewFromInput(`server-${nextId++}`, body as unknown as McpServerInput);
      servers.push(server);
      return jsonResponse({ server });
    }

    const id = decodeURIComponent(path.split("/").at(-1) ?? "");
    const actionId = decodeURIComponent(path.split("/").at(-2) ?? "");
    if (method === "POST" && (id === "validate" || id === "reconnect")) {
      const index = servers.findIndex((server) => server.id === actionId);
      const current = servers[index]!;
      const oauth = current.transport.type === "streamable-http" &&
        current.transport.authentication.type === "oauth";
      const next: McpServerView = oauth
        ? { ...current, status: "error", statusMessage: "Authorization required." }
        : {
            ...current,
            enabled: true,
            status: "connected",
            capabilities: { tools: { listChanged: false }, logging: false },
      };
      // A check that connects leaves no earlier failure message behind.
      if (!oauth) delete next.statusMessage;
      servers[index] = next;
      return oauth
        ? jsonResponse({ error: "Authorization required.", server: next }, 409)
        : jsonResponse({ server: next });
    }
    if (method === "PUT") {
      const serverId = id;
      const index = servers.findIndex((server) => server.id === serverId);
      const next = viewFromInput(serverId, body as unknown as McpServerInput);
      servers[index] = next;
      return jsonResponse({ server: next });
    }
    if (method === "PATCH") {
      const index = servers.findIndex((server) => server.id === id);
      const current = servers[index]!;
      const enabled = body?.enabled === true;
      const next: McpServerView = {
        ...current,
        enabled,
        status: enabled ? "connected" : "disabled",
      };
      servers[index] = next;
      return jsonResponse({ server: next });
    }
    if (method === "DELETE") {
      servers = servers.filter((server) => server.id !== id);
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: "Unexpected test request" }, 500);
  }));
  return { calls };
}

function viewFromInput(id: string, input: McpServerInput): McpServerView {
  if (input.transport.type === "stdio") {
    return stdioServer({
      id,
      name: input.name,
      enabled: input.enabled ?? true,
      status: input.enabled === false ? "disabled" : "unvalidated",
      transport: {
        type: "stdio",
        command: input.transport.command,
        args: input.transport.args,
        ...(input.transport.cwd ? { cwd: input.transport.cwd } : {}),
        environmentKeys: appliedSecretKeys(input.transport.secretEnvironment),
        hasSecrets: Boolean(Object.keys(input.transport.secretEnvironment ?? {}).length),
      },
    });
  }
  const authentication = input.transport.authentication.type === "oauth"
    ? {
        ...input.transport.authentication,
        status: "authorization-required" as const,
        hasCredentials: false,
      }
    : input.transport.authentication;
  return {
    id,
    name: input.name,
    enabled: input.enabled ?? true,
    capabilityAliases: input.capabilityAliases ?? [],
    transport: {
      type: "streamable-http",
      url: input.transport.url,
      headerKeys: appliedSecretKeys(input.transport.secretHeaders),
      hasSecrets: Boolean(Object.keys(input.transport.secretHeaders ?? {}).length),
      authentication,
    },
    status: input.enabled === false ? "disabled" : "unvalidated",
    capabilities: { logging: false },
  };
}

function appliedSecretKeys(patch: Record<string, { operation: string }> | undefined): string[] {
  return Object.entries(patch ?? {})
    .filter(([, operation]) => operation.operation !== "remove")
    .map(([key]) => key);
}

function stdioServer(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: "stdio",
    name: "stdio",
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
    ...overrides,
  };
}

function httpHeaderServer(): McpServerView {
  return {
    id: "headers",
    name: "Remote headers",
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.test/mcp",
      headerKeys: ["authorization"],
      hasSecrets: true,
      authentication: { type: "secret-headers" },
    },
    status: "connected",
    capabilities: { tools: { listChanged: false }, logging: false },
  };
}

function oauthServer(): McpServerView {
  return {
    id: "oauth",
    name: "OAuth server",
    enabled: true,
    capabilityAliases: [],
    transport: {
      type: "streamable-http",
      url: "https://oauth.example.test/mcp",
      headerKeys: [],
      hasSecrets: false,
      authentication: {
        type: "oauth",
        scopes: ["mcp:tools"],
        status: "authorization-required",
        hasCredentials: false,
      },
    },
    status: "error",
    capabilities: { logging: false },
    statusMessage: "Authorization required.",
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
