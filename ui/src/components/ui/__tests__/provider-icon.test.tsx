import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderIcon } from "../provider-icon";

describe("ProviderIcon", () => {
  it.each([
    ["codex", "openai"],
    ["claude", "claudecode"],
    ["gemini", "geminicli"],
    ["kimi-cli", "moonshot"],
    ["qwen", "qwen"],
    ["pi", "pi"],
    ["openrouter", "openrouter"],
    ["ollama", "ollama"],
    ["lm-studio", "lmstudio"],
  ])("renders the real %s brand asset", (provider, logo) => {
    const { container } = render(<ProviderIcon provider={provider} />);

    expect(
      container.querySelector(`[data-provider-logo="${logo}"] img`),
    ).toBeInTheDocument();
  });

  it.each([
    ["openai", "openai"],
    ["anthropic", "anthropic"],
    ["google", "google"],
    ["deepseek", "deepseek"],
    ["x-ai", "xai"],
    ["moonshotai", "moonshot"],
    ["meta-llama", "meta"],
    ["mistralai", "mistral"],
    ["z-ai", "zhipu"],
  ])("maps model provider %s to its brand asset", (provider, logo) => {
    const { container } = render(<ProviderIcon provider={provider} />);

    expect(
      container.querySelector(`[data-provider-logo="${logo}"] img`),
    ).toBeInTheDocument();
  });

  it("uses a neutral glyph for an unknown compatible endpoint", () => {
    const { container } = render(
      <ProviderIcon provider="openai-compatible" />,
    );

    expect(
      container.querySelector('[data-provider-logo="fallback"] svg'),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });
});
