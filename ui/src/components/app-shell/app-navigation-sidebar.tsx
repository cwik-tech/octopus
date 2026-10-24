import { DesktopSidebar } from "@/components/sidebar/desktop-sidebar";
import type { PendingSidebarDelete } from "@/components/sidebar/desktop-sidebar";
import { WorkspaceSidebar } from "@/components/sidebar/workspace-sidebar";
import type { CreateWorkspaceController } from "@/hooks/use-create-workspace-controller";
import type { LibraryWorkspaceController } from "@/hooks/use-library-workspace-controller";
import type { RunWorkspaceController } from "@/hooks/use-run-workspace-controller";
import type { NavigationTab } from "@/lib/utils/app-navigation";

export function AppNavigationSidebar({
  activeTab,
  create,
  deletingItemId,
  isOpen,
  library,
  onCreateLibraryProject,
  onDelete,
  run,
}: {
  activeTab: NavigationTab;
  create: CreateWorkspaceController;
  deletingItemId: string | null;
  isOpen: boolean;
  library: LibraryWorkspaceController;
  onCreateLibraryProject: () => void;
  onDelete: (target: PendingSidebarDelete) => void;
  run: RunWorkspaceController;
}) {
  return (
    <div
      className={[
        "h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out",
        isOpen ? "w-75" : "w-0",
      ].join(" ")}
    >
      <WorkspaceSidebar aria-label="Primary navigation" open={isOpen} side="left">
        <DesktopSidebar
          key={activeTab}
          activeTab={activeTab}
          createData={create.sidebar.data}
          createError={create.sidebar.error}
          createLoading={create.sidebar.loading}
          createTab={create.createTab}
          deletingSidebarItem={deletingItemId}
          error={run.sessions.error}
          loading={run.sessions.loading}
          libraryError={library.error}
          libraryLoading={library.loading}
          libraryProjects={library.projects}
          librarySection={library.section}
          libraryResourceSnapshot={library.resourceSnapshot}
          libraryResourcesError={library.resourcesError}
          libraryResourcesLoading={library.resourcesLoading}
          selectedLibraryResourceId={library.selectedResourceId}
          selectedLibraryProjectId={library.selectedProjectId}
          selectedCreateAgentName={create.selectedAgentName}
          selectedCreateTeamId={create.selectedTeamId}
          selectedCreateWorkflowId={create.selectedWorkflowId}
          sessions={run.sessions.sessions}
          selectedSessionId={run.selectedSessionId}
          queueError={run.queue.error}
          queueLoading={run.queue.loading}
          queueSnapshot={run.queue.snapshot}
          runWorkspaceView={run.workspaceView}
          batchesState={run.batches}
          schedulesState={run.schedules}
          onAgentSelect={create.selectAgent}
          onCreateTabChange={create.changeCreateTab}
          onDelete={onDelete}
          onLibraryOverviewSelect={library.showOverview}
          onLibraryProjectCreate={onCreateLibraryProject}
          onLibraryProjectSelect={library.selectProject}
          onLibrarySectionChange={library.changeSection}
          onLibraryResourceSelect={library.selectResource}
          onQueueSelect={run.selectQueue}
          onSchedulesSelect={run.selectSchedules}
          onSelect={run.selectSession}
          onSessionUpdated={(session) => {
            run.sessions.updateSession(session);
            if (
              run.workspaceView === "session" &&
              session.id === run.selectedSessionId
            ) {
              run.selectSession(session.id);
            }
          }}
          onTeamSelect={create.selectTeam}
          onWorkflowSelect={create.selectWorkflow}
        />
      </WorkspaceSidebar>
    </div>
  );
}
