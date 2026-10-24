import { useInitialSession } from "@/hooks/use-initial-session";
import { useCallback, useMemo, useRef, useState } from "react";

import { AppNavigationSidebar } from "@/components/app-shell/app-navigation-sidebar";
import { AppResizableWorkspace } from "@/components/app-shell/app-resizable-workspace";
import { AppTitlebar } from "@/components/app-shell/app-titlebar";
import { AppWindowActions } from "@/components/app-shell/app-window-actions";
import { AppWorkspacePanels } from "@/components/app-shell/app-workspace-panels";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { SidebarDeleteDialog } from "@/components/sidebar/sidebar-delete-dialog";
import type { WorkspaceRightSidebarControls } from "@/components/sidebar/workspace-right-sidebar-controls";
import { WorkspaceRightSidebarProvider } from "@/components/sidebar/workspace-right-sidebar";
import { WorkspaceRunSidebarProvider } from "@/components/sidebar/workspace-run-sidebar";
import { Tabs } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCreateWorkspaceController } from "@/hooks/use-create-workspace-controller";
import { useLibraryWorkspaceController } from "@/hooks/use-library-workspace-controller";
import { useRightSidebar } from "@/hooks/use-right-sidebar";
import { useRunWorkspaceController } from "@/hooks/use-run-workspace-controller";
import { useSettingsController } from "@/hooks/use-settings-controller";
import { useSidebarDeletion } from "@/hooks/use-sidebar-deletion";
import { useSidebarShortcuts } from "@/hooks/use-sidebar-shortcuts";
import { useTheme } from "@/hooks/use-theme";
import { useVoiceNavigation } from "@/hooks/use-voice-navigation";
import {
  getNewActionPresentation,
  type NavigationTab,
} from "@/lib/utils/app-navigation";

function App() {
  const [activeTab, setActiveTab] = useState<NavigationTab>("run");
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [libraryCreateProjectAction, setLibraryCreateProjectAction] = useState<
    (() => void) | null
  >(null);
  const [theme, setTheme] = useTheme();
  const settings = useSettingsController();
  const create = useCreateWorkspaceController({ activeTab, setActiveTab });
  const library = useLibraryWorkspaceController({ activeTab });
  const run = useRunWorkspaceController({
    activeTab,
    setActiveTab,
    setLeftSidebarOpen,
  });
  useVoiceNavigation(run.openSession);
  useInitialSession(run.openSession);
  const registerLibraryCreateProjectAction = useCallback(
    (action: (() => void) | null) => {
      setLibraryCreateProjectAction(() => action);
    },
    [],
  );
  const headerRef = useRef<HTMLElement>(null);
  const [workspaceSidebar, setWorkspaceSidebar] = useState<WorkspaceRightSidebarControls | null>(null);
  const rightSidebar = useRightSidebar({
    activeTab,
    runWorkspaceView: run.workspaceView,
    runInspectorOpen: run.inspectorOpen,
    runTargetLockReason: run.runTargetLockReason,
    createInspectorOpen: create.inspectorOpen,
    setRunInspectorOpen: run.setInspectorOpen,
    setCreateInspectorOpen: create.setInspectorOpen,
    headerRef,
    workspaceSidebar,
  });
  useSidebarShortcuts({
    rightSidebarAvailable: rightSidebar.rightSidebarAvailable,
    rightSidebarOpen: rightSidebar.rightSidebarOpen,
    onRightSidebarOpenChange: rightSidebar.handleRightSidebarOpenChange,
    setLeftSidebarOpen,
  });
  const deletion = useSidebarDeletion({
    selectedSidebarSessionId: run.selectedSessionId,
    selectedCreateWorkflowId: create.selectedWorkflowId,
    selectedCreateTeamId: create.selectedTeamId,
    selectedCreateAgentName: create.selectedAgentName,
    setSidebarSessions: run.sessions.setSessions,
    setSidebarSessionsError: run.sessions.setError,
    setSelectedSidebarSessionId: run.setSelectedSessionId,
    setRunSessionSelectionRequest: run.setSelectionRequest,
    setRunSessionDeletionRequest: run.setDeletionRequest,
    setCreateSidebarData: create.sidebar.setData,
    setCreateSidebarError: create.sidebar.setError,
    setSelectedCreateWorkflowId: create.setSelectedWorkflowId,
    setWorkflowSelectionRequest: create.setWorkflowSelectionRequest,
    setSelectedCreateTeamId: create.setSelectedTeamId,
    setTeamSelectionRequest: create.setTeamSelectionRequest,
    setSelectedCreateAgentName: create.setSelectedAgentName,
    setCreateAgentSelectionRequest: create.setAgentSelectionRequest,
    setCreateInspectorOpen: create.setInspectorOpen,
  });

  const changeNavigationTab = useCallback(
    (value: string) => {
      const nextTab = value as NavigationTab;
      const isLeavingWorkflowDraft =
        activeTab === "create" &&
        create.createTab === "workflows" &&
        nextTab !== "create";
      if (isLeavingWorkflowDraft && !create.confirmLeave()) return;
      if (nextTab === "library") library.showOverview();
      setActiveTab(nextTab);
      if (nextTab === "create") {
        create.setInspectorOpen(true);
      }
    },
    [activeTab, create, library],
  );

  const newAction = useMemo(
    () =>
      getNewActionPresentation({
        activeTab,
        createTab: create.createTab,
        isCreatingSession: run.isCreatingSession,
        librarySection: library.section,
        libraryActionReady: libraryCreateProjectAction !== null,
      }),
    [activeTab, create.createTab, run.isCreatingSession, library.section, libraryCreateProjectAction],
  );
  const runNewAction = useCallback(() => {
    if (activeTab === "run") {
      void run.createSidebarSession();
    } else if (activeTab === "create") {
      create.createNewItem();
    } else {
      libraryCreateProjectAction?.();
    }
  }, [activeTab, create, libraryCreateProjectAction, run]);
  const shortcutKeys = useMemo(() => {
    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return isMac ? ["⌘"] : ["Ctrl"];
  }, []);

  return (
    <TooltipProvider>
      <div className="desktop-shell relative flex h-screen flex-col overflow-hidden bg-background">
        <Tabs
          value={activeTab}
          onValueChange={changeNavigationTab}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <WorkspaceRightSidebarProvider target={rightSidebar.rightSidebarTarget} onControlsChange={setWorkspaceSidebar}>
            <WorkspaceRunSidebarProvider
              targetsAvailable={activeTab === "run" && run.workspaceView === "session" && run.runTargetLockReason === null}
              unavailableReason={run.runTargetLockReason === "scheduled-research"
                ? "Scheduled research in progress"
                : run.runTargetLockReason === "team-history"
                  ? "Team is fixed for this session"
                  : "Open a session to select a chat target"}
            >
            <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
              <AppNavigationSidebar
                activeTab={activeTab}
                create={create}
                deletingItemId={deletion.deletingSidebarItem}
                isOpen={leftSidebarOpen}
                library={library}
                onCreateLibraryProject={() => libraryCreateProjectAction?.()}
                onDelete={deletion.requestSidebarDelete}
                run={run}
              />
              <AppResizableWorkspace
                handleOpenChange={rightSidebar.handleRightSidebarOpenChange}
                handleResize={rightSidebar.handleRightSidebarResize}
                header={
                  <AppTitlebar
                    headerRef={headerRef}
                    leftSidebarOpen={leftSidebarOpen}
                  />
                }
                initialSize={rightSidebar.initialRightSidebarSize}
                isOpen={rightSidebar.rightSidebarOpen}
                panelRef={rightSidebar.rightSidebarPanelRef}
                setTarget={rightSidebar.setRightSidebarTarget}
              >
                <AppWorkspacePanels
                  activeTab={activeTab}
                  create={create}
                  library={{
                    projects: library.projects,
                    projectsError: library.error,
                    projectsLoading: library.loading,
                    selectedProjectId: library.selectedProjectId,
                    sessions: run.sessions.sessions,
                    section: library.section,
                    resourceSnapshot: library.resourceSnapshot,
                    resourcesError: library.resourcesError,
                    resourcesLoading: library.resourcesLoading,
                    selectedResourceId: library.selectedResourceId,
                    onResourcesChanged: () => void library.refreshResources(),
                    onResourceSelect: library.selectResource,
                    onCreateProjectActionChange: registerLibraryCreateProjectAction,
                    onOpenSession: run.openSession,
                    onProjectCreated: library.projectCreated,
                    onProjectDeleted: library.projectDeleted,
                    onProjectSelect: library.selectProject,
                    onProjectUpdated: library.projectUpdated,
                    onSessionsChanged: () => void run.sessions.refresh(true),
                    onSessionUpdated: run.sessions.updateSession,
                  }}
                  onOpenSchedulingSettings={settings.openSchedulingSettings}
                  run={run}
                />
              </AppResizableWorkspace>
            </div>
            </WorkspaceRunSidebarProvider>
          </WorkspaceRightSidebarProvider>
        </Tabs>

        {/* Must follow the workspace: Chromium resolves app-region overlaps in document order. */}
        <AppWindowActions
          isLeftSidebarOpen={leftSidebarOpen}
          isSettingsOpen={settings.isOpen}
          isUsingDarkTheme={theme === "dark"}
          newActionDisabled={newAction.disabled}
          newActionLabel={newAction.label}
          onNewAction={runNewAction}
          onOpenSettings={settings.openSettings}
          onRightSidebarToggle={rightSidebar.handleRightSidebarToggle}
          rightSidebarDisabled={rightSidebar.rightSidebarDisabled}
          rightSidebarLabel={rightSidebar.rightSidebarLabel}
          rightSidebarOpen={rightSidebar.rightSidebarOpen}
          rightSidebarVisible={activeTab !== "run" || rightSidebar.rightSidebarAvailable}
          setLeftSidebarOpen={setLeftSidebarOpen}
          shortcutKeys={shortcutKeys}
          toggleTheme={() =>
            setTheme((value) => (value === "dark" ? "light" : "dark"))
          }
        />
        <SidebarDeleteDialog
          target={deletion.pendingSidebarDelete}
          deleting={
            deletion.pendingSidebarDelete !== null &&
            deletion.deletingSidebarItem === deletion.pendingSidebarDelete.id
          }
          error={deletion.sidebarDeleteError}
          onOpenChange={(open) => {
            if (!open && !deletion.deletingSidebarItem) {
              deletion.setPendingSidebarDelete(null);
              deletion.setSidebarDeleteError(null);
            }
          }}
          onConfirm={(neverAskAgain) => {
            if (deletion.pendingSidebarDelete) {
              void deletion.deleteSidebarItem(
                deletion.pendingSidebarDelete,
                neverAskAgain,
              );
            }
          }}
        />
        <SettingsDialog
          key={settings.sectionRequest?.requestId ?? "default-settings"}
          open={settings.isOpen}
          initialSection={settings.sectionRequest?.section}
          onOpenChange={settings.setIsOpen}
          onSchedulingSaved={run.queue.refresh}
        />
        <Toaster richColors position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}

export default App;
