import { useMemo, useState } from "react";

import { LibraryProjectsSidebar } from "@/components/sidebar/library-projects-sidebar";
import { SidebarError } from "@/components/sidebar/sidebar-error";
import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";
import { SidebarSkeleton } from "@/components/sidebar/sidebar-skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";
import type { WorkspaceProjectSummary } from "@/lib/models/session-model";
import { formatDisplayName } from "@/lib/utils/display-name";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";

const sections: { value: LibrarySection; label: string }[] = [
  { value: "projects", label: "Projects" },
  { value: "skills", label: "Skills" },
  { value: "agents", label: "Agents" },
  { value: "teams", label: "Teams" },
];

interface ResourceRow {
  id: string;
  label: string;
  meta: string;
  countBadge?: { count: number; tooltip: string };
  searchText: string;
}

export function LibraryResourcesSidebar({
  section,
  snapshot,
  loading,
  error,
  selectedResourceId,
  onSectionChange,
  onResourceSelect,
  projects,
  projectsLoading,
  projectsError,
  selectedProjectId,
  onCreateProject,
  onOverviewSelect,
  onProjectSelect,
}: {
  section: LibrarySection;
  snapshot: ResourceLibraryBrowserSnapshot | null;
  loading: boolean;
  error: string | null;
  selectedResourceId: string | null;
  projects: WorkspaceProjectSummary[];
  projectsLoading: boolean;
  projectsError: string | null;
  selectedProjectId: string | null;
  onSectionChange: (section: LibrarySection) => void;
  onResourceSelect: (resourceId: string) => void;
  onCreateProject: () => void;
  onOverviewSelect: () => void;
  onProjectSelect: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => snapshot ? resourceRows(section, snapshot) : [],
    [section, snapshot],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = rows.filter((row) =>
    `${row.label} ${row.searchText}`.toLowerCase().includes(normalizedQuery)
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar">
      <Tabs
        value={section}
        onValueChange={(value) => {
          const selected = sections.find((item) => item.value === value);
          if (!selected) return;
          setQuery("");
          onSectionChange(selected.value);
        }}
        className="mx-3 mt-3 shrink-0 gap-0"
      >
        <TabsList aria-label="Library sections" className="grid w-full grid-cols-4 bg-sidebar-accent/50 p-0.5">
          {sections.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="h-6 px-1 py-1 text-xs data-active:bg-card data-active:shadow-sm">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {section === "projects" ? (
        <LibraryProjectsSidebar
          projects={projects}
          loading={projectsLoading}
          error={projectsError}
          selectedProjectId={selectedProjectId}
          onCreateProject={onCreateProject}
          onOverviewSelect={onOverviewSelect}
          onProjectSelect={onProjectSelect}
        />
      ) : (
        <div className="desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <Input
            type="search"
            aria-label="Search Library resources"
            placeholder={`Search ${section}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-3 bg-sidebar-accent/50"
          />
          <SidebarError message={error} />
          {loading && !snapshot ? (
            <SidebarSkeleton />
          ) : visibleRows.length === 0 ? (
            <p className="rounded-lg px-2.5 py-3 text-sm text-sidebar-foreground/60">
              {normalizedQuery ? "No matching resources." : `No ${section} yet.`}
            </p>
          ) : (
            <div className="space-y-1" aria-label={`${section} resources`}>
              {visibleRows.map((row) => (
                <SidebarItemButton
                  key={row.id}
                  label={row.label}
                  meta={row.meta}
                  labelTrailing={row.countBadge ? <Badge variant="secondary" className="ml-auto size-6 rounded-full p-0">{row.countBadge.count}</Badge> : undefined}
                  rowTooltip={row.countBadge?.tooltip}
                  descriptionTooltip={row.searchText || undefined}
                  selected={selectedResourceId === row.id}
                  onClick={() => onResourceSelect(row.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function resourceRows(
  section: Exclude<LibrarySection, "projects"> | "projects",
  snapshot: ResourceLibraryBrowserSnapshot,
): ResourceRow[] {
  if (section === "skills") {
    return snapshot.skills.map((skill) => {
      const revision = skill.revisions.find((candidate) => candidate.id === skill.currentRevisionId);
      const usage = snapshot.agents.reduce(
        (count, agent) => count + agent.attachments.filter((attachment) => attachment.skillId === skill.id).length,
        0,
      );
      return {
        id: skill.id,
        label: skill.displayName,
        meta: `Revision ${revision?.sequence ?? 1} · ${usage} ${usage === 1 ? "agent" : "agents"}${skill.archived ? " · Archived" : ""}`,
        searchText: `${skill.description} ${skill.slug} ${skill.provenance.join(" ")}`,
      };
    });
  }
  if (section === "agents") {
    return snapshot.agentDetails.map((agent) => {
      const catalog = snapshot.agents.find((candidate) => candidate.id === agent.name);
      const count = catalog?.attachments.length ?? 0;
      return {
        id: agent.name,
        label: formatDisplayName(agent.name),
        meta: "",
        countBadge: { count, tooltip: `${count} attached ${count === 1 ? "skill" : "skills"}` },
        searchText: [agent.description, agent.provider, agent.model, ...agent.skills].filter(Boolean).join(" "),
      };
    });
  }
  if (section === "teams") {
    return snapshot.teamDetails.map((team) => ({
      id: team.id,
      label: formatDisplayName(team.name),
      meta: "",
      countBadge: { count: team.agentCount, tooltip: `${team.agentCount} ${team.agentCount === 1 ? "agent" : "agents"} in this Team` },
      searchText: [team.description, ...team.agents.map((agent) => agent.name)].filter(Boolean).join(" "),
    }));
  }
  if (section === "packages") return snapshot.packages.map((item) => ({ id: item.id, label: item.origin, meta: `${item.resourceIds.length} resources · ${item.installedAt}`, searchText: `${item.origin} ${item.id} ${item.digest}` }));
  return [];
}
