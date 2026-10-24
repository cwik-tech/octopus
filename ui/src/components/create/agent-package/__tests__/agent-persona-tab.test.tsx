import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPersonaTab } from "../agent-persona-tab";
import { Tabs } from "@/components/ui/tabs";
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

function renderTab(
  personaMarkdown: string,
  onPersonaChange = vi.fn(),
  agentName = "alpha",
) {
  return render(
    <ProviderCatalogProvider>
      <Tabs value="persona">
        <AgentPersonaTab
          agentName={agentName}
          personaPath={`agents/${agentName}/${agentName}.md`}
          personaMarkdown={personaMarkdown}
          savedPersonaMarkdown={personaMarkdown}
          onPersonaChange={onPersonaChange}
          dirty={false}
          saving={false}
          saved={null}
          saveError={null}
          onSave={() => undefined}
        />
      </Tabs>
    </ProviderCatalogProvider>,
  );
}

describe("AgentPersonaTab", () => {
  it("leaves the model choice to the editor header", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    renderTab("---\nname: alpha\n---\n\nBody\n");

    expect(await screen.findByText("agents/alpha/alpha.md")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent model source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agent model")).not.toBeInTheDocument();
  });

  it("says a half-configured pair is a problem rather than showing inheritance", async () => {
    // `model` with no `provider` is refused by the runtime. Showing it as
    // inheriting the app default would tell the user the agent is fine when
    // it cannot start.
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    renderTab("---\nname: alpha\nmodel: gpt-5.4-mini\n---\n\nBody\n");

    await waitFor(() =>
      expect(screen.getByText(/names no provider/i)).toBeInTheDocument(),
    );
  });

  it("saves unsaved edits when the person leaves the editor, with no Save button", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const onSave = vi.fn();
    renderDirtyTab({ dirty: true, onSave });

    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    fireEvent.blur(screen.getByLabelText("Persona markdown"));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not save when the person leaves an unchanged editor", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const onSave = vi.fn();
    renderDirtyTab({ dirty: false, onSave });

    fireEvent.blur(screen.getByLabelText("Persona markdown"));

    expect(onSave).not.toHaveBeenCalled();
  });

  it("gives the path the whole row and copies from an icon in the editor", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const { container } = renderDirtyTab({ dirty: true, onSave: vi.fn() });

    // The sidebar's own padding is the only space under the editor.
    expect(container.querySelector('[data-slot="tabs-content"]')).toHaveClass(
      "pb-0",
    );

    expect(screen.getByRole("button", { name: "Copy persona" })).toBeInTheDocument();
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Line changes since last save")).not.toBeInTheDocument();
    expect(screen.queryByText("Unsaved persona edits")).not.toBeInTheDocument();
  });
});

function renderDirtyTab(options: { dirty: boolean; onSave: () => void }) {
  return render(
    <ProviderCatalogProvider>
      <Tabs value="persona">
        <AgentPersonaTab
          agentName="alpha"
          personaPath="agents/alpha/alpha.md"
          personaMarkdown={"---\nname: alpha\n---\n\nBody, edited\n"}
          savedPersonaMarkdown={"---\nname: alpha\n---\n\nBody\n"}
          onPersonaChange={vi.fn()}
          dirty={options.dirty}
          saving={false}
          saved={null}
          saveError={null}
          onSave={options.onSave}
        />
      </Tabs>
    </ProviderCatalogProvider>,
  );
}

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
