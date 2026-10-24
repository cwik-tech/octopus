import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ProviderSettings } from "@/components/settings/provider-settings";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";

const teamBuilderClientMocks = vi.hoisted(() => ({
  invalidateTeamBuilderTeamsCache: vi.fn(),
}));

vi.mock("@/lib/clients/team-builder-client", () => teamBuilderClientMocks);

const defaultModel = { provider: "codex", model: "default" };
const catalog = [
  {
    provider: "codex",
    name: "Codex CLI",
    icon: "codex",
    source: "cli",
    models: [
      {
        id: "default",
        name: "Default model",
        enabled: true,
        capabilities: ["chat"],
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        enabled: true,
        capabilities: ["chat"],
      },
    ],
  },
];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("shows the persisted global default model in Settings", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("/settings/providers")
        ? {
            connections: [],
            cliAgents: [],
            catalog,
            defaultModel,
          }
        : { catalog, defaultModel };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  expect(
    await screen.findByRole("heading", { name: "Default Model" }),
  ).toBeInTheDocument();
  expect(await screen.findByLabelText("Default model")).toHaveTextContent(
    "Default model",
  );
});

it("changes the global default only after an explicit selection", async () => {
  const updates: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/settings/default-model")) {
        const selection = JSON.parse(String(init?.body)) as object;
        updates.push(selection);
        return new Response(JSON.stringify({ defaultModel: selection }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const payload = url.includes("/settings/providers")
        ? { connections: [], cliAgents: [], catalog, defaultModel }
        : { catalog, defaultModel };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  const trigger = await screen.findByLabelText("Default model");
  expect(updates).toHaveLength(0);

  const user = userEvent.setup();
  await user.click(trigger);
  await user.click(await screen.findByText("GPT-5.6-Sol"));

  await waitFor(() => {
    expect(updates).toEqual([{ provider: "codex", model: "gpt-5.6-sol" }]);
    expect(
      teamBuilderClientMocks.invalidateTeamBuilderTeamsCache,
    ).toHaveBeenCalledTimes(1);
  });
});

it("fills CLI accordion rows and exposes versions through an info tooltip", async () => {
  const cliAgents = [
    {
      id: "codex",
      name: "Codex CLI",
      command: "codex",
      available: true,
      enabled: true,
      path: "/opt/homebrew/bin/codex",
      version: "codex-cli 0.144.1",
      models: [
        { id: "default", name: "Default model", enabled: true },
        { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", enabled: true },
        { id: "gpt-5.4", name: "GPT-5.4", enabled: false },
      ],
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const payload = String(input).includes("/settings/providers")
        ? { connections: [], cliAgents, catalog, defaultModel }
        : { catalog, defaultModel };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  const { container } = render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  expect(await screen.findByText("Codex CLI")).toBeInTheDocument();
  const row = container.querySelector('[data-cli-agent="codex"]');
  const controls = row?.querySelector("[data-cli-agent-controls]");
  const trigger = row?.querySelector('[data-slot="accordion-trigger"]');

  expect(row).toHaveClass("w-full");
  expect(trigger?.parentElement).toHaveClass("flex-1");
  expect(controls).toHaveClass("ml-auto", "justify-end");
  expect(controls).toHaveTextContent("2/3");

  const user = userEvent.setup();
  await user.hover(screen.getByRole("button", { name: "Show Codex CLI version" }));
  expect(await screen.findByText("codex-cli 0.144.1")).toBeInTheDocument();
});

it("persists the provider concurrency limit used for parallel Agent generation", async () => {
  const savedConnections: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/settings/providers") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as object;
        savedConnections.push(body);
        return new Response(JSON.stringify({ id: "openrouter-1", ...body, models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const payload = url.includes("/settings/providers")
        ? { connections: [], cliAgents: [], catalog, defaultModel }
        : { catalog, defaultModel };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Add" }));
  expect(screen.getByText("Maximum concurrent requests")).toBeInTheDocument();
  const concurrency = screen.getByRole("spinbutton");
  expect(concurrency).toHaveValue(3);
  await user.clear(concurrency);
  await user.type(concurrency, "5");
  await user.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(savedConnections).toEqual([
      expect.objectContaining({ maxConcurrentRequests: 5 }),
    ]);
  });
});

const connectedConnection = (models: Array<{ id: string; name: string; enabled: boolean }>) => ({
  id: "openrouter-1",
  kind: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  enabled: true,
  status: "connected",
  hasApiKey: true,
  apiKeyPreview: "sk-...9f21",
  maxConcurrentRequests: 3,
  models,
});

function stubProviderSettings(connections: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const payload = String(input).includes("/settings/providers")
        ? { connections, cliAgents: [], catalog, defaultModel }
        : { catalog, defaultModel };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

it("tells the user to enable a model when a connected connection has none enabled", async () => {
  stubProviderSettings([
    connectedConnection([
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", enabled: false },
      { id: "gpt-5.4", name: "GPT-5.4", enabled: false },
    ]),
  ]);

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  expect(
    await screen.findByText(/enable at least one model to use it/i),
  ).toBeInTheDocument();
});

it("omits the enable-a-model message once a connection has one enabled", async () => {
  stubProviderSettings([
    connectedConnection([
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", enabled: true },
      { id: "gpt-5.4", name: "GPT-5.4", enabled: false },
    ]),
  ]);

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  expect(await screen.findByText("1/2")).toBeInTheDocument();
  expect(
    screen.queryByText(/enable at least one model to use it/i),
  ).not.toBeInTheDocument();
});

/**
 * The application-wide default effort, beside the default model.
 *
 * It answers the same question for depth that the model control answers for
 * capability: what a turn runs at when nothing more specific was chosen. It is
 * deliberately not offered an "Application default" entry of its own, because
 * this control *is* that default.
 */
function stubEffortSettings(
  overrides: { defaultEffort?: string; effortCapabilities?: unknown } = {},
  onPatch?: (body: unknown) => void,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/settings/default-effort")) {
        const body = JSON.parse(String(init?.body)) as object;
        onPatch?.(body);
        return new Response(JSON.stringify({ defaultEffort: "xhigh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const effortCapabilities = overrides.effortCapabilities ?? [
        { provider: "codex", model: "default", levels: ["low", "medium", "high", "xhigh"] },
      ];
      const payload = url.includes("/settings/providers")
        ? {
            connections: [],
            cliAgents: [],
            catalog,
            defaultModel,
            defaultEffort: overrides.defaultEffort ?? "medium",
          }
        : {
            catalog,
            defaultModel,
            // The catalogue names the default's state, which is what the menu
            // reads to know which pair's levels to offer.
            defaultModelState: {
              status: "available",
              provider: defaultModel.provider,
              model: defaultModel.model,
            },
            effortCapabilities,
            defaultEffort: overrides.defaultEffort ?? "medium",
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

it("shows the persisted default effort beside the default model", async () => {
  stubEffortSettings({ defaultEffort: "high" });

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  await waitFor(async () =>
    expect(await screen.findByLabelText("Default effort")).toHaveTextContent("high"),
  );
});

it("offers the default model's own levels, and never itself", async () => {
  stubEffortSettings();
  const user = userEvent.setup();

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  await user.click(await screen.findByLabelText("Default effort"));
  for (const level of ["low", "medium", "high", "xhigh"]) {
    expect(await screen.findByRole("option", { name: new RegExp(`^${level}$`) })).toBeTruthy();
  }
  expect(await screen.findByRole("option", { name: /Provider default/i })).toBeTruthy();
  // Offering "Application default" here would point the setting at itself.
  expect(screen.queryByRole("option", { name: /Application default/i })).toBeNull();
});

it("saves a chosen default effort", async () => {
  const patches: unknown[] = [];
  stubEffortSettings({}, (body) => patches.push(body));
  const user = userEvent.setup();

  render(
    <ProviderCatalogProvider>
      <ProviderSettings />
    </ProviderCatalogProvider>,
  );

  await user.click(await screen.findByLabelText("Default effort"));
  await user.click(await screen.findByRole("option", { name: /^xhigh$/ }));

  await waitFor(() => expect(patches).toEqual([{ effort: "xhigh" }]));
});

it("shows saved CLI information while discovery waits and replaces it when discovery completes", async () => {
  let finish: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const makeSnapshot = (name: string) => ({
    connections: [], catalog: [], defaultModel: null, defaultModelState: { status: "unset" },
    cliAgents: [{ id: "qwen", name, command: "qwen", available: true, enabled: true, models: [] }],
  });
  // Intercept only HTTP: real CLI discovery is nondeterministic and credential-dependent.
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/settings/providers?refresh=1")) return pending;
    return Promise.resolve(new Response(JSON.stringify(makeSnapshot("Saved CLI")), { status: 200 }));
  }));
  render(<ProviderCatalogProvider><ProviderSettings /></ProviderCatalogProvider>);
  expect(await screen.findByRole("button", { name: "Saved CLI" })).toBeInTheDocument();
  finish(new Response(JSON.stringify(makeSnapshot("Refreshed CLI")), { status: 200 }));
  expect(await screen.findByRole("button", { name: "Refreshed CLI" })).toBeInTheDocument();
});
