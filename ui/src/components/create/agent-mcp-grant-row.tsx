import { Globe2, Loader2, Terminal } from "lucide-react";
import { useId } from "react";

import { PanelItem } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { type AgentMcpGrantServer } from "@/lib/clients/mcp-agent-grants-client";

export function AgentMcpGrantRow({
  agentName,
  server,
  busy,
  onChange,
}: {
  agentName: string;
  server: AgentMcpGrantServer;
  busy: boolean;
  onChange: (server: AgentMcpGrantServer, granted: boolean) => void;
}) {
  const reasonId = useId();
  const disabledReason = grantDisabledReason(server);

  return (
    <PanelItem data-agent-mcp-grant={server.id}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          {server.transport === "stdio"
            ? <Terminal className="size-3.5" />
            : <Globe2 className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{server.name}</span>
            <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-xs text-muted-foreground">
              {formatStatus(server.status)}
            </span>
            {server.providerSupportMode === "host-tool-bridge" ? (
              <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-300">
                CLI bridge
              </span>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {formatTransport(server.transport)}
          </p>
          {disabledReason ? (
            <p id={reasonId} className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
              {disabledReason}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          <Switch
            checked={server.granted}
            disabled={busy || (!server.granted && disabledReason !== null)}
            aria-label={`Grant ${server.name} to ${agentName}`}
            aria-describedby={disabledReason ? reasonId : undefined}
            onCheckedChange={(granted) => onChange(server, granted)}
          />
        </div>
      </div>
    </PanelItem>
  );
}

function grantDisabledReason(server: AgentMcpGrantServer): string | null {
  const reasons: string[] = [];
  if (!server.enabled) {
    reasons.push("This MCP connection is globally disabled.");
  }
  if (server.status !== "connected") {
    reasons.push(
      `Connection is ${formatStatus(server.status).toLowerCase()}. Connect it in Settings before granting access.`,
    );
  }
  if (!server.compatible) {
    reasons.push(
      server.reason?.trim() || "This agent provider does not support MCP tools.",
    );
  }
  return reasons.length > 0 ? reasons.join(" ") : null;
}

function formatTransport(transport: AgentMcpGrantServer["transport"]): string {
  return transport === "stdio" ? "stdio" : "Streamable HTTP";
}

function formatStatus(status: AgentMcpGrantServer["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("-", " ");
}
