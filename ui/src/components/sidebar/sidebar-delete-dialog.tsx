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

export interface SidebarDeleteTarget {
  label: string;
  allowSkipConfirmation: boolean;
}

interface SidebarDeleteDialogProps {
  target: SidebarDeleteTarget | null;
  deleting?: boolean;
  error?: string | null;
  onConfirm: (neverAskAgain: boolean) => void;
  onOpenChange: (open: boolean) => void;
}

export function SidebarDeleteDialog({
  target,
  deleting = false,
  error = null,
  onConfirm,
  onOpenChange,
}: SidebarDeleteDialogProps) {
  if (!target) return null;

  return (
    <SidebarDeleteDialogContent
      key={`${target.label}:${target.allowSkipConfirmation}`}
      target={target}
      deleting={deleting}
      error={error}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
    />
  );
}

function SidebarDeleteDialogContent({
  target,
  deleting,
  error,
  onConfirm,
  onOpenChange,
}: Omit<SidebarDeleteDialogProps, "target"> & {
  target: SidebarDeleteTarget;
}) {
  const [neverAskAgain, setNeverAskAgain] = useState(false);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!deleting}>
        <DialogHeader>
          <DialogTitle>Delete {target.label}?</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete {target.label}?
          </DialogDescription>
        </DialogHeader>

        {target.allowSkipConfirmation ? (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={neverAskAgain}
              disabled={deleting}
              onChange={(event) => setNeverAskAgain(event.target.checked)}
              className="size-4 accent-primary"
            />
            Never ask again for session deletion
          </label>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={deleting} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => onConfirm(neverAskAgain)}
          >
            {deleting ? "Deleting…" : "Yes, delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
