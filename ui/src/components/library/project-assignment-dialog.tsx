import { Check, Loader2 } from "lucide-react";
import { startTransition, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  assignSessionToProject,
  listProjects,
  removeSessionFromProject,
} from "@/lib/clients/project-client";
import type {
  SessionSummary,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";

export function ProjectAssignmentDialog({
  open,
  session,
  onOpenChange,
  onSessionUpdated,
}: {
  open: boolean;
  session: SessionSummary | null;
  onOpenChange: (open: boolean) => void;
  onSessionUpdated: (session: SessionSummary) => void;
}) {
  const [projects, setProjects] = useState<WorkspaceProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    startTransition(() => {
      setProjects([]);
      setLoading(true);
      setError(null);
    });
    void listProjects()
      .then((nextProjects) => {
        if (!cancelled) {
          setProjects(nextProjects.filter((project) => project.status === "active"));
        }
      })
      .catch((nextError: unknown) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const assign = async (projectId: string) => {
    if (!session) return;
    setPendingProjectId(projectId);
    setError(null);
    try {
      await assignSessionToProject(projectId, session.id);
      onSessionUpdated({ ...session, projectId });
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingProjectId(null);
    }
  };

  const remove = async () => {
    if (!session) return;
    // Out of the project means no projectId at all: the session schema keeps a
    // missing optional field missing rather than set to undefined.
    const { projectId, ...unassigned } = session;
    if (!projectId) return;
    setPendingProjectId(projectId);
    setError(null);
    try {
      await removeSessionFromProject(projectId, session.id);
      onSessionUpdated(unassigned);
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingProjectId(null);
    }
  };

  const pending = pendingProjectId !== null;
  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Project</DialogTitle>
          <DialogDescription>
            {session
              ? `Choose a project for “${session.title}”. Assigning another project moves the whole session.`
              : "Choose a project for this session."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-1 overflow-y-auto">
          {loading ? (
            <div role="status" className="flex items-center gap-2 px-2 py-3 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading projects…
            </div>
          ) : projects.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No projects yet. Create one in Library first.
            </p>
          ) : (
            projects.map((project) => {
              const current = session?.projectId === project.id;
              const itemPending = pendingProjectId === project.id;
              return (
                <Button
                  key={project.id}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                  disabled={pending}
                  aria-label={`${project.name}${current ? ", current project" : ""}`}
                  onClick={() => void assign(project.id)}
                >
                  {itemPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : current ? (
                    <Check className="size-4 text-primary-text" aria-hidden="true" />
                  ) : (
                    <span className="size-4" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {current ? (
                    <span className="text-xs text-muted-foreground">Current</span>
                  ) : null}
                </Button>
              );
            })
          )}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {session?.projectId ? (
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void remove()}
            >
              Remove from project
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
