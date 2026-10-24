import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";

import AgentPackageEditor from "@/components/create/agent-package-editor";
import type {
  AgentDetail,
  AgentPackageImportItem,
} from "@/lib/models/agent-generator-model";
import type { AgentMcpGrantServer } from "@/lib/clients/mcp-agent-grants-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("orders Tools after Skills, shows built-in tools first, and opens MCPs by default", async () => {
  const user = userEvent.setup();
  const onRevealAsset = vi.fn();
  const onPersonaChange = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(
    <AgentPackageEditor
      {...editorProps({
        onRevealAsset,
        onPersonaChange,
        personaMarkdown: "---\ntools: none\n---\n\n# Alpha agent",
      })}
      agentDetail={agentDetail("alpha", true)}
    />,
  );

  const topLevelTabs = screen.getAllByRole("tablist")[0]!;
  expect(within(topLevelTabs).queryByRole("tab", { name: /^Scripts/ })).not.toBeInTheDocument();
  expect(within(topLevelTabs).getAllByRole("tab").map((tab) =>
    tab.textContent?.trim().replace(/\d+$/, ""),
  )).toEqual([
    "Persona",
    "Skills",
    "Tools",
    "Templates",
    "References",
    "Context",
    "Usage",
  ]);
  expect(screen.queryByText("Web research")).not.toBeInTheDocument();

  const toolsTab = within(topLevelTabs).getByRole("tab", { name: /^Tools/ });
  await user.click(toolsTab);

  expect(screen.getByText("Web research")).toBeInTheDocument();
  expect(screen.getByText("Generate Word")).toBeInTheDocument();
  expect(screen.getByText("Generate Excel")).toBeInTheDocument();
  expect(screen.getAllByText("Built-in")).toHaveLength(3);
  const researchSwitch = screen.getByRole("switch", {
    name: "Toggle Web research",
  });
  expect(researchSwitch).not.toBeChecked();
  await user.click(researchSwitch);
  expect(onPersonaChange).toHaveBeenCalledWith(
    "---\ntools: research_web\n---\n\n# Alpha agent",
  );
  const generateWordSwitch = screen.getByRole("switch", {
    name: "Toggle Generate Word",
  });
  expect(generateWordSwitch).not.toBeChecked();
  await user.click(generateWordSwitch);
  expect(onPersonaChange).toHaveBeenCalledWith(
    "---\ntools: generate_word\n---\n\n# Alpha agent",
  );
  const generateExcelSwitch = screen.getByRole("switch", {
    name: "Toggle Generate Excel",
  });
  expect(generateExcelSwitch).not.toBeChecked();
  await user.click(generateExcelSwitch);
  expect(onPersonaChange).toHaveBeenCalledWith(
    "---\ntools: generate_excel\n---\n\n# Alpha agent",
  );

  const toolTypes = screen.getByRole("tablist", { name: "Agent tool types" });
  expect(within(toolTypes).getAllByRole("tab").map((tab) => tab.textContent?.trim()))
    .toEqual(["MCPs", "Scripts"]);
  expect(within(toolTypes).getByRole("tab", { name: "MCPs" }))
    .toHaveAttribute("aria-selected", "true");
  expect(await screen.findByText("No globally enabled MCP connections are available."))
    .toBeInTheDocument();

  await user.click(within(toolTypes).getByRole("tab", { name: "Scripts" }));
  expect(screen.getByText("scripts/cleanup.ts")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Import scripts" })).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "scripts/cleanup.ts" }));
  expect(onRevealAsset).toHaveBeenCalledWith("/agents/alpha/scripts/cleanup.ts");
});

it.each([
  ["Web research", "research_web"],
  ["Generate Word", "generate_word"],
  ["Generate Excel", "generate_excel"],
])("saves a %s switch change immediately without a Save button", async (label, tool) => {
  // MCP discovery is unavailable here; only its HTTP boundary is replaced.
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  const onSave = vi.fn();
  render(<AgentPackageEditor {...editorProps({
    onSave,
    personaMarkdown: "---\ntools: none\n---\n\n# Alpha agent",
  })} />);

  await userEvent.click(screen.getByRole("tab", { name: /^Tools/ }));
  await userEvent.click(screen.getByRole("switch", { name: `Toggle ${label}` }));

  expect(onSave).toHaveBeenCalledWith(`---\ntools: ${tool}\n---\n\n# Alpha agent`);
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

it("puts the agent name and model picker in a header above the tabs", async () => {
  const user = userEvent.setup();
  const onBack = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  const props = editorProps({
    agentName: "data-security-specialist",
    personaMarkdown: "---\nname: data-security-specialist\n---\n\n# Agent",
  });
  const { container, rerender } = render(<AgentPackageEditor {...props} />);

  const header = container.querySelector<HTMLElement>(
    '[data-slot="agent-editor-header"]',
  )!;
  expect(header).toHaveTextContent("Data Security Specialist");
  expect(within(header).getByLabelText("Agent model")).toBeInTheDocument();
  // Level with the left sidebar's Agents/Teams/Workflows switcher: no extra
  // top padding, and the same 28px height.
  expect(header.className).not.toMatch(/\bpt-/);
  expect(within(header).getByLabelText("Agent model")).toHaveClass("h-7");
  // Only a caller that came from somewhere offers a way back to it.
  expect(within(header).queryByLabelText("Back to team")).not.toBeInTheDocument();

  rerender(
    <AgentPackageEditor
      {...props}
      back={{ label: "Back to team", onClick: onBack }}
    />,
  );
  await user.click(within(header).getByLabelText("Back to team"));

  expect(onBack).toHaveBeenCalledTimes(1);
});

it("saves as soon as the model changes", async () => {
  const user = userEvent.setup();
  const onPersonaChange = vi.fn();
  const onSave = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(
    <AgentPackageEditor
      {...editorProps({
        onPersonaChange,
        onSave,
        personaMarkdown:
          "---\nname: alpha\nprovider: connection:openai\nmodel: chat-only\n---\n\n# Alpha agent",
      })}
    />,
  );

  await user.click(screen.getByLabelText("Agent model"));
  await user.click(await screen.findByRole("option", { name: /^Use app default/ }));

  const inheriting = "---\nname: alpha\n---\n\n# Alpha agent";
  expect(onPersonaChange).toHaveBeenCalledWith(inheriting);
  expect(onSave).toHaveBeenCalledWith(inheriting);
});

it("draws no rule under the tab row", () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(<AgentPackageEditor {...editorProps()} />);

  expect(
    screen.getAllByRole("tablist")[0]!.closest('[data-slot="panel-header"]'),
  ).toHaveClass("border-b-0");
});

it("shows tab counts as plain numbers", () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(
    <AgentPackageEditor
      {...editorProps()}
      agentDetail={agentDetail("alpha", true)}
    />,
  );

  const toolsTab = screen.getByRole("tab", { name: /^Tools/ });
  const count = within(toolsTab).getByText("1");
  expect(count.className).not.toMatch(/\bbg-/);
  expect(count.className).not.toMatch(/\bpx-/);
});

it("defaults website restrictions off and persists an explicit opt-in", async () => {
  const onPersonaChange = vi.fn();
  const onSave = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(
    <AgentPackageEditor
      {...editorProps({
        onPersonaChange,
        onSave,
        personaMarkdown: "---\ntools: research_web\n---\n\n# Alpha agent",
      })}
      agentDetail={agentDetail("alpha")}
    />,
  );

  await userEvent.setup().click(screen.getByRole("tab", { name: /^Tools/ }));
  const restriction = screen.getByRole("switch", { name: "Toggle website restrictions" });
  expect(restriction).not.toBeChecked();
  expect(screen.queryByLabelText("Allowed browser domains")).not.toBeInTheDocument();
  await userEvent.setup().click(restriction);
  expect(onPersonaChange).toHaveBeenCalledWith(
    "---\ntools: research_web\nbrowser_restrict_domains: true\n---\n\n# Alpha agent",
  );
  expect(onSave).toHaveBeenCalledWith(
    "---\ntools: research_web\nbrowser_restrict_domains: true\n---\n\n# Alpha agent",
  );
});

it("stores an explicit normalized domain allowlist when website restrictions are enabled", async () => {
  const onPersonaChange = vi.fn();
  const onSave = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(
    <AgentPackageEditor
      {...editorProps({
        onPersonaChange,
        onSave,
        personaMarkdown: "---\ntools: research_web\nbrowser_restrict_domains: true\nbrowser_domains: example.com\n---\n\n# Alpha agent",
      })}
      agentDetail={agentDetail("alpha")}
    />,
  );

  await userEvent.setup().click(screen.getByRole("tab", { name: /^Tools/ }));
  const domains = screen.getByLabelText("Allowed browser domains");
  expect(domains).toHaveValue("example.com");
  fireEvent.change(domains, { target: { value: "Example.org, *.Research.Example.org" } });

  expect(onPersonaChange).toHaveBeenCalledWith(
    "---\ntools: research_web\nbrowser_restrict_domains: true\nbrowser_domains: example.org, *.research.example.org\n---\n\n# Alpha agent",
  );
  fireEvent.blur(domains);
  expect(onSave).toHaveBeenCalled();
});

it("does not start another domain save when the input blurs during an existing save", async () => {
  // MCP discovery is unavailable here; only its HTTP boundary is replaced.
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  const onSave = vi.fn();
  const props = editorProps({ onSave, personaMarkdown: "---\ntools: research_web\nbrowser_restrict_domains: true\nbrowser_domains: example.com\n---\nBody" });
  const view = render(<AgentPackageEditor {...props} />);
  await userEvent.click(screen.getByRole("tab", { name: /^Tools/ }));
  const domains = screen.getByLabelText("Allowed browser domains");
  domains.focus();
  view.rerender(<AgentPackageEditor {...props} saving />);
  fireEvent.blur(domains);
  expect(onSave).not.toHaveBeenCalled();
});

it("keeps MCP grants agent-scoped, defaults them off, explains incompatibility, and never edits persona files", async () => {
  const user = userEvent.setup();
  const onPersonaChange = vi.fn();
  const onSave = vi.fn();
  const onCommitPackageImport = vi.fn();
  const onRemovePackageItem = vi.fn();
  const calls: RecordedCall[] = [];
  const grants = new Map<string, AgentMcpGrantServer[]>([
    ["alpha", grantServers()],
    ["beta", grantServers().map((server) => ({ ...server, granted: false }))],
  ]);
  let alphaVisible = true;

  vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request), "http://localhost");
    const method = init?.method ?? "GET";
    const match = /\/create\/agents\/([^/]+)\/mcp-grants$/.exec(url.pathname);
    if (!match) return jsonResponse({ error: "Unexpected request" }, 500);
    const agentName = decodeURIComponent(match[1]!);
    const body = init?.body
      ? JSON.parse(String(init.body)) as { serverId: string; enabled: boolean }
      : undefined;
    calls.push({ agentName, method, body });

    if (method === "GET") {
      const servers = agentName === "alpha" && !alphaVisible
        ? []
        : grants.get(agentName) ?? [];
      return jsonResponse({ servers });
    }

    const servers = grants.get(agentName) ?? [];
    const index = servers.findIndex((server) => server.id === body?.serverId);
    const updated = { ...servers[index]!, granted: body?.enabled === true };
    servers[index] = updated;
    grants.set(agentName, servers);
    return jsonResponse(updated);
  }));

  const props = editorProps({
    onPersonaChange,
    onSave,
    onCommitPackageImport,
    onRemovePackageItem,
  });
  const { rerender } = render(
    <AgentPackageEditor {...props} agentName="alpha" agentDetail={agentDetail("alpha")} />,
  );

  await user.click(screen.getByRole("tab", { name: /^Tools/ }));
  await user.click(screen.getByRole("tab", { name: "MCPs" }));

  const alphaFilesystem = await screen.findByRole("switch", {
    name: "Grant Filesystem to alpha",
  });
  expect(alphaFilesystem).not.toBeChecked();
  expect(alphaFilesystem).toBeEnabled();
  expect(screen.getByText("CLI bridge")).toBeInTheDocument();

  const offline = screen.getByRole("switch", { name: "Grant Offline tools to alpha" });
  expect(offline).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText(
    "Connection is disconnected. Connect it in Settings before granting access.",
  )).toBeInTheDocument();

  const unsupported = screen.getByRole("switch", {
    name: "Grant Provider-specific tools to alpha",
  });
  expect(unsupported).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("This agent provider cannot execute MCP tools."))
    .toBeInTheDocument();

  const staleGrant = screen.getByRole("switch", {
    name: "Grant Stale grant to alpha",
  });
  expect(staleGrant).toBeChecked();
  expect(staleGrant).toBeEnabled();
  await user.click(staleGrant);
  await waitFor(() => expect(staleGrant).not.toBeChecked());
  expect(calls).toContainEqual({
    agentName: "alpha",
    method: "PATCH",
    body: { serverId: "stale-grant", enabled: false },
  });

  await user.click(alphaFilesystem);
  await waitFor(() => expect(alphaFilesystem).toBeChecked());
  expect(calls).toContainEqual({
    agentName: "alpha",
    method: "PATCH",
    body: { serverId: "filesystem", enabled: true },
  });
  expect(onPersonaChange).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  expect(onCommitPackageImport).not.toHaveBeenCalled();
  expect(onRemovePackageItem).not.toHaveBeenCalled();

  rerender(
    <AgentPackageEditor {...props} agentName="beta" agentDetail={agentDetail("beta")} />,
  );
  const betaFilesystem = await screen.findByRole("switch", {
    name: "Grant Filesystem to beta",
  });
  expect(betaFilesystem).not.toBeChecked();

  alphaVisible = false;
  rerender(
    <AgentPackageEditor {...props} agentName="alpha" agentDetail={agentDetail("alpha")} />,
  );
  expect(await screen.findByText("No globally enabled MCP connections are available."))
    .toBeInTheDocument();
  expect(grants.get("alpha")?.find((server) => server.id === "filesystem")?.granted)
    .toBe(true);
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
  expect(onPersonaChange).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
});

it("marks unsaved edits in the gutter", () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ servers: [] })));
  render(
    <AgentPackageEditor
      {...editorProps({
        dirty: true,
        personaMarkdown: "# Alpha agent\nnew line\nchanged line",
        savedPersonaMarkdown: "# Alpha agent\nold line",
      })}
    />,
  );

  expect(screen.getAllByTitle("Line added")).toHaveLength(1);
  expect(screen.getAllByTitle("Line modified")).toHaveLength(1);
  expect(screen.queryByText("Unsaved persona edits")).not.toBeInTheDocument();
});

it("auto-commits a clean package preview without opening the review dialog", async () => {
  const previewItem = packageImportItem({ exists: false });
  const onPreviewPackageImport = vi.fn(async () => [previewItem]);
  const onCommitPackageImport = vi.fn();
  const { container } = render(
    <AgentPackageEditor
      {...editorProps({
        onPreviewPackageImport,
        onCommitPackageImport,
      })}
    />,
  );

  await userEvent.setup().click(screen.getByRole("tab", { name: /^Skills/ }));
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [packageFile("skill.md", "skill/skill.md", "body")] },
  });

  await waitFor(() => expect(onCommitPackageImport).toHaveBeenCalledOnce());
  expect(onPreviewPackageImport).toHaveBeenCalledWith("skill", [
    { relativePath: "skill/skill.md", contentBase64: window.btoa("body") },
  ]);
  expect(onCommitPackageImport).toHaveBeenCalledWith(
    "skill",
    [{ relativePath: "skill/skill.md", contentBase64: window.btoa("body") }],
    [{ id: previewItem.id, selected: true, action: "add" }],
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("preserves reviewed conflict choices when committing an import", async () => {
  const previewItem = packageImportItem({
    exists: true,
    defaultAction: "skip",
    availableActions: ["skip", "replace"],
  });
  const onPreviewPackageImport = vi.fn(async () => [previewItem]);
  const onCommitPackageImport = vi.fn();
  const { container } = render(
    <AgentPackageEditor
      {...editorProps({
        onPreviewPackageImport,
        onCommitPackageImport,
      })}
    />,
  );

  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: /^Skills/ }));
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [packageFile("skill.md", "skill/skill.md", "body")] },
  });

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("combobox"), {
    target: { value: "replace" },
  });
  await user.click(within(dialog).getByRole("button", { name: "Import selected" }));

  await waitFor(() => expect(onCommitPackageImport).toHaveBeenCalledOnce());
  expect(onCommitPackageImport.mock.calls[0]?.[2]).toEqual([
    { id: previewItem.id, selected: true, action: "replace" },
  ]);
});

interface RecordedCall {
  agentName: string;
  method: string;
  body?: { serverId: string; enabled: boolean } | undefined;
}

function editorProps(
  overrides: Partial<ComponentProps<typeof AgentPackageEditor>> = {},
): ComponentProps<typeof AgentPackageEditor> {
  return {
    agentName: "alpha",
    agentDetail: agentDetail("alpha"),
    personaMarkdown: "# Alpha agent",
    savedPersonaMarkdown: null,
    onPersonaChange: vi.fn(),
    dirty: false,
    saving: false,
    saved: null,
    saveError: null,
    onSave: vi.fn(),
    onRevealAsset: vi.fn(),
    onPreviewPackageImport: vi.fn(async () => []),
    onCommitPackageImport: vi.fn(),
    onRemovePackageItem: vi.fn(),
    ...overrides,
  };
}

function agentDetail(name: string, includeScript = false): AgentDetail {
  const scripts = includeScript
    ? [{
        path: `/agents/${name}/scripts/cleanup.ts`,
        agentPath: "scripts/cleanup.ts",
        kind: "script" as const,
        sizeBytes: 128,
      }]
    : [];
  return {
    name,
    description: `${name} agent`,
    skills: [],
    usedInTeams: [],
    personaMarkdown: `# ${name}`,
    personaPath: `/agents/${name}/agent.md`,
    agentPath: `/agents/${name}`,
    frontmatter: {},
    skillDetails: [],
    assets: scripts,
    counts: {
      skills: 0,
      templates: 0,
      references: 0,
      scripts: scripts.length,
      experience: 0,
      knowledge: 0,
      other: 0,
    },
  };
}

function grantServers(): AgentMcpGrantServer[] {
  return [
    {
      id: "filesystem",
      name: "Filesystem",
      transport: "stdio",
      status: "connected",
      enabled: true,
      granted: false,
      compatible: true,
      providerSupportMode: "host-tool-bridge",
    },
    {
      id: "offline",
      name: "Offline tools",
      transport: "streamable-http",
      status: "disconnected",
      enabled: true,
      granted: false,
      compatible: true,
    },
    {
      id: "unsupported",
      name: "Provider-specific tools",
      transport: "stdio",
      status: "connected",
      enabled: true,
      granted: false,
      compatible: false,
      reason: "This agent provider cannot execute MCP tools.",
    },
    {
      id: "stale-grant",
      name: "Stale grant",
      transport: "stdio",
      status: "disconnected",
      enabled: true,
      granted: true,
      compatible: false,
      reason: "This agent provider cannot execute MCP tools.",
    },
  ];
}

function packageImportItem(
  overrides: Partial<AgentPackageImportItem> = {},
): AgentPackageImportItem {
  return {
    id: "skill.md",
    kind: "skill",
    label: "skill.md",
    sourcePath: "skill/skill.md",
    targetAgentPath: "skills/skill.md",
    exists: false,
    defaultSelected: true,
    defaultAction: "add",
    availableActions: ["add"],
    ...overrides,
  };
}

function packageFile(
  name: string,
  webkitRelativePath: string,
  content: string,
): File {
  return {
    name,
    webkitRelativePath,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as File;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
