import { startTransition, useEffect, useState } from "react";

import { checkAgentProviderHealth } from "@/lib/clients/agent-generator-client";
import type { AgentProviderHealth } from "@/lib/models/agent-generator-model";

export function useAgentModelHealth(options: {
  agentName: string | null;
  provider: string;
  model: string;
}) {
  const { agentName, provider, model } = options;
  const [health, setHealth] = useState<AgentProviderHealth | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!agentName || !provider || !model) {
      startTransition(() => {
        setHealth(undefined);
        setLoading(false);
      });
      return;
    }

    let cancelled = false;
    startTransition(() => {
      setHealth(undefined);
      setLoading(true);
    });
    void checkAgentProviderHealth({
      targets: [{ agentName, provider, model }],
    })
      .then((nextHealth) => {
        if (!cancelled) setHealth(nextHealth[0]);
      })
      .catch((error) => {
        if (cancelled) return;
        setHealth({
          agentName,
          provider,
          model,
          status: "unknown",
          message: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentName, model, provider]);

  return { health, loading };
}
