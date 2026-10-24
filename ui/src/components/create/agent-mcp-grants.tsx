import { useEffect, useState } from "react";

import { AgentMcpGrantRow } from "@/components/create/agent-mcp-grant-row";
import { PanelEmptyState } from "@/components/ui/card";
import {
  fetchAgentMcpGrants,
  updateAgentMcpGrant,
  type AgentMcpGrantServer,
} from "@/lib/clients/mcp-agent-grants-client";

interface LoadedGrants {
  agentName: string;
  servers: AgentMcpGrantServer[];
}

interface AgentMessage {
  agentName: string;
  text: string;
}

interface BusyGrant {
  agentName: string;
  serverId: string;
}

export function AgentMcpGrants({ agentName }: { agentName: string | null }) {
  const [loaded, setLoaded] = useState<LoadedGrants | null>(null);
  const [busyGrant, setBusyGrant] = useState<BusyGrant | null>(null);
  const [error, setError] = useState<AgentMessage | null>(null);
  const [notice, setNotice] = useState<AgentMessage | null>(null);

  useEffect(() => {
    if (!agentName) return;
    let active = true;
    void fetchAgentMcpGrants(agentName)
      .then((servers) => {
        if (!active) return;
        setLoaded({ agentName, servers });
        setError(null);
      })
      .catch((loadError) => {
        if (!active) return;
        setError({ agentName, text: errorMessage(loadError) });
      });
    return () => {
      active = false;
    };
  }, [agentName]);

  async function handleGrantChange(
    server: AgentMcpGrantServer,
    granted: boolean,
  ): Promise<void> {
    if (!agentName) return;
    const targetAgentName = agentName;
    setBusyGrant({ agentName: targetAgentName, serverId: server.id });
    setError(null);
    setNotice(null);
    try {
      const updated = await updateAgentMcpGrant(
        targetAgentName,
        server.id,
        granted,
      );
      setLoaded((current) => {
        if (!current || current.agentName !== targetAgentName) return current;
        return {
          ...current,
          servers: current.servers.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        };
      });
      setNotice({
        agentName: targetAgentName,
        text: `${updated.name} access ${updated.granted ? "enabled" : "disabled"}.`,
      });
    } catch (grantError) {
      setError({ agentName: targetAgentName, text: errorMessage(grantError) });
    } finally {
      setBusyGrant((current) =>
        current?.agentName === targetAgentName && current.serverId === server.id
          ? null
          : current,
      );
    }
  }

  if (!agentName) {
    return (
      <PanelEmptyState className="text-xs text-muted-foreground">
        Select an agent to manage MCP access.
      </PanelEmptyState>
    );
  }

  const servers = loaded?.agentName === agentName ? loaded.servers : null;
  const visibleError = error?.agentName === agentName ? error.text : null;
  const visibleNotice = notice?.agentName === agentName ? notice.text : null;

  return (
    <section aria-labelledby="agent-mcp-grants-heading" className="space-y-3">
      <div>
        <h3 id="agent-mcp-grants-heading" className="text-sm font-semibold">
          MCP access
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Grant this agent access to connected global MCPs. New grants are off by default and are
          stored separately from persona and package files.
        </p>
      </div>

      {visibleError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          {visibleError}
        </div>
      ) : null}
      {visibleNotice ? (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/8 px-3 py-2 text-xs text-emerald-700"
        >
          {visibleNotice}
        </div>
      ) : null}

      {!servers ? (
        <p className="text-xs text-muted-foreground">Loading MCP access…</p>
      ) : servers.length === 0 ? (
        <PanelEmptyState className="text-xs text-muted-foreground">
          No globally enabled MCP connections are available.
        </PanelEmptyState>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <AgentMcpGrantRow
              key={server.id}
              agentName={agentName}
              server={server}
              busy={
                busyGrant?.agentName === agentName && busyGrant.serverId === server.id
              }
              onChange={(candidate, granted) => {
                void handleGrantChange(candidate, granted);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
