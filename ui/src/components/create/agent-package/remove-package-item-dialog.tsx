import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PendingRemoval } from "./types";

export function RemovePackageItemDialog(props: {
  pendingRemoval: PendingRemoval | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  return (
    <Dialog
      open={props.pendingRemoval !== null}
      onOpenChange={props.onOpenChange}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove package item</DialogTitle>
          <DialogDescription>
            Choose whether to disconnect this item from the agent or delete the
            package copy from disk.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
          {props.pendingRemoval?.label}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={props.onDisconnect}
          >
            Disconnect
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={props.busy}
            onClick={props.onDelete}
          >
            {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Delete from disk
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
