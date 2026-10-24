import type { RunWorkspaceView } from "@/components/run/run-panel";
import type { SchedulesState } from "@/components/schedule/use-schedules";
import type { BatchesState } from "@/components/batch/use-batches";
import { CreateResourcesSidebar } from "@/components/sidebar/create-resources-sidebar";
import { LibraryResourcesSidebar } from "@/components/sidebar/library-resources-sidebar";
import { RunSessionsSidebar } from "@/components/sidebar/run-sessions-sidebar";
import type { SidebarDeleteTarget } from "@/components/sidebar/sidebar-delete-dialog";
import type { CreateSidebarData } from "@/hooks/use-create-sidebar";
import type { CreateListTab } from "@/hooks/use-create-workspace-controller";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";
import type { SchedulingQueueSnapshot } from "@/lib/clients/scheduling-queue-client";
import type {
  SessionSummary,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";
import type { NavigationTab } from "@/lib/utils/app-navigation";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";

export type SidebarDeleteKind = "session" | "workflow" | "team" | "agent";

export interface PendingSidebarDelete extends SidebarDeleteTarget {
  id: string;
  kind: SidebarDeleteKind;
  /**
   * For a Team, the revision of the row the person was shown when they asked
   * to delete it, so the delete is refused if the team has changed since.
   */
  revision?: string | undefined;
}

export interface DesktopSidebarProps {
  activeTab: NavigationTab;
  createData: CreateSidebarData;
  createError: string | null;
  createLoading: boolean;
  createTab: CreateListTab;
  deletingSidebarItem: string | null;
  error: string | null;
  loading: boolean;
  libraryError?: string | null;
  libraryLoading?: boolean;
  libraryProjects?: WorkspaceProjectSummary[];
  librarySection?: LibrarySection;
  libraryResourceSnapshot?: ResourceLibraryBrowserSnapshot | null;
  libraryResourcesError?: string | null;
  libraryResourcesLoading?: boolean;
  selectedLibraryResourceId?: string | null;
  onAgentSelect: (agentName: string) => void;
  onCreateTabChange?: (tab: CreateListTab) => void;
  onDelete: (target: PendingSidebarDelete) => void;
  onLibraryOverviewSelect?: () => void;
  onLibraryProjectCreate?: () => void;
  onLibraryProjectSelect?: (projectId: string) => void;
  onLibrarySectionChange?: (section: LibrarySection) => void;
  onLibraryResourceSelect?: (resourceId: string) => void;
  onQueueSelect?: () => void;
  onSchedulesSelect?: () => void;
  onSelect: (sessionId: string) => void;
  onSessionUpdated?: (session: SessionSummary) => void;
  onTeamSelect: (teamId: string) => void;
  onWorkflowSelect: (workflowId: string) => void;
  selectedCreateAgentName: string | null;
  selectedCreateTeamId: string | null;
  selectedCreateWorkflowId: string | null;
  selectedLibraryProjectId?: string | null;
  selectedSessionId: string | null;
  sessions: SessionSummary[];
  queueError?: string | null;
  queueLoading?: boolean;
  queueSnapshot?: SchedulingQueueSnapshot | null;
  runWorkspaceView?: RunWorkspaceView;
  schedulesState?: SchedulesState;
  batchesState?: BatchesState;
}

export function DesktopSidebar({
  activeTab,
  createData,
  createError,
  createLoading,
  createTab,
  deletingSidebarItem,
  error,
  loading,
  libraryError = null,
  libraryLoading = false,
  libraryProjects = [],
  librarySection = "projects",
  libraryResourceSnapshot = null,
  libraryResourcesError = null,
  libraryResourcesLoading = false,
  selectedLibraryResourceId = null,
  onAgentSelect,
  onCreateTabChange,
  onDelete,
  onLibraryOverviewSelect = () => undefined,
  onLibraryProjectCreate = () => undefined,
  onLibraryProjectSelect = () => undefined,
  onLibrarySectionChange = () => undefined,
  onLibraryResourceSelect = () => undefined,
  onQueueSelect = () => undefined,
  onSchedulesSelect = () => undefined,
  onSelect,
  onSessionUpdated = () => undefined,
  onTeamSelect,
  onWorkflowSelect,
  selectedCreateAgentName,
  selectedCreateTeamId,
  selectedCreateWorkflowId,
  selectedLibraryProjectId = null,
  selectedSessionId,
  sessions,
  queueError = null,
  queueLoading = false,
  queueSnapshot = null,
  runWorkspaceView = "session",
  batchesState,
  schedulesState,
}: DesktopSidebarProps) {
  if (activeTab === "library") {
    return (
      <LibraryResourcesSidebar
        section={librarySection}
        snapshot={libraryResourceSnapshot}
        loading={libraryResourcesLoading}
        error={libraryResourcesError}
        selectedResourceId={selectedLibraryResourceId}
        projects={libraryProjects}
        projectsLoading={libraryLoading}
        projectsError={libraryError}
        selectedProjectId={selectedLibraryProjectId}
        onSectionChange={onLibrarySectionChange}
        onResourceSelect={onLibraryResourceSelect}
        onCreateProject={onLibraryProjectCreate}
        onOverviewSelect={onLibraryOverviewSelect}
        onProjectSelect={onLibraryProjectSelect}
      />
    );
  }

  if (activeTab === "create") {
    return (
      <CreateResourcesSidebar
        createData={createData}
        createError={createError}
        createLoading={createLoading}
        createTab={createTab}
        deletingSidebarItem={deletingSidebarItem}
        selectedCreateWorkflowId={selectedCreateWorkflowId}
        selectedCreateTeamId={selectedCreateTeamId}
        selectedCreateAgentName={selectedCreateAgentName}
        onWorkflowSelect={onWorkflowSelect}
        onTeamSelect={onTeamSelect}
        onAgentSelect={onAgentSelect}
        onCreateTabChange={onCreateTabChange}
        onDelete={onDelete}
      />
    );
  }

  return (
    <RunSessionsSidebar
      sessions={sessions}
      loading={loading}
      error={error}
      selectedSessionId={selectedSessionId}
      deletingSidebarItem={deletingSidebarItem}
      queueError={queueError}
      queueLoading={queueLoading}
      queueSnapshot={queueSnapshot}
      runWorkspaceView={runWorkspaceView}
      batchesState={batchesState}
      schedulesState={schedulesState}
      onSelect={onSelect}
      onSessionUpdated={onSessionUpdated}
      onDelete={onDelete}
      onQueueSelect={onQueueSelect}
      onSchedulesSelect={onSchedulesSelect}
    />
  );
}
