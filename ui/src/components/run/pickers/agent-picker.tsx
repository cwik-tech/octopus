import { CircleAlert } from "lucide-react";
import { startTransition, useEffect, useMemo, useState } from "react";

import { AgentItem } from "@/components/sidebar/agent-item";
import { AgentChatModePicker, type AgentChatMode } from "@/components/run/pickers/agent-chat-mode-picker";
import { SidebarEmptyLabel } from "@/components/sidebar/sidebar-empty-label";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentProviderHealth } from "@/hooks/use-agent-provider-health";
import { listAgents } from "@/lib/clients/agent-generator-client";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import { formatDisplayName } from "@/lib/utils/display-name";

interface AgentPickerProps {
  query: string;
  selectedNames: string[];
  onSelectedNamesChange: (names: string[]) => void;
  chatMode?: AgentChatMode;
  chatModeLocked?: boolean;
  onChatModeChange?: (mode: AgentChatMode) => void;
}

function AgentPicker({
  query,
  selectedNames,
  onSelectedNamesChange,
  chatMode = "discussion",
  chatModeLocked = false,
  onChatModeChange,
}: AgentPickerProps) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    startTransition(() => {
      setLoading(true);
      setError(null);
    });
    void listAgents()
      .then((next) => {
        if (cancelled) return;
        startTransition(() => {
          setAgents(next);
          setLoading(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        startTransition(() => {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agentNames = useMemo(
    () => agents.map((agent) => agent.name),
    [agents],
  );
  const { byAgentName: healthByAgentName, loading: healthLoading } =
    useAgentProviderHealth(agentNames);

  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(needle) ||
        agent.description?.toLowerCase().includes(needle) ||
        agent.skills.some((skill) => skill.toLowerCase().includes(needle)),
    );
  }, [agents, query]);

  const agentsByName = useMemo(
    () => new Map(agents.map((agent) => [agent.name, agent])),
    [agents],
  );

  /**
   * A picked agent moves up into its own space, so the list below always
   * answers one question: what is still available to add?
   */
  const availableAgents = useMemo(
    () => filteredAgents.filter((agent) => !selectedNames.includes(agent.name)),
    [filteredAgents, selectedNames],
  );

  const removeAgent = (name: string) => {
    onSelectedNamesChange(selectedNames.filter((item) => item !== name));
  };

  const toggleAgent = (name: string) => {
    if (selectedNames.includes(name)) {
      removeAgent(name);
      return;
    }
    onSelectedNamesChange([...selectedNames, name]);
  };

  const renderRow = (name: string, selected: boolean) => {
    // A selection can outlive the agent it names; the row still has to be
    // removable, so an unknown name falls back to its formatted label.
    const agent = agentsByName.get(name);
    const health = healthByAgentName[name];
    return (
      <AgentItem
        label={formatDisplayName(name)}
        provider={agent?.provider}
        model={agent?.model}
        descriptionTooltip={agent?.description || "No description."}
        health={health}
        statusLoading={healthLoading && !health}
        selectable
        selected={selected}
        quietSelection={selected}
        onSelect={() => toggleAgent(name)}
        onRemove={selected ? () => removeAgent(name) : undefined}
      />
    );
  };

  if (loading) {
    return (
      <div className="space-y-2 px-2">
        <Skeleton className="h-8 w-full rounded-lg" />
        <Skeleton className="h-8 w-full rounded-lg" />
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectedNames.length === 0 ? null : (
        // Pinned above the roster: scrolling for another agent must not carry
        // the current selection out of view. It scrolls within itself once a
        // long selection would crowd out the roster below.
        <section className="desktop-sidebar-scroll mx-2 mb-2 max-h-[40%] shrink-0 overflow-y-auto rounded-lg border border-sidebar-border/60 py-1">
          <SidebarSectionHeader
            title={`Selected Agents (${selectedNames.length})`}
          />
          <ul aria-label="Selected agents" className="space-y-1">
            {selectedNames.map((name) => (
              <li key={name}>{renderRow(name, true)}</li>
            ))}
          </ul>
        </section>
      )}
      {onChatModeChange ? (
        <AgentChatModePicker
          selectedCount={selectedNames.length}
          mode={chatMode}
          locked={chatModeLocked}
          onModeChange={onChatModeChange}
        />
      ) : null}
      <div
        className="desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        data-slot="available-agents-scroll"
      >
        {availableAgents.length === 0 ? (
          <SidebarEmptyLabel>No agents found.</SidebarEmptyLabel>
        ) : (
          <ul aria-label="Available agents" className="space-y-1">
            {availableAgents.map((agent) => (
              <li key={agent.name}>{renderRow(agent.name, false)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default AgentPicker;
