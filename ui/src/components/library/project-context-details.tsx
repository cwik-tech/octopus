import { Pencil } from "lucide-react";
import { startTransition, useEffect, useRef, useState } from "react";

import { ProjectSharedFolders } from "@/components/library/project-shared-folders";
import FileUpload, { type FileUploadApi } from "@/components/shared/file-upload";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteProjectFile,
  listProjectFiles,
  updateProjectBrief,
  uploadProjectFile,
} from "@/lib/clients/project-client";
import type {
  WorkspaceProjectBrief,
  WorkspaceProjectFile,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";
import {
  UPLOADABLE_DOCUMENT_ACCEPT,
  UPLOADABLE_DOCUMENT_HELPER,
} from "@/lib/utils/uploadable-formats";

const projectFileApi: FileUploadApi = {
  list: listProjectFiles,
  upload: uploadProjectFile,
  delete: deleteProjectFile,
};

export function ProjectContextDetails({
  project,
  uploadRequest,
  onFilesChanged,
  initialBrief,
  initialFiles,
}: {
  project: WorkspaceProjectSummary;
  uploadRequest: number;
  onFilesChanged?: () => void | Promise<void>;
  initialBrief: WorkspaceProjectBrief;
  initialFiles: WorkspaceProjectFile[];
}) {
  const [brief, setBrief] = useState(initialBrief.content);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filesSectionRef = useRef<HTMLElement>(null);
  const active = project.status === "active";

  useEffect(() => {
    startTransition(() => {
      setBrief(initialBrief.content);
      setDraft(initialBrief.content);
      setEditing(false);
      setError(null);
    });
  }, [initialBrief.content, project.id]);

  useEffect(() => {
    if (uploadRequest === 0) return;
    const uploadButton = filesSectionRef.current?.querySelector<HTMLButtonElement>(
      'button[aria-label="Upload files"]',
    );
    uploadButton?.focus();
    uploadButton?.click();
  }, [uploadRequest]);

  const saveBrief = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProjectBrief(project.id, draft);
      setBrief(updated.content);
      setDraft(updated.content);
      setEditing(false);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 py-6 lg:grid-cols-2">
      <section className="rounded-xl border border-border/70 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-heading text-sm font-semibold">Project brief</h3>
          {!editing ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!active}
              aria-label="Edit project brief"
              onClick={() => {
                setDraft(brief);
                setEditing(true);
              }}
            >
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-3 space-y-2">
            <Textarea
              aria-label="Project brief"
              disabled={saving}
              maxLength={100_000}
              onChange={(event) => setDraft(event.target.value)}
              rows={9}
              value={draft}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(brief);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={saving}
                aria-label="Save project brief"
                onClick={() => void saveBrief()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : brief ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">{brief}</p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No brief yet. Add stable facts, constraints, and goals for this project.
          </p>
        )}
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <div className="flex flex-col gap-6">
        <section
          ref={filesSectionRef}
          className="rounded-xl border border-border/70 p-4"
        >
          <h3 className="font-heading text-sm font-semibold">Shared files</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Durable project sources. They are not added to prompts unless explicitly selected.
          </p>
          <div className="mt-3">
            <FileUpload
              ownerId={project.id}
              api={projectFileApi}
              accept={UPLOADABLE_DOCUMENT_ACCEPT}
              helperText={UPLOADABLE_DOCUMENT_HELPER}
              maxFiles={20}
              disabled={!active}
              onFilesChanged={onFilesChanged}
              initialFiles={initialFiles}
            />
          </div>
        </section>
        <ProjectSharedFolders projectId={project.id} active={active} />
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
