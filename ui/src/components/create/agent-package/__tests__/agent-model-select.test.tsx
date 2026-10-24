import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentModelSelect } from "../agent-model-select";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";

const catalog = [
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSelect(personaMarkdown: string, onPersonaChange = vi.fn()) {
  return render(
    <ProviderCatalogProvider>
      <AgentModelSelect
        agentName="alpha"
        personaMarkdown={personaMarkdown}
        onPersonaChange={onPersonaChange}
      />
    </ProviderCatalogProvider>,
  );
}

describe("AgentModelSelect", () => {
  it("lets the user choose a model even when no application default is set", async () => {
    // An inheriting agent with no default to inherit must still be able to
    // pick a model, or it is stuck with nothing to run on.
    stubCatalogFetch(null);
    const user = userEvent.setup();
    const onPersonaChange = vi.fn();
    renderSelect("---\nname: alpha\n---\n\nBody\n", onPersonaChange);

    const trigger = await screen.findByLabelText("Agent model");
    expect(trigger).toHaveTextContent("No app default set");

    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /^Chat only/ }));

    expect(onPersonaChange).toHaveBeenCalledWith(
      expect.stringContaining("provider: connection:openai"),
    );
    expect(onPersonaChange).toHaveBeenCalledWith(
      expect.stringContaining("model: chat-only"),
    );
  });

  it("switches an agent with its own model back to the app default", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const user = userEvent.setup();
    const onPersonaChange = vi.fn();
    renderSelect(
      "---\nname: alpha\nprovider: connection:openai\nmodel: chat-only\n---\n\nBody\n",
      onPersonaChange,
    );

    await user.click(await screen.findByLabelText("Agent model"));
    await user.click(
      await screen.findByRole("option", { name: /^Use app default/ }),
    );

    // Inheritance is stored as the absence of a pair, never a copy of it.
    expect(onPersonaChange).toHaveBeenCalledTimes(1);
    expect(onPersonaChange.mock.calls[0]![0]).not.toMatch(/^provider:/m);
    expect(onPersonaChange.mock.calls[0]![0]).not.toMatch(/^model:/m);
  });

  it("shows the legacy codex placeholder as inheriting the app default", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    renderSelect("---\nname: alpha\nprovider: codex\nmodel: default\n---\n\nBody\n");

    const trigger = await screen.findByLabelText("Agent model");
    await waitFor(() => expect(trigger).toHaveTextContent("Chat only"));
    expect(trigger).toHaveTextContent("Default");
  });

  it("shows a half-configured pair as the model it names, not as inheritance", async () => {
    // `model` with no `provider` is refused by the runtime. Presenting it as
    // the app default would tell the user the agent is fine when it cannot
    // start.
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    renderSelect("---\nname: alpha\nmodel: gpt-5.4-mini\n---\n\nBody\n");

    const trigger = await screen.findByLabelText("Agent model");
    await waitFor(() => expect(trigger).toHaveTextContent("gpt-5.4-mini"));
    expect(trigger).not.toHaveTextContent("Default");
  });
});

function stubCatalogFetch(
  defaultModel: { provider: string; model: string } | null,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({
        catalog,
        defaultModel,
        defaultModelState: defaultModel
          ? { status: "available", ...defaultModel }
          : { status: "unset" },
        health: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
  );
}
