import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AgentDuplicateDialog from "@/components/create/agent-duplicate-dialog";
import AgentNameApprovalDialog from "@/components/create/agent-name-approval-dialog";
import AgentPackageEditor from "@/components/create/agent-package-editor";
import SkillsTreePicker from "@/components/create/skills-tree-picker";
import WorkflowGeneratorChat from "@/components/create/workflow-generator-chat";
import { ChatWorkspace } from "@/components/shared/chat-shell";
import { WorkspaceRightSidebarContent } from "@/components/sidebar/workspace-right-sidebar";
import { PanelContent } from "@/components/ui/card";
import {
  repairPlaceholderAgentDraft,
  repairSkillPathsForDraft,
} from "@/lib/utils/agent-draft-inference";
import { fetchChatDefaults } from "@/lib/clients/chat-defaults-client";
import {
  cancelAgentJob,
  commitAgentPackageImport,
  commitAgent,
  draftAgent,
  listAgents,
  previewAgentPackageImport,
  readAgentPersona,
  refineAgent,
  removeAgentPackageItem,
  revealAgentAsset,
  saveAgentPersona,
} from "@/lib/clients/agent-generator-client";
import type {
  ChatTurn,
  AgentDetail,
  AgentPackageAddKind,
  AgentPackageFileInput,
  AgentPackageImportChoice,
  AgentPackageImportItem,
  AgentPackageRemoveMode,
  DraftAgentResponse,
  RefineAgentResponse,
} from "@/lib/models/agent-generator-model";
import {
  DEFAULT_MODEL_CHOICE,
  type ModelChoice,
} from "@/lib/utils/model-catalog";
import { formatDisplayName } from "@/lib/utils/display-name";
import { parsePersonaModel } from "@/components/create/agent-package/persona-frontmatter";

const HEADER_HEIGHT_REM = 2.75;

interface AgentArchitectPanelProps {
  agentSelectionRequest?: {
    id: string;
    agentName: string;
  } | null;
  detailsOpen?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onResourcesChanged?: (() => Promise<void> | void) | undefined;
  /** Reserved vertical offset above the panel (segmented control bar). */
  topOffsetRem?: number;
  /** Render only the existing Agent inspector for the unified resource workspace. */
  detailsOnly?: boolean;
  /** A way back to whatever opened this agent, e.g. the Team whose roster it is in. */
  back?: { label: string; onClick: () => void };
}

interface PendingDraft {
  jobId: string;
  suggestedName: string;
  personaMarkdown: string;
  skillPaths: string[];
  generatedSkills?: Array<{ name: string; body: string }> | undefined;
  allowOverwrite?: boolean;
  overwriteTargetName?: string | undefined;
}

export default function AgentArchitectPanel({
  agentSelectionRequest,
  detailsOpen = true,
  detailsOnly = false,
  back,
  onDirtyChange,
  onResourcesChanged,
  topOffsetRem = 0,
}: AgentArchitectPanelProps) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState<ModelChoice>(DEFAULT_MODEL_CHOICE);
  const activeJobIdRef = useRef<string | null>(null);

  const [agentRefreshKey, setAgentRefreshKey] = useState(0);
  const [reservedNames, setReservedNames] = useState<Set<string>>(new Set());

  const [skillsPath, setSkillsPath] = useState("");
  const [selectedSkillPaths, setSelectedSkillPaths] = useState<Set<string>>(
    new Set(),
  );
  const [creating, setCreating] = useState(false);

  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(
    null,
  );
  const [selectedAgentDetail, setSelectedAgentDetail] =
    useState<AgentDetail | null>(null);
  const [persona, setPersona] = useState<string | null>(null);
  const [personaBaseline, setPersonaBaseline] = useState<string | null>(null);
  const [personaDirty, setPersonaDirty] = useState(false);
  const [savingPersona, setSavingPersona] = useState(false);
  const [savedPersona, setSavedPersona] = useState<{
    personaPath: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const [duplicateMatch, setDuplicateMatch] = useState<{
    existingAgentName: string;
    skillPaths: string[];
  } | null>(null);

  useEffect(() => {
    if (detailsOnly) return;
    let cancelled = false;
    void fetchChatDefaults()
      .then((defaults) => {
        if (!cancelled) setChatModel(defaults.agent);
      })
      .catch((error) => {
        console.warn(
          "Failed to load agent chat model default",
          error instanceof Error ? error.message : error,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [detailsOnly]);

  // Keep the "reserved names" set fresh so the name-approval dialog can flag
  // collisions and the duplicate-detector has full context.
  useEffect(() => {
    if (detailsOnly) return;
    let cancelled = false;
    void listAgents({ includeHidden: true })
      .then((agents) => {
        if (cancelled) return;
        setReservedNames(new Set(agents.map((agent) => agent.name)));
      })
      .catch(() => {
        if (cancelled) return;
        setReservedNames(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [agentRefreshKey, detailsOnly]);

  useEffect(() => {
    onDirtyChange?.(personaDirty);
  }, [onDirtyChange, personaDirty]);

  const handleToggleSkill = useCallback((path: string, selected: boolean) => {
    setSelectedSkillPaths((current) => {
      const next = new Set(current);
      if (selected) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const startJob = useCallback(() => {
    const jobId = crypto.randomUUID();
    activeJobIdRef.current = jobId;
    setActiveJobId(jobId);
    setSubmitting(true);
    setStopping(false);
    setChatError(null);
    return jobId;
  }, []);

  const finishJob = useCallback((jobId: string) => {
    if (activeJobIdRef.current !== jobId) return;
    activeJobIdRef.current = null;
    setActiveJobId(null);
    setSubmitting(false);
    setStopping(false);
  }, []);

  const handleStop = useCallback(async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId || stopping) return;
    activeJobIdRef.current = null;
    setActiveJobId(null);
    setSubmitting(false);
    setStopping(false);
    setHistory((current) => [
      ...current,
      { role: "assistant", text: "Generation stopped." },
    ]);
    try {
      await cancelAgentJob(jobId);
    } catch (error) {
      console.warn(
        "Failed to cancel agent generation job",
        error instanceof Error ? error.message : error,
      );
    }
  }, [stopping]);

  const runDraft = useCallback(
    async (
      skillPaths: string[],
      chatHistory: ChatTurn[],
      duplicatePolicy?: "overwrite" | "duplicate",
    ): Promise<DraftAgentResponse | null> => {
      const jobId = startJob();
      setCreating(true);
      try {
        const result = await draftAgent({
          jobId,
          skillPaths,
          chatHistory,
          duplicatePolicy,
          provider: chatModel.provider,
          model: chatModel.model,
        });
        if (activeJobIdRef.current !== jobId) return null;
        return result;
      } catch (error) {
        if (activeJobIdRef.current !== jobId) return null;
        setChatError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        finishJob(jobId);
        setCreating(false);
      }
    },
    [chatModel, finishJob, startJob],
  );

  const handleDraftFlow = useCallback(
    async (
      duplicatePolicy?: "overwrite" | "duplicate",
      overrideHistory?: ChatTurn[],
      overwriteTargetName?: string,
    ) => {
      const skillPaths = Array.from(selectedSkillPaths);
      const chatHistory = overrideHistory ?? history;
      const result = await runDraft(skillPaths, chatHistory, duplicatePolicy);
      if (!result) return;
      if ("cancelled" in result && result.cancelled) {
        setHistory((current) => [
          ...current,
          { role: "assistant", text: "Generation stopped." },
        ]);
        return;
      }
      if ("duplicate" in result && result.duplicate) {
        setDuplicateMatch({
          existingAgentName: result.duplicate.existingAgentName,
          skillPaths,
        });
        return;
      }
      if ("needsInput" in result && result.needsInput) {
        setHistory((current) => [
          ...current,
          { role: "assistant", text: result.message },
        ]);
        return;
      }
      const draft = repairPlaceholderAgentDraft(result, chatHistory) as Extract<
        DraftAgentResponse,
        { suggestedName: string }
      >;
      if (draft.meta?.fallback && !draft.generatedSkills?.length) {
        setChatError(draft.meta.reason ?? "Agent architect is offline.");
      }
      const skillCount = draft.generatedSkills?.length ?? 0;
      const skillPhrase =
        skillCount > 0
          ? ` with ${skillCount} new skill${skillCount === 1 ? "" : "s"}`
          : "";
      setHistory((current) => [
        ...current,
        {
          role: "assistant",
          text:
            `Drafted persona for **${draft.suggestedName}**${skillPhrase}. ` +
            "Review the suggested name and the persona body, then confirm to save.",
        },
      ]);
      setPendingDraft({
        jobId: draft.jobId,
        suggestedName:
          duplicatePolicy === "overwrite" && overwriteTargetName
            ? overwriteTargetName
            : nextAvailableName(draft.suggestedName, reservedNames),
        personaMarkdown: draft.personaMarkdown,
        skillPaths: repairSkillPathsForDraft(skillPaths, draft),
        generatedSkills: draft.generatedSkills,
        allowOverwrite: duplicatePolicy === "overwrite" && !!overwriteTargetName,
        overwriteTargetName,
      });
    },
    [history, reservedNames, runDraft, selectedSkillPaths],
  );

  const handleCreate = useCallback(() => {
    void handleDraftFlow();
  }, [handleDraftFlow]);

  const handleDuplicateOverwrite = useCallback(() => {
    if (!duplicateMatch) return;
    const overwriteTargetName = duplicateMatch.existingAgentName;
    setDuplicateMatch(null);
    void handleDraftFlow("overwrite", undefined, overwriteTargetName);
  }, [duplicateMatch, handleDraftFlow]);

  const handleDuplicateDuplicate = useCallback(() => {
    if (!duplicateMatch) return;
    setDuplicateMatch(null);
    void handleDraftFlow("duplicate");
  }, [duplicateMatch, handleDraftFlow]);

  const handleConfirmName = useCallback(
    async (approvedName: string) => {
      if (!pendingDraft) return;
      setCreating(true);
      try {
        const isOverwrite =
          pendingDraft.allowOverwrite === true &&
          pendingDraft.overwriteTargetName === approvedName &&
          reservedNames.has(approvedName);
        const result = await commitAgent({
          approvedName,
          personaMarkdown: pendingDraft.personaMarkdown,
          skillPaths: pendingDraft.skillPaths,
          generatedSkills: pendingDraft.generatedSkills,
          overwrite: isOverwrite,
        });
        const detail = await readAgentPersona({ agentName: result.agentName });
        setPendingDraft(null);
        setSelectedSkillPaths(new Set());
        setSelectedAgentName(result.agentName);
        setSelectedAgentDetail(detail);
        setPersona(detail.personaMarkdown);
        setPersonaBaseline(detail.personaMarkdown);
        setPersonaDirty(false);
        setSavedPersona({ personaPath: detail.personaPath });
        setSaveError(null);
        setAgentRefreshKey((k) => k + 1);
        await onResourcesChanged?.();
        setHistory((current) => [
          ...current,
          {
            role: "assistant",
            text: `Saved agent \`${result.agentName}\` to \`${detail.agentPath}\`.`,
          },
        ]);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreating(false);
      }
    },
    [onResourcesChanged, pendingDraft, reservedNames],
  );

  const handleSubmitChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const nextHistory: ChatTurn[] = [
        ...history,
        { role: "user", text: trimmed },
      ];
      setHistory(nextHistory);
      setChatError(null);

      // The production mount is details-only; a selected Agent always receives
      // a refinement directive in this legacy panel.
      if (selectedAgentName && persona !== null) {
        const jobId = startJob();
        try {
          const result: RefineAgentResponse = await refineAgent({
            jobId,
            agentName: selectedAgentName,
            currentPersona: persona,
            chatHistory: nextHistory,
            provider: chatModel.provider,
            model: chatModel.model,
          });
          if (activeJobIdRef.current !== jobId) return;
          if ("cancelled" in result && result.cancelled) {
            setHistory((current) => [
              ...current,
              { role: "assistant", text: "Refinement stopped." },
            ]);
            return;
          }
          const refined = result as Extract<
            RefineAgentResponse,
            { personaMarkdown: string }
          >;
          if (refined.meta?.fallback) {
            setChatError(refined.meta.reason ?? "Agent architect is offline.");
          }
          setPersona(refined.personaMarkdown);
          setSelectedAgentDetail((current) =>
            current
              ? { ...current, personaMarkdown: refined.personaMarkdown }
              : current,
          );
          setPersonaDirty(true);
          setSavedPersona(null);
          setHistory((current) => [
            ...current,
            { role: "assistant", text: refined.message },
          ]);
        } catch (error) {
          if (activeJobIdRef.current !== jobId) return;
          setChatError(error instanceof Error ? error.message : String(error));
        } finally {
          finishJob(jobId);
        }
        return;
      }

      // No selected Agent: preserve the ordinary direct-draft flow.
      await handleDraftFlow(undefined, nextHistory);
    },
    [
      chatModel,
      finishJob,
      handleDraftFlow,
      history,
      persona,
      selectedAgentName,
      startJob,
    ],
  );

  // Depend on the request's stable scalars, not its object identity: parents
  // may recreate an equal request on unrelated re-renders, and reloading the
  // saved persona then would discard unsaved edits (e.g. a provider switch).
  const selectionRequestId = agentSelectionRequest?.id ?? null;
  const selectionAgentName = agentSelectionRequest?.agentName ?? null;
  useEffect(() => {
    if (!selectionRequestId || !selectionAgentName) return;
    let cancelled = false;
    void readAgentPersona({ agentName: selectionAgentName })
      .then((detail) => {
        if (cancelled) return;
        setSelectedAgentName(selectionAgentName);
        setSelectedAgentDetail(detail);
        setPersona(detail.personaMarkdown);
        setPersonaBaseline(detail.personaMarkdown);
        setPersonaDirty(false);
        setSavedPersona(null);
        setSaveError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setSaveError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectionAgentName, selectionRequestId]);

  const handlePersonaChange = useCallback((value: string) => {
    setPersona(value);
    setPersonaDirty(true);
    setSavedPersona(null);
  }, []);

  // Saves can overlap: leaving the text saves it, and a model picked right
  // after saves again. Each save compares against what is on screen now, not
  // what was on screen when it started.
  const personaRef = useRef(persona);
  useEffect(() => {
    personaRef.current = persona;
  }, [persona]);
  const handleSavePersona = useCallback(async (markdown?: string) => {
    const saving = markdown ?? persona;
    if (!selectedAgentName || saving === null) return;
    setSavingPersona(true);
    setSaveError(null);
    try {
      const savedModel = parsePersonaModel(saving);
      await saveAgentPersona({
        agentName: selectedAgentName,
        personaMarkdown: saving,
      });
      setSavedPersona({
        personaPath:
          selectedAgentDetail?.personaPath ?? `${selectedAgentName}.md`,
      });
      setPersonaDirty(personaRef.current !== saving);
      setPersonaBaseline(saving);
      setSelectedAgentDetail((current) =>
        current
          ? {
              ...current,
              frontmatter: {
                ...current.frontmatter,
                model: savedModel.model,
                provider: savedModel.provider,
              },
              model: savedModel.model,
              personaMarkdown: saving,
              provider: savedModel.provider,
            }
          : current,
      );
      setAgentRefreshKey((k) => k + 1);
      await onResourcesChanged?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPersona(false);
    }
  }, [
    onResourcesChanged,
    persona,
    selectedAgentDetail,
    selectedAgentName,
  ]);

  const applySelectedAgentDetail = useCallback(
    (detail: AgentDetail) => {
      setSelectedAgentDetail((current) => {
        if (!current || current.name !== detail.name) return detail;
        return personaDirty
          ? { ...detail, personaMarkdown: current.personaMarkdown }
          : detail;
      });
      if (!personaDirty) {
        setPersona(detail.personaMarkdown);
        setPersonaBaseline(detail.personaMarkdown);
      }
      setAgentRefreshKey((k) => k + 1);
    },
    [personaDirty],
  );

  const handlePreviewPackageImport = useCallback(
    async (
      kind: AgentPackageAddKind,
      files: AgentPackageFileInput[],
    ): Promise<AgentPackageImportItem[]> => {
      if (!selectedAgentName) return [];
      const result = await previewAgentPackageImport({
        agentName: selectedAgentName,
        kind,
        files,
      });
      return result.items;
    },
    [selectedAgentName],
  );

  const handleCommitPackageImport = useCallback(
    async (
      kind: AgentPackageAddKind,
      files: AgentPackageFileInput[],
      choices: AgentPackageImportChoice[],
    ) => {
      if (!selectedAgentName) return;
      const detail = await commitAgentPackageImport({
        agentName: selectedAgentName,
        kind,
        files,
        choices,
      });
      applySelectedAgentDetail(detail);
    },
    [applySelectedAgentDetail, selectedAgentName],
  );

  const handleRemovePackageItem = useCallback(
    async (
      kind: AgentPackageAddKind,
      agentPath: string,
      mode: AgentPackageRemoveMode,
    ) => {
      if (!selectedAgentName) return;
      const detail = await removeAgentPackageItem({
        agentName: selectedAgentName,
        kind,
        agentPath,
        mode,
      });
      applySelectedAgentDetail(detail);
    },
    [applySelectedAgentDetail, selectedAgentName],
  );

  const emptyMessage = useMemo(() => {
    if (selectedAgentName) {
      return (
        `Editing **${formatDisplayName(selectedAgentName)}**. Tell me what to change — for ` +
        '"make it terser", "remove Tension Partners", "add a Red Lines item ' +
        "about X\" — and I'll rewrite the persona."
      );
    }
    return (
      "Hi — I can help you create any agent you need. Describe what it should do, " +
      "or pick skills on the right and click *Create agent from selected*. " +
      "You can also click an agent on the left to edit it on the right."
    );
  }, [selectedAgentName]);

  const chatPlaceholder = selectedAgentName
    ? "Refine the persona…"
    : "Describe the agent you want to create…";

  return (
    <>
      {!detailsOnly ? (
        <ChatWorkspace
          className="pt-2 lg:pt-2"
          style={{
            height: `calc(100dvh - ${HEADER_HEIGHT_REM + topOffsetRem}rem)`,
          }}
        >
          <div className="min-w-0 flex-1">
            <WorkflowGeneratorChat
              title="Agent Architect"
              botLabel="Agent Architect"
              emptyMessage={emptyMessage}
              inputPlaceholder={chatPlaceholder}
              history={history}
              submitting={submitting}
              stopping={stopping}
              error={chatError}
              onSubmit={handleSubmitChat}
              onStop={activeJobId ? handleStop : undefined}
              modelProvider={chatModel.provider}
              model={chatModel.model}
              onModelChange={setChatModel}
            />
          </div>
        </ChatWorkspace>
      ) : null}

      <WorkspaceRightSidebarContent active={detailsOpen && (!detailsOnly || Boolean(agentSelectionRequest))}>
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <PanelContent className="flex flex-col">
            <div className="hidden">
              <SkillsTreePicker
                path={skillsPath}
                onPathChange={setSkillsPath}
                selectedPaths={selectedSkillPaths}
                onToggle={handleToggleSkill}
                onCreate={handleCreate}
                creating={creating}
              />
            </div>

            <AgentPackageEditor
              agentName={selectedAgentName}
              agentDetail={selectedAgentDetail}
              personaMarkdown={persona}
              savedPersonaMarkdown={personaBaseline}
              onPersonaChange={handlePersonaChange}
              dirty={personaDirty}
              saving={savingPersona}
              saved={savedPersona}
              saveError={saveError}
              onSave={handleSavePersona}
              onRevealAsset={async (path) => {
                await revealAgentAsset({ path });
              }}
              onPreviewPackageImport={handlePreviewPackageImport}
              onCommitPackageImport={handleCommitPackageImport}
              onRemovePackageItem={handleRemovePackageItem}
              back={back}
              className="min-h-0 flex-1"
            />
          </PanelContent>
        </div>
      </WorkspaceRightSidebarContent>

      {!detailsOnly ? <AgentNameApprovalDialog
        open={pendingDraft !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDraft(null);
        }}
        suggestedName={pendingDraft?.suggestedName ?? ""}
        reservedNames={
          pendingDraft?.allowOverwrite
            ? withoutName(reservedNames, pendingDraft.overwriteTargetName)
            : reservedNames
        }
        onConfirm={(name) => void handleConfirmName(name)}
        confirming={creating}
      /> : null}

      {!detailsOnly ? <AgentDuplicateDialog
        open={duplicateMatch !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicateMatch(null);
        }}
        existingAgentName={duplicateMatch?.existingAgentName ?? ""}
        onOverwrite={handleDuplicateOverwrite}
        onDuplicate={handleDuplicateDuplicate}
      /> : null}
    </>
  );
}

function nextAvailableName(baseName: string, reservedNames: Set<string>): string {
  const base = baseName.trim();
  if (!reservedNames.has(base)) return base;

  let index = 2;
  let candidate = `${base}-${index}`;
  while (reservedNames.has(candidate)) {
    index += 1;
    candidate = `${base}-${index}`;
  }
  return candidate;
}

function withoutName(names: Set<string>, allowedName?: string): Set<string> {
  if (!allowedName) return names;
  return new Set(Array.from(names).filter((name) => name !== allowedName));
}
