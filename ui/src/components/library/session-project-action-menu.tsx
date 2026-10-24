import { Folder, FolderPlus, Plus } from "lucide-react";
import { useState } from "react";

import { ProjectAssignmentDialog } from "@/components/library/project-assignment-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SessionSummary } from "@/lib/models/session-model";

export function SessionProjectActionMenu({
  session,
  onSessionUpdated,
  presentation = "icon",
}: {
  session: SessionSummary;
  onSessionUpdated: (session: SessionSummary) => void;
  presentation?: "icon" | "button";
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const iconOnly = presentation === "icon";
  return (
    <>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Project actions for ${session.title}`}
                onClick={() => setDialogOpen(true)}
              />
            }
          >
            {session.projectId ? (
              <Folder className="size-3" aria-hidden="true" />
            ) : (
              <Plus className="size-3" aria-hidden="true" />
            )}
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{session.projectId ? "Assign to Different Project" : "Add to Project"}</p>
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="ghost"
              />
            }
          >
            <FolderPlus className="size-3.5" />
            Add to Project
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <FolderPlus className="size-4" aria-hidden="true" />
              Add to Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ProjectAssignmentDialog
        open={dialogOpen}
        session={session}
        onOpenChange={setDialogOpen}
        onSessionUpdated={onSessionUpdated}
      />
    </>
  );
}
