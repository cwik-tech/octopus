import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TeamEditorController } from "./use-team-editor";
import { formatDisplayName } from "@/lib/utils/display-name";

export function DeleteTeamDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editor: TeamEditorController;
  agentsToDelete: Set<string>;
  onAgentsToDeleteChange: (agents: Set<string>) => void;
}) {
  const { editor } = props;

  function changeOpen(open: boolean) {
    if (editor.saving) return;
    props.onOpenChange(open);
    if (!open) props.onAgentsToDeleteChange(new Set());
  }

  async function deleteTeam() {
    await editor.deleteTeam(Array.from(props.agentsToDelete), () => {
      props.onAgentsToDeleteChange(new Set());
      props.onOpenChange(false);
    });
  }

  return (
    <Dialog open={props.open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Delete team?</DialogTitle>
          <DialogDescription>
            Delete{" "}
            {editor.selectedTeamId
              ? formatDisplayName(editor.selectedTeamId)
              : "this team"}. Roster agents are kept
            unless you explicitly select them below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Selected agents will be deleted completely, including their agent
            folders and owned skills. Leave agents unchecked to keep them in the
            library.
          </div>

          {editor.rosterAgentsForDelete.length === 0 ? (
            <PanelEmptyState className="text-xs text-muted-foreground">
              This team has no roster agents to delete.
            </PanelEmptyState>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border/70">
              {editor.rosterAgentsForDelete.map((agent) => {
                const selected = props.agentsToDelete.has(agent.name);
                const libraryAgent = editor.agents.find(
                  (candidate) => candidate.name === agent.name,
                );
                const otherTeams =
                  libraryAgent?.usedInTeams.filter(
                    (team) => team.teamId !== editor.selectedTeamId,
                  ) ?? [];
                return (
                  <label
                    key={agent.name}
                    className="flex items-start gap-3 border-b border-border/50 px-3 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={editor.saving}
                      onChange={(event) => {
                        const next = new Set(props.agentsToDelete);
                        if (event.target.checked) next.add(agent.name);
                        else next.delete(agent.name);
                        props.onAgentsToDeleteChange(next);
                      }}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {formatDisplayName(agent.name)}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                        {agent.role || "No role description."}
                      </span>
                      {otherTeams.length > 0 ? (
                        <span className="mt-1 block text-xs text-destructive">
                          Also used in{" "}
                          {otherTeams
                            .map((team) => formatDisplayName(team.teamName))
                            .join(", ")}.
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose
            render={<Button variant="outline" disabled={editor.saving} />}
          >
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => void deleteTeam()}
            disabled={!editor.canDelete}
          >
            {editor.saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {props.agentsToDelete.size > 0
              ? `Delete team and ${props.agentsToDelete.size} agent${
                  props.agentsToDelete.size === 1 ? "" : "s"
                }`
              : "Delete team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
