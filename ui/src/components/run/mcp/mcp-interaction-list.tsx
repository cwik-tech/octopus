import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { McpInteractionCard } from "@/components/run/mcp/mcp-interaction-card";
import { Button } from "@/components/ui/button";
import {
  mcpInteractionsClient,
  type McpInteraction,
  type McpInteractionResponse,
  type McpInteractionsClient,
} from "@/lib/clients/mcp-interactions-client";

const DEFAULT_POLL_INTERVAL_MS = 1_500;

interface McpInteractionListProps {
  sessionId: string;
  client?: McpInteractionsClient;
  pollIntervalMs?: number;
}

export function McpInteractionList({
  sessionId,
  client = mcpInteractionsClient,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: McpInteractionListProps) {
  const [state, setState] = useState<InteractionListState>(() => ({
    sessionId: null,
    interactions: [],
    loading: true,
    error: null,
    truncated: false,
  }));
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();
      try {
        const result = await client.list(sessionId, controller.signal);
        if (disposed || controller.signal.aborted) return;
        setState({
          sessionId,
          interactions: result.interactions,
          loading: false,
          error: null,
          truncated: result.truncated,
        });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setState((current) => current.sessionId === sessionId
          ? { ...current, loading: false, error: errorMessage(error) }
          : {
              sessionId,
              interactions: [],
              loading: false,
              error: errorMessage(error),
              truncated: false,
            });
      } finally {
        if (!disposed) {
          timer = window.setTimeout(() => void poll(), pollIntervalMs);
        }
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [client, pollIntervalMs, reloadToken, sessionId]);

  const respond = async (
    interaction: McpInteraction,
    response: McpInteractionResponse,
  ): Promise<McpInteraction> => {
    const resolved = await client.respond(
      sessionId,
      interaction.interactionId,
      response,
    );
    setState((current) => current.sessionId === sessionId
      ? {
          ...current,
          interactions: current.interactions.map((entry) =>
            entry.interactionId === resolved.interactionId ? resolved : entry),
        }
      : current);
    return resolved;
  };

  const current = state.sessionId === sessionId
    ? state
    : {
        sessionId,
        interactions: [],
        loading: true,
        error: null,
        truncated: false,
      };
  const retry = () => {
    setState((previous) => previous.sessionId === sessionId
      ? { ...previous, loading: true, error: null }
      : previous);
    setReloadToken((token) => token + 1);
  };

  if (current.loading && current.interactions.length === 0 && !current.error) {
    return null;
  }

  if (current.error && current.interactions.length === 0) {
    return (
      <div className="mx-4 my-2 flex max-w-2xl items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <CircleAlert className="size-4 shrink-0 text-destructive" />
        <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
          {current.error}
        </p>
        <Button
          size="xs"
          variant="outline"
          onClick={retry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (current.interactions.length === 0) return null;

  return (
    <section aria-label="Pending MCP requests" className="space-y-3 px-4 py-2">
      {current.error ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <CircleAlert className="size-3.5" />
          <span role="alert">{current.error} Showing the last available requests.</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={retry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {current.truncated ? (
        <p role="status" className="text-xs text-muted-foreground">
          More MCP requests are waiting. Resolve these to load the rest.
        </p>
      ) : null}
      {current.interactions.map((interaction) => (
        <McpInteractionCard
          key={interaction.interactionId}
          interaction={interaction}
          onRespond={(response) => respond(interaction, response)}
        />
      ))}
    </section>
  );
}

interface InteractionListState {
  sessionId: string | null;
  interactions: McpInteraction[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "MCP requests could not be loaded.";
}
