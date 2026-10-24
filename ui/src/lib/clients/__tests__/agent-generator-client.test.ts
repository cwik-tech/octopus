import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveAgentPersona } from "@/lib/clients/agent-generator-client";
import { subscribeToAgentProviderHealth } from "@/lib/clients/agent-provider-health-signal";

/**
 * Saving a persona can point an agent at a different account.
 *
 * Provider and model live in the persona frontmatter, so a save is exactly the
 * moment an agent's health answer stops being about the thing it was measured
 * on. The sidebar next door stays mounted through that edit and would otherwise
 * keep showing the previous provider's problem — which is how this was found:
 * an agent moved off OpenAI onto the Codex CLI and its row went on saying
 * OPENAI_API_KEY was missing.
 */

const originalFetch = globalThis.fetch;

describe("saveAgentPersona", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ personaPath: "agents/a/a.md" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("tells health readers their answer may now be about the wrong provider", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToAgentProviderHealth(listener);

    try {
      await saveAgentPersona({
        agentName: "crypto-market-analyst",
        personaMarkdown: "---\nprovider: codex\nmodel: gpt-5.5\n---\n",
      });

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("stops telling a reader that has gone away", async () => {
    const listener = vi.fn();
    subscribeToAgentProviderHealth(listener)();

    await saveAgentPersona({
      agentName: "crypto-market-analyst",
      personaMarkdown: "---\nprovider: codex\n---\n",
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
