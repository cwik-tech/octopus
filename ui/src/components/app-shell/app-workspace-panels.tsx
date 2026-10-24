import { lazy, Suspense, useState } from "react";

import { TabsContent } from "@/components/ui/tabs";
import { WorkspaceLoading } from "@/components/ui/workspace-loading";
import type { CreateWorkspaceController } from "@/hooks/use-create-workspace-controller";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";
import type { RunWorkspaceController } from "@/hooks/use-run-workspace-controller";
import type {
  SessionSummary,
  WorkspaceProject,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";
import type { NavigationTab } from "@/lib/utils/app-navigation";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";

const CreatePanel = lazy(() => import("@/components/create/create-panel"));
const RunPanel = lazy(() => import("@/components/run/run-panel"));
const LibraryPanel = lazy(() => import("@/components/library/library-panel"));

export function AppWorkspacePanels({
  activeTab,
  create,
  library,
  onOpenSchedulingSettings,
  run,
}: {
  activeTab: NavigationTab;
  create: CreateWorkspaceController;
  library: {
    projects: WorkspaceProjectSummary[];
    projectsError: string | null;
    projectsLoading: boolean;
    selectedProjectId: string | null;
    sessions: SessionSummary[];
    section: LibrarySection;
    resourceSnapshot: ResourceLibraryBrowserSnapshot | null;
    resourcesError: string | null;
    resourcesLoading: boolean;
    selectedResourceId: string | null;
    onResourcesChanged: () => void;
    onResourceSelect: (resourceId: string) => void;
    onCreateProjectActionChange: (action: (() => void) | null) => void;
    onOpenSession: (sessionId: string) => void;
    onProjectCreated: (project: WorkspaceProject) => void;
    onProjectDeleted: (projectId: string) => void;
    onProjectSelect: (projectId: string) => void;
    onProjectUpdated: (project: WorkspaceProject) => void;
    onSessionsChanged: () => void;
    onSessionUpdated: (session: SessionSummary) => void;
  };
  onOpenSchedulingSettings: () => void;
  run: RunWorkspaceController;
}) {
  const [retainCreateConversation, setRetainCreateConversation] = useState(false);
  // What Create was keeping when the user left it stays until they come back
  // and see how it ended. Otherwise a build that fails while Run is open
  // unmounts Create before anyone has read the failure or reached its Retry.
  const createActive = activeTab === "create";
  const [createWasActive, setCreateWasActive] = useState(createActive);
  const [keptSinceLeaving, setKeptSinceLeaving] = useState(false);
  if (createWasActive !== createActive) {
    setCreateWasActive(createActive);
    setKeptSinceLeaving(!createActive && retainCreateConversation);
  }

  return (
    <div className="min-h-0 flex-1">
      <TabsContent value="run" className="mt-0 h-full min-h-0 flex-1">
        <Suspense fallback={<WorkspaceLoading label="Run" />}>
          <RunPanel
            batchesState={run.batches}
            sidebarOpen={false}
            inspectorOpen={
              run.workspaceView === "session" &&
              run.runTargetLockReason === null
            }
            schedulesState={run.schedules}
            onSessionActivityStarted={run.reportSessionActivity}
            onCreateSessionActionChange={run.registerCreateSessionAction}
            onOpenQueueSession={run.openSession}
            onOpenSchedulingSettings={onOpenSchedulingSettings}
            onQueueRefresh={run.queue.refresh}
            onRunTargetLockChange={run.setRunTargetLockReason}
            onSessionCreated={run.selectSession}
            queueError={run.queue.error}
            queueLoading={run.queue.loading}
            queueSnapshot={run.queue.snapshot}
            queueSessions={run.sessions.sessions}
            sessionDeletionRequest={run.deletionRequest}
            sessionSelectionRequest={run.selectionRequest}
            workspaceView={run.workspaceView}
          />
        </Suspense>
      </TabsContent>
      <TabsContent
        value="create"
        keepMounted={retainCreateConversation || keptSinceLeaving}
        className="mt-0 h-full min-h-0 flex-1"
      >
        <Suspense fallback={<WorkspaceLoading label="Create" />}>
          <CreatePanel
            key={`create:${create.workspaceKey}`}
            agentSelectionRequest={create.agentSelectionRequest}
            createTab={create.createTab}
            detailsOpen={create.inspectorOpen}
            onCreateTabChange={create.changeCreateTab}
            onDetailsOpenChange={create.setInspectorOpen}
            onOpenAgent={create.selectAgent}
            onClearAgentSelection={() => create.setSelectedAgentName(null)}
            onOpenTeam={create.selectTeam}
            onResourcesChanged={create.sidebar.handleResourcesChanged}
            onConversationRetentionChange={setRetainCreateConversation}
            onWorkflowDirtyChange={create.setIsWorkflowDraftDirty}
            onWorkflowSelectionBlocked={create.setSelectedWorkflowId}
            teamSelectionRequest={create.teamSelectionRequest}
            workflowSelectionRequest={create.workflowSelectionRequest}
          />
        </Suspense>
      </TabsContent>
      <TabsContent value="library" className="mt-0 h-full min-h-0 flex-1">
        <Suspense fallback={<WorkspaceLoading label="Library" />}>
          <LibraryPanel {...library} />
        </Suspense>
      </TabsContent>
    </div>
  );
}
