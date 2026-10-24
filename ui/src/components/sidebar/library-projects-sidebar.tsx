import { Archive, FolderKanban, LibraryBig } from "lucide-react";

import { OverviewSidebarItem } from "@/components/overview/overview-sidebar-item";
import { SidebarError } from "@/components/sidebar/sidebar-error";
import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";
import { SidebarSkeleton } from "@/components/sidebar/sidebar-skeleton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { WorkspaceProjectSummary } from "@/lib/models/session-model";

export function LibraryProjectsSidebar({
  projects,
  loading,
  error,
  selectedProjectId,
  onOverviewSelect,
  onProjectSelect,
}: {
  projects: WorkspaceProjectSummary[];
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  onCreateProject: () => void;
  onOverviewSelect: () => void;
  onProjectSelect: (projectId: string) => void;
}) {
  const activeProjects = projects.filter((project) => project.status === "active");
  const archivedProjects = projects.filter(
    (project) => project.status === "archived",
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar">
      <div className="desktop-sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <OverviewSidebarItem
          badge={projects.length}
          description={`${activeProjects.length} active · ${archivedProjects.length} archived`}
          icon={<LibraryBig className="size-4" aria-hidden="true" />}
          label="All projects"
          onClick={onOverviewSelect}
          selected={selectedProjectId === null}
        />

        <section aria-labelledby="library-projects-sidebar-heading">
          <div className="mb-1 flex h-7 items-center px-2.5">
            <h2
              id="library-projects-sidebar-heading"
              className="text-xs font-medium uppercase tracking-[0.14em] text-sidebar-foreground/45"
            >
              Projects
            </h2>
          </div>

          <SidebarError message={error} />
          {loading && projects.length === 0 ? (
            <SidebarSkeleton />
          ) : projects.length === 0 ? (
            <p className="rounded-lg px-2.5 py-3 text-sm text-sidebar-foreground/60">
              No projects yet.
            </p>
          ) : (
            <div className="space-y-3">
              {activeProjects.length > 0 ? (
                <ProjectGroup
                  projects={activeProjects}
                  selectedProjectId={selectedProjectId}
                  onProjectSelect={onProjectSelect}
                />
              ) : null}
              {archivedProjects.length > 0 ? (
                <Accordion>
                  <AccordionItem value="archived" className="border-b-0">
                    <AccordionTrigger
                      aria-label={`Archive (${archivedProjects.length})`}
                      className="mb-1 min-h-6 rounded-md px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-sidebar-foreground/40 hover:bg-sidebar-accent hover:no-underline"
                    >
                      Archive ({archivedProjects.length})
                    </AccordionTrigger>
                    <AccordionContent className="pb-0">
                      <ProjectGroup
                        projects={archivedProjects}
                        selectedProjectId={selectedProjectId}
                        onProjectSelect={onProjectSelect}
                        archived
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ProjectGroup({
  projects,
  selectedProjectId,
  onProjectSelect,
  archived = false,
}: {
  projects: WorkspaceProjectSummary[];
  selectedProjectId: string | null;
  onProjectSelect: (projectId: string) => void;
  archived?: boolean;
}) {
  return (
    <div className="space-y-1">
      {projects.map((project) => (
        <SidebarItemButton
          key={project.id}
          label={project.name}
          labelTrailing={
            archived ? (
              <Archive
                className="size-3.5 shrink-0 text-sidebar-foreground/45"
                aria-label="Archived"
              />
            ) : (
              <FolderKanban
                className="size-3.5 shrink-0 text-sidebar-foreground/45"
                aria-hidden="true"
              />
            )
          }
          meta={`${project.sessionCount} ${project.sessionCount === 1 ? "session" : "sessions"}`}
          onClick={() => onProjectSelect(project.id)}
          selected={project.id === selectedProjectId}
        />
      ))}
    </div>
  );
}
