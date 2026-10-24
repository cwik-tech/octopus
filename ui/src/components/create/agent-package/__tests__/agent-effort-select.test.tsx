import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentEffortSelect } from "../agent-effort-select";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";

function catalogWith() {
  return [
    {
      provider: "connection:openai",
      name: "OpenAI",
      icon: "openai",
      source: "connection" as const,
      models: [
        {
          id: "chat-only",
          name: "Chat only",
          enabled: true,
          capabilities: ["chat" as const],
        },
      ],
    },
  ];
}

/**
 * The payload the client actually parses.
 *
 * Effort ranges travel beside the catalogue, not inside a model entry, because
 * an Agent may name a provider that has no catalogue group at all.
 */
function stubCatalogFetch(levels: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          catalog: catalogWith(),
          effortCapabilities:
            levels.length > 0
              ? [{ provider: "connection:openai", model: "chat-only", levels }]
              : [],
          defaultModel: { provider: "connection:openai", model: "chat-only" },
          defaultModelState: {
            status: "available",
            provider: "connection:openai",
            model: "chat-only",
          },
          health: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSelect(personaMarkdown: string, onPersonaChange = vi.fn()) {
  render(
    <ProviderCatalogProvider>
      <AgentEffortSelect
        personaMarkdown={personaMarkdown}
        onPersonaChange={onPersonaChange}
      />
    </ProviderCatalogProvider>,
  );
  return onPersonaChange;
}

const PERSONA = "---\nname: alpha\nprovider: connection:openai\nmodel: chat-only\n---\n\nBody\n";

describe("AgentEffortSelect", () => {
  it("offers the levels the chosen pair reports, and writes the one picked", async () => {
    stubCatalogFetch(["low", "medium", "high", "xhigh", "max"]);
    const user = userEvent.setup();
    const onPersonaChange = renderSelect(PERSONA);

    const trigger = await screen.findByLabelText("Agent effort");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /^xhigh/ }));

    expect(onPersonaChange).toHaveBeenCalledWith(
      expect.stringContaining("thinking: xhigh"),
    );
  });

  it("shows an agent that names no level as following the application default", async () => {
    stubCatalogFetch(["low", "medium", "high"]);
    renderSelect(PERSONA);

    const trigger = await screen.findByLabelText("Agent effort");
    await waitFor(() => expect(trigger).toHaveTextContent(/Application default/i));
  });

  it("stores the application default as an absence, never as a copy of it", async () => {
    stubCatalogFetch(["low", "medium", "high"]);
    const user = userEvent.setup();
    const onPersonaChange = renderSelect(
      "---\nname: alpha\nprovider: connection:openai\nmodel: chat-only\nthinking: high\n---\n\nBody\n",
    );

    await user.click(await screen.findByLabelText("Agent effort"));
    await user.click(
      await screen.findByRole("option", { name: /Application default/i }),
    );

    expect(onPersonaChange).toHaveBeenCalledTimes(1);
    expect(onPersonaChange.mock.calls[0]![0]).not.toMatch(/^thinking:/m);
  });

  it("offers the provider's own default as a choice of its own", async () => {
    stubCatalogFetch(["low", "medium", "high"]);
    const user = userEvent.setup();
    const onPersonaChange = renderSelect(PERSONA);

    await user.click(await screen.findByLabelText("Agent effort"));
    await user.click(
      await screen.findByRole("option", { name: /Provider default/i }),
    );

    expect(onPersonaChange).toHaveBeenCalledWith(
      expect.stringContaining("thinking: provider-default"),
    );
  });

  it("offers no levels for a pair whose range nobody has established", async () => {
    // Offering three levels here would be inviting a choice nothing supports.
    // The two defaults are still real answers, so the control stays usable.
    stubCatalogFetch([]);
    const user = userEvent.setup();
    renderSelect(PERSONA);

    await user.click(await screen.findByLabelText("Agent effort"));
    expect(await screen.findByRole("option", { name: /Application default/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^medium/ })).toBeNull();
  });

  it("still shows a stored level the pair no longer reports", async () => {
    // Hiding it would show the agent as running at the application default
    // while its file says otherwise, which is the disagreement this control
    // exists to make visible.
    stubCatalogFetch(["low", "medium", "high"]);
    renderSelect(
      "---\nname: alpha\nprovider: connection:openai\nmodel: chat-only\nthinking: ultra\n---\n\nBody\n",
    );

    const trigger = await screen.findByLabelText("Agent effort");
    await waitFor(() => expect(trigger).toHaveTextContent("ultra"));
  });
});

describe("AgentEffortSelect against the real catalogue payload", () => {
  function stubSnapshot(
    effortCapabilities: Array<{ provider: string; model: string; levels: string[] }>,
  ): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            // The Claude Code CLI group as the catalogue really carries it:
            // aliases with no effort metadata of their own.
            catalog: [
              {
                provider: "claude",
                name: "Claude Code",
                icon: "claude",
                source: "cli" as const,
                models: [
                  {
                    id: "opus",
                    name: "Claude Opus 4.8 (1M context)",
                    enabled: true,
                    capabilities: ["chat" as const],
                  },
                ],
              },
            ],
            effortCapabilities,
            defaultModel: null,
            defaultModelState: { status: "unset" },
            health: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  }

  it("offers a Claude Code alias the levels the snapshot reports for it", async () => {
    stubSnapshot([
      { provider: "claude", model: "opus", levels: ["low", "medium", "high", "xhigh", "max"] },
    ]);
    const user = userEvent.setup();
    renderSelect(
      "---\nname: alpha\nprovider: claude\nmodel: opus\nthinking: medium\n---\n\nBody\n",
    );

    await user.click(await screen.findByLabelText("Agent effort"));
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(
        await screen.findByRole("option", { name: new RegExp(`^${level}$`) }),
      ).toBeTruthy();
    }
  });

  it("offers a native API model its levels although it has no catalogue group", async () => {
    // `openai` is neither a local CLI nor a configured connection, so nothing
    // in `catalog` describes it. The capability list is the only place this
    // pair can come from.
    stubSnapshot([
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        levels: ["off", "low", "medium", "high", "xhigh", "max"],
      },
    ]);
    const user = userEvent.setup();
    renderSelect(
      "---\nname: alpha\nprovider: openai\nmodel: gpt-5.6-sol\nthinking: medium\n---\n\nBody\n",
    );

    await user.click(await screen.findByLabelText("Agent effort"));
    expect(await screen.findByRole("option", { name: /^xhigh$/ })).toBeTruthy();
    expect(await screen.findByRole("option", { name: /^off$/ })).toBeTruthy();
  });

  it("still offers only the two defaults for a pair the snapshot does not describe", async () => {
    stubSnapshot([]);
    const user = userEvent.setup();
    renderSelect(
      "---\nname: alpha\nprovider: claude\nmodel: haiku\nthinking: medium\n---\n\nBody\n",
    );

    await user.click(await screen.findByLabelText("Agent effort"));
    expect(await screen.findByRole("option", { name: /Application default/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^xhigh$/ })).toBeNull();
  });
});
