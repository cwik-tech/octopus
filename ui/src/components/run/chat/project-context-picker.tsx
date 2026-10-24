import { FolderInput, Loader2 } from "lucide-react";
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
  getProjectBrief,
  listProjectFiles,
} from "@/lib/clients/project-client";
import type {
  WorkspaceProjectContextSelection,
  WorkspaceProjectFile,
} from "@/lib/models/session-model";

export function ProjectContextPicker({
  projectId,
  value,
  disabled = false,
  onChange,
}: {
  projectId?: string;
  value?: WorkspaceProjectContextSelection | undefined;
  disabled?: boolean;
  onChange: (selection: WorkspaceProjectContextSelection | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [briefAvailable, setBriefAvailable] = useState(false);
  const [files, setFiles] = useState<WorkspaceProjectFile[]>([]);
  const [includeBrief, setIncludeBrief] = useState(false);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    startTransition(() => {
      setBriefAvailable(false);
      setFiles([]);
      setLoading(true);
      setError(null);
    });
    void Promise.all([getProjectBrief(projectId), listProjectFiles(projectId)])
      .then(([brief, nextFiles]) => {
        if (cancelled) return;
        setBriefAvailable(brief.content.trim().length > 0);
        setFiles(nextFiles);
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
  }, [open, projectId]);

  if (!projectId) return null;

  const selectedCount = (value?.includeBrief ? 1 : 0) + (value?.fileNames.length ?? 0);
  const openPicker = () => {
    setIncludeBrief(value?.projectId === projectId && value.includeBrief);
    setFileNames(value?.projectId === projectId ? value.fileNames : []);
    setOpen(true);
  };
  const apply = () => {
    onChange(
      includeBrief || fileNames.length > 0
        ? { projectId, includeBrief, fileNames: [...fileNames].sort() }
        : undefined,
    );
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant={selectedCount > 0 ? "secondary" : "ghost"}
        disabled={disabled}
        aria-label={
          selectedCount > 0
            ? `Project context, ${selectedCount} selected`
            : "Add project context"
        }
        onClick={openPicker}
      >
        <FolderInput aria-hidden="true" />
        {selectedCount > 0
          ? `Project context · ${selectedCount}`
          : "Add project context"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Project context</DialogTitle>
            <DialogDescription>
              Select references for the next message. Nothing is included by default.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div role="status" className="flex items-center gap-2 py-4 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading project references…
            </div>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto">
              <ContextCheckbox
                checked={includeBrief}
                disabled={!briefAvailable}
                label="Project brief"
                note={briefAvailable ? undefined : "No brief available"}
                onChange={setIncludeBrief}
              />
              {files.map((file) => (
                <ContextCheckbox
                  key={file.name}
                  checked={fileNames.includes(file.name)}
                  label={file.name}
                  note={file.parseStatus === "parsed" ? undefined : file.parseStatus}
                  onChange={(checked) =>
                    setFileNames((current) =>
                      checked
                        ? [...new Set([...current, file.name])]
                        : current.filter((name) => name !== file.name),
                    )
                  }
                />
              ))}
              {!briefAvailable && files.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  This project has no brief or shared files yet.
                </p>
              ) : null}
            </div>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              disabled={loading || Boolean(error)}
              onClick={apply}
            >
              Apply project context
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ContextCheckbox({
  checked,
  disabled = false,
  label,
  note,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  note?: string | undefined;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className="size-4 accent-primary"
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </label>
  );
}
