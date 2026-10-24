import {
  Archive,
  ArchiveRestore,
  Download,
  EllipsisVertical,
  Eye,
  FileUp,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ProjectEditorDialog,
  type ProjectEditorValue,
} from "@/components/library/project-editor-dialog";
import { ProjectDeleteDialog } from "@/components/library/project-delete-dialog";
import { LibraryOverview } from "@/components/library/library-overview";
import { ResourceLibraryPanel } from "@/components/library/resource-library-panel";
import { ProjectContextDetails } from "@/components/library/project-context-details";
import { ProjectFileCatalog } from "@/components/library/project-file-catalog";
import { ProjectMemoryPanel } from "@/components/library/project-memory-panel";
import { ProjectSchedulesPanel } from "@/components/library/project-schedules-panel";
import { SessionProjectActionMenu } from "@/components/library/session-project-action-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  assignSessionToProject,
  createProject,
  deleteProject,
  getProjectDetails,
  projectExportUrl,
  removeSessionFromProject,
  updateProject,
} from "@/lib/clients/project-client";
import { createSession } from "@/lib/clients/session-client";
import type {
  SessionSummary,
  WorkspaceProject,
  WorkspaceProjectDeleteMode,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";
import type { WorkspaceProjectDetails } from "@contracts/project-details";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";

interface LibraryPanelProps {
  projects: WorkspaceProjectSummary[];
  projectsError: string | null;
  projectsLoading: boolean;
  selectedProjectId: string | null;
  sessions: SessionSummary[];
  section?: LibrarySection;
  resourceSnapshot?: ResourceLibraryBrowserSnapshot | null;
  resourcesError?: string | null;
  resourcesLoading?: boolean;
  selectedResourceId?: string | null;
  onResourcesChanged?: () => void;
  onResourceSelect?: (resourceId: string) => void;
  onCreateProjectActionChange: (action: (() => void) | null) => void;
  onOpenSession: (sessionId: string) => void;
  onProjectCreated: (project: WorkspaceProject) => void;
  onProjectDeleted: (projectId: string) => void;
  onProjectSelect: (projectId: string) => void;
  onProjectUpdated: (project: WorkspaceProject) => void;
  onSessionsChanged: () => void;
  onSessionUpdated: (session: SessionSummary) => void;
}

type LibraryProjectError = {
  scope: "action" | "details";
  message: string;
};

export default function LibraryPanel({
  projects,
  projectsError,
  projectsLoading,
  selectedProjectId,
  sessions,
  section = "projects",
  resourceSnapshot = null,
  resourcesError = null,
  resourcesLoading = false,
  selectedResourceId = null,
  onResourcesChanged = () => undefined,
  onResourceSelect = () => undefined,
  onCreateProjectActionChange,
  onOpenSession,
  onProjectCreated,
  onProjectDeleted,
  onProjectSelect,
  onProjectUpdated,
  onSessionsChanged,
  onSessionUpdated,
}: LibraryPanelProps) {
  const [projectDetails, setProjectDetails] =
    useState<WorkspaceProjectDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [projectError, setProjectError] = useState<LibraryProjectError | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [editorPending, setEditorPending] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [existingDialogOpen, setExistingDialogOpen] = useState(false);
  const [uploadRequest, setUploadRequest] = useState(0);
  const detailsRequestSequence = useRef(0);
  const detailsAbortController = useRef<AbortController | null>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);

  const setActionError = useCallback((message: string | null) => {
    setProjectError((current) =>
      message
        ? { scope: "action", message }
        : current?.scope === "action"
          ? null
          : current,
    );
  }, []);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  useEffect(() => {
    if (section !== "projects") return;
    onCreateProjectActionChange(() => {
      setEditorError(null);
      setEditorMode("create");
    });
    return () => onCreateProjectActionChange(null);
  }, [onCreateProjectActionChange, section]);

  const refreshProjectDetails = useCallback(async (
    projectId: string,
    options: { clear?: boolean } = {},
  ) => {
    const requestSequence = ++detailsRequestSequence.current;
    detailsAbortController.current?.abort();
    const controller = new AbortController();
    detailsAbortController.current = controller;
    if (options.clear) {
      startTransition(() => {
        setProjectDetails(null);
        setDetailsLoading(true);
        setProjectError(null);
      });
    }
    try {
      const next = await getProjectDetails(projectId, controller.signal);
      if (
        controller.signal.aborted ||
        detailsRequestSequence.current !== requestSequence ||
        selectedProjectIdRef.current !== projectId
      ) {
        return;
      }
      startTransition(() => {
        setProjectDetails(next);
        setProjectError((current) =>
          current?.scope === "details" ? null : current,
        );
      });
    } catch (nextError) {
      if (
        !controller.signal.aborted &&
        detailsRequestSequence.current === requestSequence &&
        selectedProjectIdRef.current === projectId
      ) {
        setProjectError({
          scope: "details",
          message: errorMessage(nextError),
        });
      }
    } finally {
      if (
        !controller.signal.aborted &&
        detailsRequestSequence.current === requestSequence &&
        selectedProjectIdRef.current === projectId
      ) {
        setDetailsLoading(false);
      }
      if (detailsAbortController.current === controller) {
        detailsAbortController.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      detailsAbortController.current?.abort();
      detailsAbortController.current = null;
      detailsRequestSequence.current += 1;
      startTransition(() => {
        setProjectDetails(null);
        setDetailsLoading(false);
        setProjectError(null);
      });
      return;
    }
    void refreshProjectDetails(selectedProjectId, { clear: true });
    return () => detailsAbortController.current?.abort();
  }, [refreshProjectDetails, selectedProjectId]);

  const saveProject = async (value: ProjectEditorValue) => {
    setEditorPending(true);
    setEditorError(null);
    try {
      if (editorMode === "edit" && selectedProject) {
        const updated = await updateProject(selectedProject.id, value);
        onProjectUpdated(updated);
      } else {
        const created = await createProject(value);
        onProjectCreated(created);
      }
      setEditorMode(null);
    } catch (nextError) {
      setEditorError(errorMessage(nextError));
    } finally {
      setEditorPending(false);
    }
  };

  const changeArchiveState = async () => {
    if (!selectedProject) return;
    setActionPending(true);
    setActionError(null);
    try {
      const status = selectedProject.status === "active" ? "archived" : "active";
      const updated = await updateProject(selectedProject.id, { status });
      onProjectUpdated(updated);
    } catch (nextError) {
      setActionError(errorMessage(nextError));
    } finally {
      setActionPending(false);
    }
  };

  const createProjectChat = async () => {
    if (!selectedProject || selectedProject.status !== "active") return;
    setActionPending(true);
    setActionError(null);
    try {
      const created = await createSession({ projectId: selectedProject.id });
      onSessionUpdated(created);
      void refreshProjectDetails(selectedProject.id);
      onOpenSession(created.id);
    } catch (nextError) {
      setActionError(errorMessage(nextError));
    } finally {
      setActionPending(false);
    }
  };

  const deleteSelectedProject = async (mode: WorkspaceProjectDeleteMode) => {
    if (!selectedProject) return;
    const projectId = selectedProject.id;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await deleteProject(projectId, mode);
      setDeleteDialogOpen(false);
      onProjectDeleted(projectId);
      onSessionsChanged();
    } catch (nextError) {
      setDeleteError(errorMessage(nextError));
    } finally {
      setDeletePending(false);
    }
  };

  const handleSessionUpdated = (updated: SessionSummary) => {
    onSessionUpdated(updated);
    if (selectedProjectId) void refreshProjectDetails(selectedProjectId);
  };

  if (section !== "projects") {
    if (resourceSnapshot) {
      return (
        <ResourceLibraryPanel
          section={section}
          snapshot={resourceSnapshot}
          selectedResourceId={selectedResourceId}
          onRefresh={onResourcesChanged}
          onResourceSelect={onResourceSelect}
          onCreateActionChange={onCreateProjectActionChange}
        />
      );
    }
    const label = section === "skills" ? "Skill library" : section === "agents" ? "Agent library" : "Team library";
    return (
      <section aria-label={label} className="canvas-glow flex h-full min-h-0 flex-col bg-background">
        <div className="p-6">
          {resourcesLoading ? (
            <p className="text-sm text-muted-foreground" role="status">Loading Library resources…</p>
          ) : resourcesError ? (
            <p className="text-sm text-destructive" role="alert">{resourcesError}</p>
          ) : (
            <PanelEmptyState>No Library resources are available.</PanelEmptyState>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className="canvas-glow flex h-full min-h-0 flex-col bg-background"
      aria-label="Project library"
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {selectedProject ? (
          <div className="mx-auto max-w-5xl p-6">
            <header className="flex items-start justify-between gap-4 border-b border-border/70 pb-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-heading text-2xl font-semibold">
                    {selectedProject.name}
                  </h2>
                  {selectedProject.status === "archived" ? (
                    <Badge variant="secondary">Archived</Badge>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedProject.description || "No project description yet."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditorError(null);
                    setEditorMode("edit");
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Edit
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={selectedProject.status === "archived" || actionPending}
                    render={<Button type="button" size="sm" />}
                  >
                    <Plus aria-hidden="true" />
                    Add to project
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => void createProjectChat()}>
                      <MessageSquarePlus aria-hidden="true" />
                      New chat
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setExistingDialogOpen(true)}>
                      <Plus aria-hidden="true" />
                      Add existing session
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setUploadRequest((current) => current + 1)}
                    >
                      <FileUp aria-hidden="true" />
                      Upload files
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={actionPending}
                    render={
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Project actions"
                      />
                    }
                  >
                    <EllipsisVertical aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44 whitespace-nowrap">
                    <DropdownMenuItem
                      onClick={() => {
                        window.open(
                          projectExportUrl(selectedProject.id),
                          "_blank",
                          "noopener,noreferrer",
                        );
                      }}
                    >
                      <Download aria-hidden="true" />
                      Export
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void changeArchiveState()}>
                      {selectedProject.status === "active" ? (
                        <Archive aria-hidden="true" />
                      ) : (
                        <ArchiveRestore aria-hidden="true" />
                      )}
                      {selectedProject.status === "active" ? "Archive" : "Restore"}
                    </DropdownMenuItem>
                    <DropdownMenuCheckboxItem
                      checked={showHiddenFiles}
                      onCheckedChange={setShowHiddenFiles}
                    >
                      <Eye aria-hidden="true" />
                      Show Hidden Files
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteDialogOpen(true);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete Project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>

            {projectError ? (
              <div
                className="mt-4 flex items-center gap-3 text-sm text-destructive"
                role="alert"
              >
                <p className="min-w-0 flex-1">{projectError.message}</p>
                {projectError.scope === "details" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={detailsLoading}
                    aria-label="Retry project details"
                    onClick={() =>
                      void refreshProjectDetails(selectedProject.id, { clear: true })
                    }
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}

            {detailsLoading ? (
              <div
                className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading project details…
              </div>
            ) : projectDetails?.project.id === selectedProject.id ? (
              <>
                <ProjectContextDetails
                  project={selectedProject}
                  uploadRequest={uploadRequest}
                  initialBrief={projectDetails.brief}
                  initialFiles={projectDetails.files}
                  onFilesChanged={() => refreshProjectDetails(selectedProject.id)}
                />

                <section className="mt-6" aria-labelledby="project-sessions-heading">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 id="project-sessions-heading" className="font-heading text-base font-semibold">
                      Sessions
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {projectDetails.sessions.length} total
                    </span>
                  </div>
                  {projectDetails.sessions.length === 0 ? (
                    <PanelEmptyState className="bg-transparent p-6 text-sm text-muted-foreground">
                      No sessions belong to this project yet.
                    </PanelEmptyState>
                  ) : (
                    <div className="divide-y rounded-xl border border-border/70">
                      {projectDetails.sessions.map((session) => (
                        <div key={session.id} className="flex items-center gap-2 px-3 py-2">
                          <Button
                            variant="ghost"
                            className="h-auto min-w-0 flex-1 flex-col items-start gap-0 px-0 py-0 text-left font-normal hover:bg-transparent"
                            aria-label={`Open ${session.title} in Run`}
                            onClick={() => onOpenSession(session.id)}
                          >
                            <span className="block w-full truncate text-sm font-medium">{session.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {session.activityType === "workflow" ? "Workflow" : "Chat"}
                            </span>
                          </Button>
                          <SessionProjectActionMenu
                            session={session}
                            onSessionUpdated={handleSessionUpdated}
                          />
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={`Remove ${session.title} from project`}
                                  onClick={() =>
                                    void removeProjectSession(
                                      selectedProject.id,
                                      session,
                                      handleSessionUpdated,
                                      setActionError,
                                    )
                                  }
                                />
                              }
                            >
                              <Unlink aria-hidden="true" />
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <p>Disconnect from Project</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <ProjectFileCatalog
                  projectId={selectedProject.id}
                  initialRoot={projectDetails.catalog}
                  showHiddenFiles={showHiddenFiles}
                />

                <ProjectSchedulesPanel
                  projectId={selectedProject.id}
                  initialSchedules={projectDetails.schedules}
                />

                <ProjectMemoryPanel
                  projectId={selectedProject.id}
                  active={selectedProject.status === "active"}
                  initialProposals={projectDetails.memoryProposals}
                  onProposalDecided={() =>
                    refreshProjectDetails(selectedProject.id)
                  }
                />
              </>
            ) : null}
          </div>
        ) : (
          <LibraryOverview
            projects={projects}
            loading={projectsLoading}
            error={projectsError}
            onCreateProject={() => {
              setEditorError(null);
              setEditorMode("create");
            }}
            onProjectSelect={onProjectSelect}
          />
        )}
      </div>

      <ProjectEditorDialog
        open={editorMode !== null}
        initialValue={
          editorMode === "edit" && selectedProject
            ? { name: selectedProject.name, description: selectedProject.description }
            : undefined
        }
        pending={editorPending}
        error={editorError}
        onOpenChange={(open) => {
          if (!open) setEditorMode(null);
        }}
        onSubmit={(value) => void saveProject(value)}
      />
      <ExistingSessionDialog
        open={existingDialogOpen}
        project={selectedProject}
        sessions={sessions}
        onOpenChange={setExistingDialogOpen}
        onAssigned={(updated) => {
          handleSessionUpdated(updated);
        }}
      />
      <ProjectDeleteDialog
        open={deleteDialogOpen}
        project={selectedProject}
        pending={deletePending}
        error={deleteError}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={(mode) => void deleteSelectedProject(mode)}
      />
    </section>
  );
}

function ExistingSessionDialog({
  open,
  project,
  sessions,
  onOpenChange,
  onAssigned,
}: {
  open: boolean;
  project: WorkspaceProjectSummary | null;
  sessions: SessionSummary[];
  onOpenChange: (open: boolean) => void;
  onAssigned: (session: SessionSummary) => void;
}) {
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = sessions.filter((session) => session.projectId !== project?.id);

  const assign = async (session: SessionSummary) => {
    if (!project) return;
    setPendingSessionId(session.id);
    setError(null);
    try {
      await assignSessionToProject(project.id, session.id);
      onAssigned({ ...session, projectId: project.id });
      onOpenChange(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setPendingSessionId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={pendingSessionId ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add existing session</DialogTitle>
          <DialogDescription>
            Choose a recent session. Sessions already assigned elsewhere will be moved.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No sessions available.</p>
          ) : (
            candidates.map((session) => (
              <Button
                key={session.id}
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start px-2 py-2"
                disabled={pendingSessionId !== null}
                onClick={() => void assign(session)}
              >
                {pendingSessionId === session.id ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <MessageSquarePlus className="size-4" aria-hidden="true" />
                )}
                <span className="truncate">{session.title}</span>
              </Button>
            ))
          )}
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

async function removeProjectSession(
  projectId: string,
  session: SessionSummary,
  onUpdated: (session: SessionSummary) => void,
  setError: (error: string | null) => void,
) {
  setError(null);
  try {
    await removeSessionFromProject(projectId, session.id);
    // Out of the project means no projectId at all: the session schema keeps a
    // missing optional field missing rather than set to undefined.
    const unassigned: SessionSummary = { ...session };
    delete unassigned.projectId;
    onUpdated(unassigned);
  } catch (nextError) {
    setError(errorMessage(nextError));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
