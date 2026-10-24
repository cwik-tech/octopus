import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clients/agent-generator-client", () => ({
  checkAgentProviderHealth: vi.fn(),
}));

// The signal module is real: its whole job is to carry this event, and a fake
// of it would prove only that the fake works.
import { checkAgentProviderHealth } from "@/lib/clients/agent-generator-client";
import { invalidateAgentProviderHealth } from "@/lib/clients/agent-provider-health-signal";
import { useAgentProviderHealth } from "@/hooks/use-agent-provider-health";
import type { AgentProviderHealth } from "@/lib/models/agent-generator-model";

/**
 * A badge that answered once and never asked again.
 *
 * Both sidebars stay mounted while the thing they describe changes underneath
 * them: an agent's provider is edited in the tab next door, and a run discovers
 * mid-chat that the account it shares has no tokens left. Neither changes the
 * list of agent names, so a fetch keyed only on those names went on showing the
 * previous answer until the user navigated away and back.
 */

function health(overrides: Partial<AgentProviderHealth> = {}): AgentProviderHealth {
  return {
    agentName: "crypto-market-analyst",
    provider: "codex",
    model: "gpt-5.5",
    status: "ok",
    message: "Codex CLI and model 'gpt-5.5' are enabled.",
    checkedAt: "2026-09-12T02:00:00.000Z",
    diagnostics: [],
    ...overrides,
  };
}

function Harness({ names }: { names: string[] }) {
  const { byAgentName } = useAgentProviderHealth(names);
  const checked = byAgentName["crypto-market-analyst"];
  return <span data-testid="status">{checked?.status ?? "none"}</span>;
}

describe("useAgentProviderHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks again when something says the answer may have changed", async () => {
    vi.mocked(checkAgentProviderHealth)
      .mockResolvedValueOnce([health()])
      .mockResolvedValueOnce([
        health({
          status: "error",
          message:
            "Agent 'crypto-market-analyst' (codex): You've hit your provider usage limit.",
        }),
      ]);

    render(<Harness names={["crypto-market-analyst"]} />);

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("ok");
    });

    invalidateAgentProviderHealth();

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("error");
    });
    expect(vi.mocked(checkAgentProviderHealth)).toHaveBeenCalledTimes(2);
  });

  it("stops asking once the surface that wanted the answer is gone", async () => {
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([health()]);

    const { unmount } = render(<Harness names={["crypto-market-analyst"]} />);
    await waitFor(() => {
      expect(vi.mocked(checkAgentProviderHealth)).toHaveBeenCalledTimes(1);
    });

    unmount();
    invalidateAgentProviderHealth();

    expect(vi.mocked(checkAgentProviderHealth)).toHaveBeenCalledTimes(1);
  });

  it("asks once for one list of agents, however often it re-renders", async () => {
    vi.mocked(checkAgentProviderHealth).mockResolvedValue([health()]);

    const { rerender } = render(<Harness names={["crypto-market-analyst"]} />);
    await waitFor(() => {
      expect(vi.mocked(checkAgentProviderHealth)).toHaveBeenCalledTimes(1);
    });

    // A fresh array with the same names every render is what a caller building
    // items with `.map()` actually hands over.
    rerender(<Harness names={["crypto-market-analyst"]} />);
    rerender(<Harness names={["crypto-market-analyst"]} />);

    expect(vi.mocked(checkAgentProviderHealth)).toHaveBeenCalledTimes(1);
  });
});
