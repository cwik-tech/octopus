import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";

import { AgentToolsPanel } from "@/components/create/agent-tools-panel";
import { Button } from "@/components/ui/button";
import { PanelContent, PanelHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { formatDisplayName } from "@/lib/utils/display-name";
import { cn } from "@/lib/utils/utils";
import type { AgentAssetKind } from "@/lib/models/agent-generator-model";
import { AgentAssetSection } from "./agent-asset-section";
import { AgentAssetsTab } from "./agent-assets-tab";
import { AgentModelSelect } from "./agent-model-select";
import { AgentEffortSelect } from "./agent-effort-select";
import { AgentPersonaTab } from "./agent-persona-tab";
import { AgentSkillsTab } from "./agent-skills-tab";
import { AgentUsageTab } from "./agent-usage-tab";
import {
  applyPersonaWebResearch,
  applyPersonaBrowserDomains,
  applyPersonaBrowserDomainsRestricted,
  applyPersonaGenerateExcel,
  applyPersonaGenerateWord,
  parsePersonaWebResearch,
  parsePersonaBrowserDomains,
  parsePersonaBrowserDomainsRestricted,
  parsePersonaGenerateExcel,
  parsePersonaGenerateWord,
} from "./persona-frontmatter";
import { ImportPreviewDialog } from "./import-preview-dialog";
import { RemovePackageItemDialog } from "./remove-package-item-dialog";
import { CountTab } from "./count-tab";
import type { AgentPackageEditorProps } from "./types";
import { useAgentPackageActions } from "./use-agent-package-actions";

export default function AgentPackageEditor(props: AgentPackageEditorProps) {
  const actions = useAgentPackageActions(props);
  const counts = props.agentDetail?.counts;
  const contextCount =
    (counts?.experience ?? 0) +
    (counts?.knowledge ?? 0) +
    (counts?.other ?? 0);
  const usageCount = props.agentDetail?.usedInTeams.length ?? 0;
  const webResearchEnabled = useMemo(
    () => parsePersonaWebResearch(props.personaMarkdown),
    [props.personaMarkdown],
  );
  const browserDomainsRestricted = useMemo(
    () => parsePersonaBrowserDomainsRestricted(props.personaMarkdown),
    [props.personaMarkdown],
  );
  const browserDomains = useMemo(
    () => parsePersonaBrowserDomains(props.personaMarkdown),
    [props.personaMarkdown],
  );
  const generateWordEnabled = useMemo(
    () => parsePersonaGenerateWord(props.personaMarkdown),
    [props.personaMarkdown],
  );
  const generateExcelEnabled = useMemo(
    () => parsePersonaGenerateExcel(props.personaMarkdown),
    [props.personaMarkdown],
  );
  const templates = useMemo(
    () => filterAssets(props.agentDetail, "template"),
    [props.agentDetail],
  );
  const references = useMemo(
    () => filterAssets(props.agentDetail, "reference"),
    [props.agentDetail],
  );
  const scripts = useMemo(
    () => filterAssets(props.agentDetail, "script"),
    [props.agentDetail],
  );
  const context = useMemo(
    () =>
      (props.agentDetail?.assets ?? []).filter((asset) =>
        ["experience", "knowledge", "other"].includes(asset.kind),
      ),
    [props.agentDetail],
  );
  const assetActions = {
    onRevealAsset: actions.revealAsset,
    onStartImport: actions.startImport,
    onRequestRemove: actions.requestRemoval,
    packageBusyKey: actions.packageBusyKey,
    revealError: actions.revealError,
    packageError: actions.packageError,
    agentSelected: !!props.agentName,
  };
  const saveToolChange = (markdown: string) => {
    props.onPersonaChange(markdown);
    // Save the event's value directly, before React updates the editor props.
    void props.onSave(markdown);
  };

  return (
    <Tabs
      defaultValue="persona"
      className={cn("min-h-0 flex-1 gap-0", props.className)}
    >
      {props.agentName ? (
        // Wraps rather than overflows. The Agent pane is narrow, and two
        // fixed-width controls beside the name were wider than it, so the name
        // collapsed and the row scrolled sideways. The controls carry the width
        // they want as a flex basis, which is what lets them drop to their own
        // line when the name leaves no room for it: there they have the pane to
        // themselves and both labels stay readable.
        <div
          data-slot="agent-editor-header"
          className="flex min-w-0 shrink-0 flex-wrap items-center gap-2"
        >
          {props.back ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={props.back.label}
              onClick={props.back.onClick}
              className="-ml-1.5"
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {formatDisplayName(props.agentName)}
          </span>
          {props.personaMarkdown ? (
            <div className="flex min-w-0 basis-96 grow items-center justify-end gap-2">
              <AgentModelSelect
                agentName={props.agentName}
                personaMarkdown={props.personaMarkdown}
                onPersonaChange={(personaMarkdown) => {
                  // A model change is saved at once. There is no Save button.
                  props.onPersonaChange(personaMarkdown);
                  void props.onSave(personaMarkdown);
                }}
                className="h-7 min-w-0 max-w-56 flex-1"
              />
              <AgentEffortSelect
                personaMarkdown={props.personaMarkdown}
                onPersonaChange={(personaMarkdown) => {
                  // Saved on change, like the model beside it. The two are one
                  // decision about how this agent runs, and a Save button on one
                  // of them and not the other would be a trap.
                  props.onPersonaChange(personaMarkdown);
                  void props.onSave(personaMarkdown);
                }}
                className="h-7 min-w-0 max-w-40 flex-1"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <PanelHeader className="h-auto min-h-12 items-center justify-start border-b-0 px-0 py-2">
        <TabsList
          variant="line"
          className="h-auto w-full flex-nowrap justify-start gap-0 overflow-x-auto overflow-y-hidden scrollbar-none"
        >
          <CountTab value="persona" label="Persona" />
          <CountTab value="skills" label="Skills" count={counts?.skills ?? 0} />
          <CountTab value="tools" label="Tools" count={counts?.scripts ?? 0} />
          <CountTab
            value="templates"
            label="Templates"
            count={counts?.templates ?? 0}
          />
          <CountTab
            value="references"
            label="References"
            count={counts?.references ?? 0}
          />
          <CountTab value="context" label="Context" count={contextCount} />
          <CountTab value="usage" label="Usage" count={usageCount} />
        </TabsList>
      </PanelHeader>

      <PanelContent className="flex min-h-0 flex-1 flex-col">
        <AgentPersonaTab
          agentName={props.agentName}
          personaPath={props.agentDetail?.personaPath ?? null}
          personaMarkdown={props.personaMarkdown}
          savedPersonaMarkdown={props.savedPersonaMarkdown}
          onPersonaChange={props.onPersonaChange}
          dirty={props.dirty}
          saving={props.saving}
          saved={props.saved}
          saveError={props.saveError}
          onSave={props.onSave}
        />
        <AgentSkillsTab
          agentName={props.agentName}
          agentDetail={props.agentDetail}
          {...assetActions}
        />
        <AgentAssetsTab
          value="templates"
          assets={templates}
          empty="No templates."
          {...assetActions}
        />
        <AgentAssetsTab
          value="references"
          assets={references}
          empty="No references."
          {...assetActions}
        />
        <TabsContent value="tools" className="flex min-h-0 flex-1 overflow-hidden">
          <AgentToolsPanel
            agentName={props.agentName}
            webResearchEnabled={webResearchEnabled}
            personaAvailable={!!props.personaMarkdown}
            browserDomainsRestricted={browserDomainsRestricted}
            browserDomains={browserDomains}
            generateWordEnabled={generateWordEnabled}
            generateExcelEnabled={generateExcelEnabled}
            savingPersona={props.saving}
            saveError={props.saveError}
            onWebResearchEnabledChange={(checked) => {
              if (!props.personaMarkdown) return;
              const markdown = applyPersonaWebResearch(props.personaMarkdown, checked);
              saveToolChange(markdown);
            }}
            onBrowserDomainsRestrictedChange={(checked) => {
              if (!props.personaMarkdown) return;
              const markdown = applyPersonaBrowserDomainsRestricted(props.personaMarkdown, checked);
              saveToolChange(markdown);
            }}
            onBrowserDomainsChange={(domains) => {
              if (!props.personaMarkdown) return;
              props.onPersonaChange(
                applyPersonaBrowserDomains(props.personaMarkdown, domains),
              );
            }}
            onGenerateWordEnabledChange={(checked) => {
              if (!props.personaMarkdown) return;
              const markdown = applyPersonaGenerateWord(props.personaMarkdown, checked);
              saveToolChange(markdown);
            }}
            onGenerateExcelEnabledChange={(checked) => {
              if (!props.personaMarkdown) return;
              const markdown = applyPersonaGenerateExcel(props.personaMarkdown, checked);
              saveToolChange(markdown);
            }}
            onBrowserDomainsBlur={() => {
              if (!props.saving) {
                // Disabling the focused input during a save may also blur it.
                void props.onSave();
              }
            }}
            scripts={
              <AgentAssetSection
                kind="script"
                assets={scripts}
                empty="No scripts."
                {...assetActions}
              />
            }
          />
        </TabsContent>
        <AgentAssetsTab
          value="context"
          assets={context}
          empty="No context files."
          {...assetActions}
        />
        <AgentUsageTab agentDetail={props.agentDetail} />
      </PanelContent>

      <RemovePackageItemDialog
        pendingRemoval={actions.pendingRemoval}
        busy={actions.packageBusyKey?.startsWith("remove:") ?? false}
        onOpenChange={(open) => {
          if (!open) actions.closeRemoval();
        }}
        onDisconnect={() => void actions.confirmRemoval("disconnect")}
        onDelete={() => void actions.confirmRemoval("delete")}
      />
      <ImportPreviewDialog
        draft={actions.importDraft}
        choices={actions.importChoices}
        busy={actions.packageBusyKey?.startsWith("import:") ?? false}
        onChoiceChange={actions.updateImportChoice}
        onOpenChange={(open) => {
          if (!open) actions.closeImport();
        }}
        onConfirm={() => void actions.confirmImport()}
      />
    </Tabs>
  );
}

function filterAssets(
  agentDetail: AgentPackageEditorProps["agentDetail"],
  kind: AgentAssetKind,
) {
  return (agentDetail?.assets ?? []).filter((asset) => asset.kind === kind);
}
