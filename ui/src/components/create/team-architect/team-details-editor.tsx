import { FileText, Loader2, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TeamEditorController } from "./use-team-editor";

export function TeamDetailsEditor(props: {
  editor: TeamEditorController;
  onOpenYamlPreview: () => void;
  onOpenDelete: () => void;
}) {
  const { editor } = props;
  return (
    <section
      data-slot="team-details-editor"
      className="flex min-w-0 shrink-0 flex-col gap-3"
    >
      <div className="flex min-w-0 items-center justify-end gap-2">
        {editor.saved ? (
          <span className="text-xs text-muted-foreground">{editor.saved}</span>
        ) : null}
        {!editor.creating && editor.detail ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onOpenYamlPreview}
              className="h-8 gap-1.5 px-2.5 text-xs leading-none text-muted-foreground"
              aria-label="Preview team YAML"
            >
              <FileText data-icon="inline-start" className="size-3.5" />
              <span className="leading-none">Preview YAML</span>
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={props.onOpenDelete}
              disabled={!editor.canDelete}
              className="text-muted-foreground hover:text-destructive"
              aria-label="Delete team"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          onClick={() => void editor.saveTeam()}
          disabled={!editor.canSave}
        >
          {editor.saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save
        </Button>
      </div>
      <div className="min-w-0">
        {!editor.selectedTeamId && !editor.creating ? (
          <PanelEmptyState className="text-sm text-muted-foreground">
            Select a team in the sidebar to inspect it.
          </PanelEmptyState>
        ) : editor.loadingDetail ? (
          <PanelEmptyState className="text-sm text-muted-foreground">
            Loading team...
          </PanelEmptyState>
        ) : (
          <div className="grid gap-6">
            <section className="grid content-start gap-3 md:grid-cols-[7.5rem_minmax(0,1fr)]">
              <FieldLabel label="Team id / name" />
              <Input
                value={editor.draft.id}
                onChange={(event) =>
                  editor.setDraft((current) => ({
                    ...current,
                    id: event.target.value,
                  }))
                }
                disabled={editor.saving || editor.loadingDetail}
                className="h-8 text-sm"
              />
              <FieldLabel label="Description" />
              <Textarea
                value={editor.draft.description}
                onChange={(event) =>
                  editor.setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                className="min-h-20 text-sm"
              />
              <FieldLabel label="Tags" />
              <Input
                value={editor.draft.tagsInput}
                onChange={(event) =>
                  editor.setDraft((current) => ({
                    ...current,
                    tagsInput: event.target.value,
                  }))
                }
                placeholder="strategy, writing, internal"
                className="h-8 text-sm"
              />
            </section>
          </div>
        )}

        {editor.error ? (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {editor.error}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FieldLabel({ label }: { label: string }) {
  return (
    <label className="flex items-center text-xs font-medium text-muted-foreground">
      {label}
    </label>
  );
}
