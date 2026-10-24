import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ProviderCatalogGroup } from "@/lib/clients/provider-settings-client";
import {
  ProviderModelIcon,
  resolveProviderIconSlug,
} from "../provider-model-icon";

describe("ProviderModelIcon", () => {
  it("shows the exact runtime model on hover", async () => {
    const user = userEvent.setup();
    render(
      <ProviderModelIcon
        model="gpt-5.6-terra"
        provider="codex"
      />,
    );

    const icon = screen.getByLabelText("Model: gpt-5.6-terra");
    await user.hover(icon);

    expect(await screen.findByText("gpt-5.6-terra")).toBeInTheDocument();
  });

  it("states when runtime model metadata is unavailable", async () => {
    const user = userEvent.setup();
    render(<ProviderModelIcon provider="openai" />);

    const icon = screen.getByLabelText("Model unavailable");
    await user.hover(icon);

    expect(await screen.findByText("Model unavailable")).toBeInTheDocument();
  });
});

describe("resolveProviderIconSlug", () => {
  const groups: ProviderCatalogGroup[] = [
    {
      provider: "connection:xai-1",
      name: "xAI: Grok",
      icon: "x-ai",
      source: "connection",
      models: [
        { id: "grok-4.5", name: "Grok 4.5", enabled: true, icon: "x-ai" },
      ],
    },
  ];

  it("resolves configured connections to the connection brand icon", () => {
    expect(
      resolveProviderIconSlug("connection:xai-1", "x-ai/grok-4.5", groups),
    ).toBe("x-ai");
  });

  it("prefers the model entry icon when the model matches", () => {
    expect(resolveProviderIconSlug("connection:xai-1", "grok-4.5", groups)).toBe(
      "x-ai",
    );
  });

  it("keeps plain providers unchanged", () => {
    expect(resolveProviderIconSlug("codex", "gpt-5.4", groups)).toBe("codex");
  });
});
