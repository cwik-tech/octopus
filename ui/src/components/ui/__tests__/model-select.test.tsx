import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelSelect } from "@/components/ui/model-select";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";

const catalog = [
  {
    provider: "codex",
    name: "Codex CLI",
    icon: "codex",
    source: "cli" as const,
    models: [
      {
        id: "default",
        name: "Default model",
        enabled: true,
        capabilities: ["chat" as const],
      },
    ],
  },
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
      {
        id: "pdf-reader",
        name: "PDF reader",
        enabled: true,
        capabilities: ["chat" as const, "pdf" as const],
      },
    ],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelSelect", () => {
  it("falls back to the persisted global default instead of the first catalog item", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const onChange = vi.fn();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model=""
          provider=""
          onChange={onChange}
          fallbackToFirstAvailable
          aria-label="Test model"
        />
      </ProviderCatalogProvider>,
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        provider: "connection:openai",
        model: "chat-only",
      }),
    );
  });

  it("shows only PDF-capable models in a PDF selector", async () => {
    stubCatalogFetch({ provider: "codex", model: "default" });
    const user = userEvent.setup();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model=""
          provider=""
          onChange={() => undefined}
          capability="pdf"
          aria-label="PDF model"
        />
      </ProviderCatalogProvider>,
    );

    await user.click(await screen.findByLabelText("PDF model"));
    expect(await screen.findByText("PDF reader")).toBeInTheDocument();
    expect(screen.queryByText("Chat only")).not.toBeInTheDocument();
    expect(screen.queryByText("Default model")).not.toBeInTheDocument();
  });

  it("uses the native settings-style scroll container for long model lists", async () => {
    stubCatalogFetch({ provider: "codex", model: "default" });
    const user = userEvent.setup();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model=""
          provider=""
          onChange={() => undefined}
          contentClassName="max-h-80"
          aria-label="Scrollable model"
        />
      </ProviderCatalogProvider>,
    );

    await user.click(await screen.findByLabelText("Scrollable model"));

    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveClass(
      "desktop-shell",
      "flex",
      "flex-col",
      "max-h-80",
    );
    expect(document.querySelector('[data-slot="command"]')).toHaveClass(
      "min-h-0",
      "h-[min(32rem,calc(100dvh-3rem))]",
      "max-h-[inherit]",
    );
    expect(document.querySelector('[data-slot="command-list"]')).toHaveClass(
      "min-h-0",
      "flex-1",
      "max-h-none",
      "overflow-y-auto",
      "pr-1",
    );
  });

  it("never writes a selection into a picker that did not ask for one", async () => {
    // Agent editing stores app-default mode as an empty pair. A picker that
    // filled it in would silently convert deliberate inheritance into an
    // explicit choice the user never made.
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const onChange = vi.fn();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model=""
          provider=""
          onChange={onChange}
          aria-label="Inheriting model"
        />
      </ProviderCatalogProvider>,
    );

    await screen.findByLabelText("Inheriting model");
    await waitFor(() =>
      expect(screen.getByLabelText("Inheriting model")).toHaveTextContent(
        "Select model",
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("writes nothing when there is no application default, whatever the catalog holds", async () => {
    // Catalog order is never a fallback. A picker that reached for the first
    // entry would invent an application default nobody selected, which is the
    // exact hierarchy this work removes.
    stubCatalogFetch(null);
    const onChange = vi.fn();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model=""
          provider=""
          onChange={onChange}
          fallbackToFirstAvailable
          aria-label="No default model"
        />
      </ProviderCatalogProvider>,
    );

    await screen.findByLabelText("No default model");
    await waitFor(() =>
      expect(screen.getByLabelText("No default model")).toHaveTextContent(
        "Select model",
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an explicit pair the catalog no longer lists instead of replacing it", async () => {
    // A configured selection that is currently unavailable stays named, so the
    // user is told which selection is broken rather than being moved silently
    // onto a different model.
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const onChange = vi.fn();
    const loaded = vi.fn();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model="retired-model"
          provider="connection:openai"
          onChange={onChange}
          fallbackToFirstAvailable
          aria-label="Retired model"
        />
        {/* An empty picker beside it. Its write is what proves the catalog
            finished loading, so the assertion below cannot pass merely by
            running before the fetch resolved. */}
        <ModelSelect
          model=""
          provider=""
          onChange={loaded}
          fallbackToFirstAvailable
          aria-label="Empty model"
        />
      </ProviderCatalogProvider>,
    );

    await waitFor(() =>
      expect(loaded).toHaveBeenCalledWith({
        provider: "connection:openai",
        model: "chat-only",
      }),
    );
    expect(screen.getByLabelText("Retired model")).toHaveTextContent(
      "retired-model",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows an explicit current model status when provided", async () => {
    stubCatalogFetch({ provider: "codex", model: "default" });

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model="default"
          provider="codex"
          onChange={() => undefined}
          currentStatus={<span>Available</span>}
          aria-label="Status model"
        />
      </ProviderCatalogProvider>,
    );

    expect(await screen.findByLabelText("Status model")).toHaveTextContent(
      "Available",
    );
  });

  it("lists the app default first when the caller offers it", async () => {
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSelectDefault = vi.fn();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model="pdf-reader"
          provider="connection:openai"
          onChange={onChange}
          appDefaultOption={{ selected: false, onSelect: onSelectDefault }}
          aria-label="Agent model"
        />
      </ProviderCatalogProvider>,
    );

    await user.click(await screen.findByLabelText("Agent model"));
    await screen.findByRole("option", { name: /^PDF reader/ });
    const [first] = screen.getAllByRole("option");
    expect(first).toHaveTextContent("Use app default");

    await user.click(first!);

    expect(onSelectDefault).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks inheritance, not the default's own entry, while inheriting", async () => {
    // The caller passes the default's pair so the trigger names what will run.
    // Ticking that model too would present inheritance as an explicit choice.
    stubCatalogFetch({ provider: "connection:openai", model: "chat-only" });
    const user = userEvent.setup();

    render(
      <ProviderCatalogProvider>
        <ModelSelect
          model="chat-only"
          provider="connection:openai"
          onChange={() => undefined}
          appDefaultOption={{ selected: true, onSelect: () => undefined }}
          aria-label="Agent model"
        />
      </ProviderCatalogProvider>,
    );

    const trigger = await screen.findByLabelText("Agent model");
    await waitFor(() => expect(trigger).toHaveTextContent("Chat only"));
    expect(trigger).toHaveTextContent("Default");

    await user.click(trigger);
    expect(
      await screen.findByRole("option", { name: /^Chat only/ }),
    ).toHaveAttribute("data-checked", "false");
    expect(
      screen.getByRole("option", { name: /^Use app default/ }),
    ).toHaveAttribute("data-checked", "true");
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
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
  );
}
