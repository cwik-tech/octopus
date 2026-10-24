import { Archive, FolderKanban, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";
import type { WorkspaceProjectSummary } from "@/lib/models/session-model";

export function LibraryOverview({
  projects,
  loading,
  error,
  onProjectSelect,
}: {
  projects: WorkspaceProjectSummary[];
  loading: boolean;
  error: string | null;
  onCreateProject: () => void;
  onProjectSelect: (projectId: string) => void;
}) {
  const activeProjects = projects.filter((project) => project.status === "active");
  const archivedProjects = projects.filter(
    (project) => project.status === "archived",
  );

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Projects group related sessions, shared files, and deliverables.
          </p>
        </div>
      </header>

      {error ? (
        <p className="mt-5 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {loading && projects.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground" role="status">
          Loading projects…
        </p>
      ) : projects.length === 0 ? (
        <PanelEmptyState className="mt-8 bg-transparent p-8">
          <FolderKanban
            className="mx-auto size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="mt-3 font-heading text-lg font-semibold">No projects yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a project to group sessions and shared context.
          </p>
        </PanelEmptyState>
      ) : (
        <div className="mt-8 space-y-10">
          <ProjectSection
            title="Active projects"
            projects={activeProjects}
            onProjectSelect={onProjectSelect}
          />
          {archivedProjects.length > 0 ? (
            <ProjectSection
              title="Archived"
              projects={archivedProjects}
              onProjectSelect={onProjectSelect}
              archived
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ProjectSection({
  title,
  projects,
  onProjectSelect,
  archived = false,
}: {
  title: string;
  projects: WorkspaceProjectSummary[];
  onProjectSelect: (projectId: string) => void;
  archived?: boolean;
}) {
  return (
    <section aria-labelledby={`library-${archived ? "archived" : "active"}-heading`}>
      <h2
        id={`library-${archived ? "archived" : "active"}-heading`}
        className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground"
      >
        {title}
      </h2>
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active projects.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <Button
              key={project.id}
              variant="ghost"
              aria-label={`Open ${project.name}`}
              className="h-auto flex-col items-stretch gap-0 rounded-xl border border-border/70 bg-card p-4 text-left font-normal hover:border-primary/45 hover:bg-accent/35"
              onClick={() => onProjectSelect(project.id)}
            >
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-text">
                  {archived ? (
                    <Archive className="size-5" aria-hidden="true" />
                  ) : (
                    <FolderKanban className="size-5" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-heading text-base font-semibold">
                    {project.name}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-sm text-muted-foreground">
                    {project.description || "No project description yet."}
                  </span>
                </span>
              </div>
              <span className="mt-4 flex items-center gap-2 border-t border-border/70 pt-3 text-sm text-muted-foreground">
                <MessageSquare className="size-4" aria-hidden="true" />
                {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                <Badge variant="secondary" className="ml-auto">
                  {archived ? "Archived" : "Active"}
                </Badge>
              </span>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
