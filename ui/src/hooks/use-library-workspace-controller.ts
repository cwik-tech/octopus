import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { listProjects } from "@/lib/clients/project-client";
import { getResourceLibrarySnapshot } from "@/lib/clients/resource-library-client";
import type {
  WorkspaceProject,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";
import type { NavigationTab } from "@/lib/utils/app-navigation";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";

export type LibrarySection = "projects" | "skills" | "agents" | "teams" | "packages";

export function useLibraryWorkspaceController({
  activeTab,
}: {
  activeTab: NavigationTab;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<LibrarySection>("projects");
  const [resourceSnapshot, setResourceSnapshot] = useState<ResourceLibraryBrowserSnapshot | null>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const initialized = useRef(false);
  const resourceRefreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listProjects({ includeArchived: true });
      setProjects(next);
      setSelectedProjectId((current) =>
        current && next.some((project) => project.id === current) ? current : null,
      );
      setError(null);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshResources = useCallback(async () => {
    const sequence = ++resourceRefreshSequence.current;
    const isLatestRefresh = () => sequence === resourceRefreshSequence.current;
    setResourcesLoading(true);
    try {
      const next = await getResourceLibrarySnapshot();
      if (!isLatestRefresh()) return;
      setResourceSnapshot(next);
      setSelectedResourceId((current) => {
        if (!current) return null;
        const ids = section === "skills"
          ? next.skills.map((skill) => skill.id)
          : section === "agents"
            ? next.agentDetails.map((agent) => agent.name)
            : section === "teams" ? next.teamDetails.map((team) => team.id) : next.packages.map((item) => item.id);
        return current && ids.includes(current) ? current : null;
      });
      setResourcesError(null);
    } catch (nextError) {
      if (isLatestRefresh()) setResourcesError(errorMessage(nextError));
    } finally {
      if (isLatestRefresh()) setResourcesLoading(false);
    }
  }, [section]);

  useEffect(() => {
    if (initialized.current && activeTab !== "library") return;
    initialized.current = true;
    startTransition(() => {
      void refresh();
      void refreshResources();
    });
  }, [activeTab, refresh, refreshResources]);

  const showOverview = useCallback(() => {
    setSection("projects");
    setSelectedProjectId(null);
    setSelectedResourceId(null);
  }, []);
  const changeSection = useCallback((next: LibrarySection) => {
    setSection(next);
    setSelectedResourceId(null);
    if (next === "projects") setSelectedProjectId(null);
  }, []);
  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
  }, []);
  const selectResource = useCallback((resourceId: string) => {
    setSelectedResourceId(resourceId);
  }, []);
  const projectCreated = useCallback((project: WorkspaceProject) => {
    setProjects((current) => [toSummary(project), ...current]);
    setSelectedProjectId(project.id);
  }, []);
  const projectUpdated = useCallback((project: WorkspaceProject) => {
    setProjects((current) =>
      current.map((existing) =>
        existing.id === project.id ? { ...existing, ...project } : existing,
      ),
    );
  }, []);
  const projectDeleted = useCallback((projectId: string) => {
    setProjects((current) =>
      current.filter((project) => project.id !== projectId),
    );
    setSelectedProjectId((current) => (current === projectId ? null : current));
  }, []);

  return {
    error,
    loading,
    projectCreated,
    projectDeleted,
    projectUpdated,
    projects,
    refresh,
    refreshResources,
    resourceSnapshot,
    resourcesError,
    resourcesLoading,
    section,
    selectedProjectId,
    selectedResourceId,
    selectProject,
    selectResource,
    changeSection,
    showOverview,
  };
}

export type LibraryWorkspaceController = ReturnType<
  typeof useLibraryWorkspaceController
>;

function toSummary(project: WorkspaceProject): WorkspaceProjectSummary {
  return {
    ...project,
    sessionCount: 0,
    activeSessionCount: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
