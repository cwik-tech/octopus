import { useOpenAppWindow } from "@/hooks/use-open-app-window";
import { AppWindow, Ellipsis, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { ProjectAssignmentDialog } from "@/components/library/project-assignment-dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { updateSessionTitle } from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

export function SessionActionsMenu({
  session,
  onSessionUpdated,
  onDelete,
  deleting = false,
}: {
  session: SessionSummary;
  onSessionUpdated: (session: SessionSummary) => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const windowAction = useOpenAppWindow();
  const [projectOpen, setProjectOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function openRename() {
    setTitle(session.title);
    setError(null);
    setRenameOpen(true);
  }

  async function saveTitle() {
    const nextTitle = title.trim();
    if (!nextTitle || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSessionTitle(session.id, nextTitle);
      onSessionUpdated(updated);
      setRenameOpen(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Could not rename the session.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={triggerRef}
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={deleting}
              aria-label={`Session actions for ${session.title}`}
            />
          }
        >
          <Ellipsis className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-max min-w-44"
          finalFocus={renameOpen || projectOpen ? false : triggerRef}
        >
          {windowAction.available ? (
            <DropdownMenuItem disabled={windowAction.opening} onClick={() => { void windowAction.open({ kind: 'session', sessionId: session.id }); }}>
              <AppWindow className="size-4" aria-hidden="true" />Open in new window
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setProjectOpen(true)}>
            <FolderPlus className="size-4" aria-hidden="true" />
            {session.projectId ? "Assign to Different Project" : "Add to Project"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openRename}>
            <Pencil className="size-4" aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          {onDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-4" aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectAssignmentDialog
        open={projectOpen}
        onOpenChange={setProjectOpen}
        session={session}
        onSessionUpdated={onSessionUpdated}
      />
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!saving) setRenameOpen(open);
        }}
      >
        <DialogContent initialFocus={inputRef} finalFocus={triggerRef} showCloseButton={!saving}>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              // saveTitle handles request failures and keeps the dialog editable.
              void saveTitle();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
              <DialogDescription>Choose a name for this session.</DialogDescription>
            </DialogHeader>
            <label className="grid gap-2 text-sm">
              Session name
              <Input
                ref={inputRef}
                value={title}
                maxLength={200}
                disabled={saving}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setRenameOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !title.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
