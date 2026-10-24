import { useState, type ReactNode } from "react";

import AgentPicker from "@/components/run/pickers/agent-picker";
import type { AgentChatMode } from "@/components/run/pickers/agent-chat-mode-picker";
import { TeamPicker } from "@/components/run/pickers/team-picker";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/utils";
import { workflowsEnabled } from "@/lib/utils/workflows-enabled";
import { useRunSidebar } from "@/hooks/use-run-sidebar";

export type RunTarget = "agents" | "teams" | "workflows";
type ChatTargetTab = Exclude<RunTarget, "workflows">;

const RUN_TARGET_TABS: { value: RunTarget; label: string }[] = [
  { value: "agents", label: "Agents" },
  { value: "teams", label: "Teams" },
  { value: "workflows", label: "Workflows" },
];

interface RunTargetSidebarProps {
  onSelectedAgentNamesChange: (names: string[]) => void;
  onSelectedTeamIdChange?: (teamId: string | null) => void;
  onTargetChange: (target: RunTarget) => void;
  selectedAgentNames: string[];
  selectedTeamId?: string | null;
  agentChatMode?: AgentChatMode;
  agentChatModeLocked?: boolean;
  onAgentChatModeChange?: (mode: AgentChatMode) => void;
  /** Task lifecycle pane, owned by RunPanel so this file stays picker-only. */
  workflowPane: ReactNode;
  target: RunTarget;
}

/**
 * RunPanel owns chat selection and the workflow lifecycle pane. In the shell,
 * left navigation supplies the visible list and shared search; standalone
 * consumers retain their local target tabs and searches.
 */
export function RunTargetSidebar({
  onSelectedAgentNamesChange,
  onSelectedTeamIdChange,
  onTargetChange,
  selectedAgentNames,
  selectedTeamId = null,
  agentChatMode = "discussion",
  agentChatModeLocked = false,
  onAgentChatModeChange,
  workflowPane,
  target: standaloneTarget,
}: RunTargetSidebarProps) {
  const navigation = useRunSidebar();
  const target = navigation?.tab ?? standaloneTarget;
  const [teamPickerLoaded, setTeamPickerLoaded] = useState(
    target === "teams" || selectedTeamId !== null,
  );
  if (target === "teams" && !teamPickerLoaded) setTeamPickerLoaded(true);
  const [queries, setQueries] = useState<Record<ChatTargetTab, string>>({
    agents: "",
    teams: "",
  });
  const chatTab: ChatTargetTab = target === "teams" ? "teams" : "agents";
  const setQuery = (next: string) => {
    setQueries((current) => ({ ...current, [chatTab]: next }));
  };

  const selectTarget = (next: RunTarget) => {
    if (next === target) return;
    if (next === "teams") setTeamPickerLoaded(true);
    onTargetChange(next);
  };
  const showWorkflows = workflowsEnabled();
  const targetTabs = showWorkflows
    ? RUN_TARGET_TABS
    : RUN_TARGET_TABS.filter((targetTab) => targetTab.value !== "workflows");

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden">
      {navigation ? null : <div
        className={cn(
          "mx-2 mt-3 mb-2 grid shrink-0 rounded-lg bg-sidebar-accent/50 p-0.5",
          showWorkflows ? "grid-cols-3" : "grid-cols-2",
        )}
        role="tablist"
        aria-label="Run target type"
      >
        {targetTabs.map((targetTab) => (
          <Button
            key={targetTab.value}
            variant="ghost"
            size="xs"
            role="tab"
            aria-selected={target === targetTab.value}
            className="px-2 py-1 aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm"
            onClick={() => selectTarget(targetTab.value)}
          >
            {targetTab.label}
          </Button>
        ))}
      </div>}
      {target === "workflows" ? null : (
        <section className="flex min-h-0 flex-1 flex-col">
          {/* The left sidebar insets its header and list by the same gutter;
              the two panels have to read as one frame around the chat. */}
          {navigation ? null : <div className="px-2">
            <SidebarSectionHeader
              onSearch={setQuery}
              searchLabel={target === "teams" ? "Teams" : "Agents"}
              searchPlaceholder={
                target === "teams" ? "Search teams..." : "Search agents..."
              }
            />
          </div>}
          {/* Each picker owns its own scrolling, so a picker can pin part of
              itself (the agent selection) above rows that scroll. */}
          {teamPickerLoaded ? (
            <div
              hidden={target !== "teams"}
              className={
                target === "teams"
                  ? "desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3"
                  : undefined
              }
            >
              <TeamPicker
                query={navigation?.query ?? queries.teams}
                selectedTeamId={selectedTeamId}
                onSelectedTeamIdChange={onSelectedTeamIdChange ?? (() => {})}
              />
            </div>
          ) : null}
          {target === "agents" ? (
            <AgentPicker
              query={navigation?.query ?? queries.agents}
              selectedNames={selectedAgentNames}
              onSelectedNamesChange={onSelectedAgentNamesChange}
              chatMode={agentChatMode}
              chatModeLocked={agentChatModeLocked}
              {...(onAgentChatModeChange ? { onChatModeChange: onAgentChatModeChange } : {})}
            />
          ) : null}
        </section>
      )}
      {/* Kept mounted across tabs: the pane's run subscriptions must not churn
          every time the user peeks at the agent or team roster. */}
      <div
        hidden={target !== "workflows"}
        className={
          target === "workflows" ? "flex min-h-0 flex-1 flex-col" : undefined
        }
      >
        {workflowPane}
      </div>
    </aside>
  );
}
