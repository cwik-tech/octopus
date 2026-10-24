import { startTransition, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export interface ProjectEditorValue {
  name: string;
  description?: string;
}

export function ProjectEditorDialog({
  open,
  initialValue,
  pending,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initialValue?: { name: string; description?: string | undefined } | undefined;
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: ProjectEditorValue) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const editing = initialValue !== undefined;

  useEffect(() => {
    if (!open) return;
    startTransition(() => {
      setName(initialValue?.name ?? "");
      setDescription(initialValue?.description ?? "");
    });
  }, [initialValue, open]);

  const title = editing ? "Edit project" : "New project";
  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the project name and description."
              : "Create a durable home for related sessions and files."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedName = name.trim();
            if (!trimmedName) return;
            onSubmit({
              name: trimmedName,
              ...(description.trim() ? { description: description.trim() } : {}),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Project name</span>
            <Input
              aria-label="Project name"
              autoFocus
              disabled={pending}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Description</span>
            <Textarea
              aria-label="Description"
              disabled={pending}
              maxLength={2_000}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              value={description}
            />
          </label>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending
                ? editing
                  ? "Saving…"
                  : "Creating…"
                : editing
                  ? "Save changes"
                  : "Create project"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
