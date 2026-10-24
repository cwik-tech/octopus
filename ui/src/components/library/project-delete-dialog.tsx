import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  WorkspaceProjectDeleteMode,
  WorkspaceProjectSummary,
} from "@/lib/models/session-model";

export function ProjectDeleteDialog({
  open,
  project,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  project: WorkspaceProjectSummary | null;
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (mode: WorkspaceProjectDeleteMode) => void;
}) {
  if (!project) return null;

  return (
    <ProjectDeleteDialogContent
      key={`${project.id}:${open}`}
      open={open}
      project={project}
      pending={pending}
      error={error}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  );
}

function ProjectDeleteDialogContent({
  open,
  project,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  project: WorkspaceProjectSummary;
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (mode: WorkspaceProjectDeleteMode) => void;
}) {
  const [mode, setMode] = useState<WorkspaceProjectDeleteMode>(
    "ungroup_sessions",
  );
  const sessionLabel = `${project.sessionCount} ${
    project.sessionCount === 1 ? "session" : "sessions"
  }`;

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete “{project.name}”? Project files,
            brief, and memory will be permanently deleted.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2" disabled={pending}>
          <legend className="sr-only">Session data handling</legend>
          <DeleteModeOption
            checked={mode === "ungroup_sessions"}
            description={`Keep ${sessionLabel}, chats, runs, and artifacts available without a project.`}
            label="Leave session data ungrouped"
            value="ungroup_sessions"
            onChange={setMode}
          />
          <DeleteModeOption
            checked={mode === "delete_sessions"}
            description={`Permanently delete ${sessionLabel}, including chats, runs, files, and artifacts.`}
            label="Delete all data and chats"
            value="delete_sessions"
            onChange={setMode}
          />
        </fieldset>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => onConfirm(mode)}
          >
            {pending ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteModeOption({
  checked,
  description,
  label,
  value,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  value: WorkspaceProjectDeleteMode;
  onChange: (value: WorkspaceProjectDeleteMode) => void;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border border-border/70 p-3 has-checked:border-primary has-checked:bg-primary/5">
      <input
        type="radio"
        name="project-delete-mode"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-0.5 size-4 accent-primary"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}
