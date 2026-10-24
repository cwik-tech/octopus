import { useCallback, useEffect, useRef, useState } from "react";

import { listAgents } from "@/lib/clients/agent-generator-client";
import { listWorkflows } from "@/lib/clients/session-client";
import {
  invalidateTeamBuilderTeamsCache,
  listTeamBuilderTeams,
  subscribeToTeamBuilderTeams,
} from "@/lib/clients/team-builder-client";
import type { AgentSummary } from "@/lib/models/agent-generator-model";
import type { WorkflowSummary } from "@/lib/models/session-model";
import type { TeamBuilderSummary } from "@/lib/models/team-builder-model";
import type { NavigationTab } from "@/lib/utils/app-navigation";

export interface CreateSidebarData {
  agents: AgentSummary[];
  teams: TeamBuilderSummary[];
  workflows: WorkflowSummary[];
}

export function useCreateSidebar(activeTab: NavigationTab) {
  const [data, setData] = useState<CreateSidebarData>({
    agents: [],
    teams: [],
    workflows: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequestRef = useRef(0);
  const publishingInvalidationRef = useRef(false);

  const load = useCallback(async (quiet = false) => {
    const request = ++latestRequestRef.current;
    if (!quiet) setLoading(true);
    try {
      const [workflows, teams, agents] = await Promise.all([
        listWorkflows(),
        listTeamBuilderTeams(),
        // Create is where a system agent's persona is edited, so this is the
        // one catalog that lists them. The Run picker keeps the default.
        listAgents({ includeSystem: true }),
      ]);
      if (request !== latestRequestRef.current) return;
      setData({ agents, teams, workflows });
      setError(null);
    } catch (error) {
      if (request !== latestRequestRef.current) return;
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === latestRequestRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(
    async (quiet = false) => {
      // The Architect creates teams server-side, so nothing else drops the
      // Run tab's cached catalog. Publish once while suppressing this hook's
      // own synchronous subscription callback, then perform one local load.
      publishingInvalidationRef.current = true;
      try {
        invalidateTeamBuilderTeamsCache();
      } finally {
        publishingInvalidationRef.current = false;
      }
      await load(quiet);
    },
    [load],
  );

  useEffect(() => {
    if (activeTab !== "create") return;

    const unsubscribe = subscribeToTeamBuilderTeams(() => {
      if (publishingInvalidationRef.current) return;
      void load(true);
    });
    // Initial external create-resource sync for the desktop sidebar.
    void Promise.resolve().then(() => refresh());
    return unsubscribe;
  }, [activeTab, load, refresh]);

  const handleResourcesChanged = useCallback(() => refresh(true), [refresh]);

  return {
    data,
    setData,
    loading,
    error,
    setError,
    refresh,
    handleResourcesChanged,
  };
}
