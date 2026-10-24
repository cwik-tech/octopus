import { Bot, Plus, TriangleAlert, UserMinus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useProviderCatalog } from "@/contexts/provider-catalog-context";
import { ProviderModelIcon } from "@/components/ui/provider-model-icon";
import {
  PanelContent,
  PanelEmptyState,
  PanelHeader,
  PanelItem,
} from "@/components/ui/card";
import { formatRuntimeSource, resolveRosterAgentRuntime } from "./team-models";
import type { TeamEditorController } from "./use-team-editor";
import { formatDisplayName } from "@/lib/utils/display-name";
import { isModelUnresolved } from "@/lib/utils/model-catalog";
import { TeamShapeBlock } from "@/components/create/agents-and-teams/resource-creation-card";
import {
  rosterInShapeOrder,
  rosterIsNumbered,
  shapeRoleNames,
} from "@/components/create/agents-and-teams/team-shape-copy";

export function TeamRosterEditor(props: {
  editor: TeamEditorController;
  onOpenAddAgent: () => void;
  onOpenAgent: (agentName: string) => void;
}) {
  const { editor } = props;
  // The run applies the app-wide default too, so the roster must apply the same
  // state or it reports a pair the run will not use.
  const { defaultModelState } = useProviderCatalog();
  // The order a saved team's members run in, which is not the order they were
  // added in. A roster listed by insertion order describes nothing that happens.
  const shape = editor.detail?.shape;
  const order = rosterInShapeOrder(
    (editor.detail?.agents ?? []).map((agent) => agent.name),
    shape,
  );
  const orderedRoster = [...(editor.detail?.agents ?? [])].sort(
    (left, right) => order.indexOf(left.name) - order.indexOf(right.name),
  );
  const numbered = rosterIsNumbered(shape);
  return (
    <section
      data-slot="team-roster-editor"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <PanelHeader
        className="h-9 border-b-0 px-0"
        icon={<Bot className="size-3.5 text-muted-foreground" />}
        title="Agent Roster"
        actions={
          editor.detail && !editor.creating ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={props.onOpenAddAgent}
              disabled={editor.saving}
              aria-label="Add agent"
            >
              <Plus className="size-3.5" />
            </Button>
          ) : null
        }
      />
      <PanelContent className="overflow-y-auto px-0 pt-1 pb-3">
        {shape && editor.detail && !editor.creating
          ? (
            <div className="pb-3">
              {/* Offered only for a team this app wrote, because only such a
                  team has a stage it knows how to rewrite. The same block the
                  proposal card uses, so a team reopened later describes itself
                  the way it did when it was chosen. */}
              <TeamShapeBlock
                shape={shape}
                // Every member the saved shape names, which is the team's whole
                // membership — the list rendered below is filtered for display,
                // and building a change from it would describe a team missing
                // whoever is kept out of the interface.
                roster={shapeRoleNames(shape)}
                onChoose={(next) => editor.changeShape?.(next)}
                {...(editor.shapeChangePending ? { pending: true } : {})}
                {...(editor.shapeNotice ? { notice: editor.shapeNotice } : {})}
              />
            </div>
          )
          : null}
        {!editor.detail || editor.creating ? (
          <PanelEmptyState className="text-xs text-muted-foreground">
            Save a team before editing its roster.
          </PanelEmptyState>
        ) : editor.detail.agents.length === 0 ? (
          <PanelEmptyState className="text-xs text-muted-foreground">
            No agents in this team.
          </PanelEmptyState>
        ) : (
          <ul className="grid gap-2">
            {orderedRoster.map((agent, position) => {
              const runtime = resolveRosterAgentRuntime(agent, defaultModelState);
              const effectiveModel = runtime.model;
              const effectiveProvider = runtime.provider;
              const modelUnresolved =
                !!runtime.error || isModelUnresolved(effectiveModel);
              return (
                <li key={agent.name}>
                  <PanelItem className="hover:bg-muted/55">
                    <div className="flex items-start justify-between gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-w-0 flex-1 flex-col items-start justify-start gap-0 rounded-md border-0 p-0 text-left font-normal whitespace-normal hover:bg-transparent"
                        onClick={() => props.onOpenAgent(agent.name)}
                      >
                        <div className="flex items-center gap-2">
                          {numbered
                            ? (
                              <span
                                aria-hidden
                                className="text-xs tabular-nums text-muted-foreground"
                              >
                                {position + 1}
                              </span>
                            )
                            : null}
                          <span className="truncate text-sm font-medium">
                            {formatDisplayName(agent.name)}
                          </span>
                          {effectiveProvider ? (
                            <ProviderModelIcon
                              model={effectiveModel}
                              provider={effectiveProvider}
                            />
                          ) : null}
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {agent.role}
                        </p>
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => void editor.removeAgent(agent.name)}
                        disabled={editor.saving}
                        title="Remove from team roster"
                        aria-label={`Remove ${formatDisplayName(agent.name)} from team roster`}
                      >
                        <UserMinus className="size-3" />
                      </Button>
                    </div>
                    {agent.personaMissing ? (
                      <span
                        className="mt-2 inline-flex max-w-full items-center gap-1 truncate rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive"
                        title={`Persona file missing or unreadable (${
                          agent.agent_file ?? "no agent_file"
                        }). The runtime skips this agent.`}
                      >
                        <TriangleAlert className="size-3 shrink-0" />
                        Persona missing — will not run
                      </span>
                    ) : modelUnresolved ? (
                      <span
                        className="mt-2 inline-flex max-w-full items-center gap-1 truncate rounded-md bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-600 dark:text-orange-400"
                        title={
                          runtime.error?.message ??
                          `${formatRuntimeSource(runtime.source)}: no concrete model resolved`
                        }
                      >
                        <TriangleAlert className="size-3 shrink-0" />
                        Model unresolved
                      </span>
                    ) : null}
                  </PanelItem>
                </li>
              );
            })}
          </ul>
        )}
      </PanelContent>
    </section>
  );
}
